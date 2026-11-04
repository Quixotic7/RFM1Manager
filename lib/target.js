// SPDX-License-Identifier: GPL-3.0-only
// Which release to build. The manager's own pick (newest stable GitHub release / tag, or the Firmware Hub's non-beta
// release: hub.js chooseUpdate) gives way to the author's `target` (RemoteFM1Metadata.json at the tip of the default
// branch: the one field read there, since it decides the commit), and both give way to the owner's pin (pins.json).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP, run, verOf } from "./util.js";
import { META_FILE } from "./authormeta.js";

const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._+\-/]{0,99}$/;
const cache = new Map();

// a tag of the repository -> { tag, sha } | null (a tag only: never a branch of the same name)
export async function resolveTag(slug, name) {
  const tries = [name];
  if (!/^v/i.test(name)) tries.push(`v${name}`);
  for (const t of tries) {
    const r = await run("gh", ["api", `repos/${slug}/commits/${encodeURIComponent(`refs/tags/${t}`).replace(/%2F/g, "/")}`, "-q", ".sha"]);
    const sha = r.code === 0 ? r.out.trim() : "";
    if (/^[0-9a-f]{40}$/.test(sha)) return { tag: t, sha };
  }
  return null;
}

// the author's target: { found: false } | { found: true, target, tag?, sha?, version?, error? }
export async function authorTarget(slug, force = false) {
  if (!slug) return { found: false };
  const hit = cache.get(slug);
  if (!force && hit && Date.now() - hit.t < 15 * 60e3) return hit.v;
  let v = { found: false };
  // no ref: the default branch's tip
  const r = await run("gh", ["api", "-H", "Accept: application/vnd.github.raw", `repos/${slug}/contents/${META_FILE}`]);
  if (r.code === 0) {
    let j = null;
    try { j = JSON.parse(r.out); } catch (_) { v = { found: true, error: `${META_FILE} on the default branch is not valid JSON: no target` }; }
    if (j && typeof j === "object" && "target" in j) {
      const t = j.target;
      if (typeof t !== "string" || !TARGET_RE.test(t)) v = { found: true, target: String(t), error: `target ${JSON.stringify(t)} is not a tag name: ignored` };
      else {
        const tag = await resolveTag(slug, t);
        v = tag ? { found: true, target: t, ...tag, version: verOf(tag.tag) } : { found: true, target: t, error: `target ${t}: no such tag in ${slug}: ignored` };
      }
    }
  }
  cache.set(slug, { t: Date.now(), v });
  return v;
}

// the owner's pins (RFM1Manager/pins.json, the manager's own: never in a repository)
//   { "<id>": { "tag": "v1.2" } }            build that tag (wins over everything; a downgrade too)
//   { "<id>": { "ignoreTarget": true } }     the manager's own pick, whatever the author's target says
//   { "<id>": { "allowDowngrade": true } }   the author's target even when it is older than the current version
const PINS = () => join(APP, "pins.json");
export const readPins = () => (existsSync(PINS()) ? JSON.parse(readFileSync(PINS(), "utf8")) : {});
export function setPin(id, pin) {
  const p = readPins();
  const clean = {};
  if (pin && typeof pin.tag === "string" && TARGET_RE.test(pin.tag)) clean.tag = pin.tag;
  if (pin?.ignoreTarget) clean.ignoreTarget = true;
  if (pin?.allowDowngrade) clean.allowDowngrade = true;
  if (Object.keys(clean).length) p[id] = clean; else delete p[id];
  writeFileSync(PINS(), JSON.stringify(Object.fromEntries(Object.entries(p).sort()), null, 1) + "\n");
  return p[id] || null;
}

// The choice. normal: chooseUpdate's result (null: nothing newer); author: authorTarget's; owner: the pin entry, with
// owner.resolved = { tag, sha } (or owner.error) when it names a tag; cur: the version pinned / published.
// -> { up (null: nothing to build), why, warnings: [], authorTarget: label | null }
export function choosePick({ normal, author, owner, cur, pin, slug, cmpVer }) {
  const warnings = [];
  const label = author?.found && author.target ? author.target : null;
  if (owner?.tag) {
    if (owner.resolved) {
      const up = owner.resolved.sha === pin ? null : { slug, tag: owner.resolved.tag, sha: owner.resolved.sha, version: verOf(owner.resolved.tag), source: "owner" };
      if (label && label !== owner.tag) warnings.push(`the owner's pin ${owner.tag} wins over the author's target ${label}`);
      return { up, why: up ? `the owner's pin ${owner.tag}` : `at the owner's pin ${owner.tag}`, warnings, authorTarget: label };
    }
    warnings.push(`the owner's pin ${owner.tag}: ${owner.error || "no such tag"}: not used`);
  }
  if (author?.found && author.error) warnings.push(`author's target: ${author.error}`);
  if (author?.found && author.sha && !owner?.ignoreTarget) {
    if (cur && cmpVer(author.version, cur) < 0 && !owner?.allowDowngrade) {
      warnings.push(`the author's target ${author.target} (${author.version}) is older than ${cur}: a downgrade, not done without the owner's allowDowngrade: the manager's own pick instead`);
    } else {
      const up = author.sha === pin ? null : { slug, tag: author.tag, sha: author.sha, version: author.version, source: "target" };
      return { up, why: up ? `the author's target ${author.target}` : `at the author's target ${author.target}`, warnings, authorTarget: label };
    }
  } else if (author?.sha && owner?.ignoreTarget) warnings.push(`the author's target ${author.target} is ignored (the owner's ignoreTarget)`);
  return { up: normal || null, why: normal ? "the manager's pick" : "no newer release", warnings, authorTarget: label };
}

// owner's pin entry with its tag resolved
export async function ownerPin(id, slug) {
  const o = readPins()[id];
  if (!o) return null;
  if (o.tag) { const r = await resolveTag(slug, o.tag); return r ? { ...o, resolved: r } : { ...o, error: `no tag ${o.tag} in ${slug}` }; }
  return o;
}
