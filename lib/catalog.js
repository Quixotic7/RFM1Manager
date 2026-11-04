// SPDX-License-Identifier: GPL-3.0-only
// The catalog: RemoteFM1FW's latest release (assets, SHA256SUMS, manifests), its README table, and FM1VST's glue
// (fm1_add_core / fm1_add_rfm1 entries, submodule URL and pinned commit) on the manager branch (or the base branch).
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cfg, run, runOk, git, isStableTag, cmpVer, verOf } from "./util.js";
import { readRfm1 } from "./rfm1.js";
import { hubCatalog, hubOffer, hubEntryFor, cleanHubVersion, chooseUpdate } from "./hub.js";
import { authorTarget, ownerPin, choosePick } from "./target.js";

// ---------- FM1VST glue ----------
export async function glueRef() {
  const r = await run("git", ["-C", cfg.fm1vst, "rev-parse", "--verify", "-q", `refs/heads/${cfg.branch}`]);
  return r.code === 0 ? cfg.branch : cfg.baseBranch;
}

function parseGitmodules(text) {
  const subs = {};
  let cur = null;
  for (const l of text.split("\n")) {
    const h = /^\[submodule "(.+)"\]/.exec(l);
    if (h) { cur = { name: h[1] }; continue; }
    const kv = /^\s*(\w+)\s*=\s*(.+?)\s*$/.exec(l);
    if (kv && cur) { cur[kv[1]] = kv[2]; if (kv[1] === "path") subs[kv[2]] = cur; }
  }
  return subs;
}

// split a cmake call's argument text into tokens (quoted strings kept whole)
function tokens(s) {
  const out = [];
  // a comment (#...) only outside quotes: a quoted VERSION_REGEX may hold "#define ..."
  const re = /"((?:[^"\\]|\\.)*)"|(#[^\n]*)|([^\s#]+)/g;
  let m;
  while ((m = re.exec(s))) if (m[2] === undefined) out.push(m[1] !== undefined ? m[1] : m[3]);
  return out;
}
function calls(text, name) {
  const res = [];
  const re = new RegExp(`^\\s*${name}\\s*\\(`, "gm");
  let m;
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length, depth = 1, inq = false;
    for (; i < text.length && depth; i++) {
      const c = text[i];
      if (c === '"' && text[i - 1] !== "\\") inq = !inq;
      else if (!inq && c === "#") { while (i < text.length && text[i] !== "\n") i++; }
      else if (!inq && c === "(") depth++;
      else if (!inq && c === ")") depth--;
    }
    res.push({ start: m.index, end: i, args: text.slice(m.index + m[0].length, i - 1) });
  }
  return res;
}
const KEYS_CORE = ["SOURCE", "UNIT", "DESC", "PREFIX", "VERSION", "VERSION_FILE", "VERSION_REGEX", "VERSION_GROUP", "GEN_ROOT",
  "GEN_PYTHON", "FAMILY", "LICENSE", "GATED", "CREDITS", "GEN", "EXTRA_GEN", "GEN_OUTPUTS", "PYTHON_NEEDS", "INCLUDES",
  "DEFINES", "FLAGS", "EXTRA_SOURCES", "CREDITS_FILES", "SUBMODULES", "SUBMODULES_RECURSIVE", "NO_GEN"];
const KEYS_RFM1 = ["AUTHORS", "MEMORY_MIB", "STACK_KIB", "LICENSE_FILES", "SOURCE_URL", "DEFINES", "FLAGS", "INCLUDES", "RUN_ARGS", "HOSTED_DESPITE_GATE", "VIRTUAL", "NEEDS", "FOLDERS"];
function kw(toks, keys) {
  const o = { _pos: [] };
  let k = "_pos";
  for (const t of toks) { if (keys.includes(t)) { k = t; o[k] = o[k] || []; } else (o[k] = o[k] || []).push(t); }
  return o;
}
export function parseGlue(text, file) {
  const vars = { CMAKE_SOURCE_DIR: "<root>", CMAKE_CURRENT_LIST_DIR: file.replace(/\/[^/]+$/, "") };
  for (const c of calls(text, "set")) {
    const t = tokens(c.args);
    if (t.length >= 2) vars[t[0]] = t.slice(1).join(" ");
  }
  const exp = (s) => String(s || "").replace(/\$\{(\w+)\}/g, (_, v) => vars[v] ?? `\${${v}}`).replace(/\$\{(\w+)\}/g, (_, v) => vars[v] ?? `\${${v}}`);
  const cores = [];
  for (const c of calls(text, "fm1_add_core")) {
    const a = kw(tokens(c.args), KEYS_CORE);
    const id = a._pos[0];
    const src = exp((a.SOURCE || [])[0] || "");
    const sm = /<root>\/(cores\/[^/\s]+)/.exec(src);
    cores.push({
      id, file, source: src.replace("<root>/", ""), submodule: sm ? sm[1] : null,
      version: a.VERSION ? exp(a.VERSION[0]) : null, versionFile: a.VERSION_FILE ? exp(a.VERSION_FILE[0]).replace("<root>/", "") : null,
      family: a.FAMILY ? a.FAMILY[0] : null, license: a.LICENSE ? a.LICENSE[0] : null,
      gated: a.GATED ? a.GATED.join(" ") : null, recursive: "SUBMODULES_RECURSIVE" in a,
      versionRegex: a.VERSION_REGEX ? a.VERSION_REGEX[0] : null, versionGroup: a.VERSION_GROUP ? Number(a.VERSION_GROUP[0]) : 1,
      pythonNeeds: a.PYTHON_NEEDS || [],
    });
  }
  for (const c of calls(text, "fm1_add_rfm1")) {
    const a = kw(tokens(c.args), KEYS_RFM1);
    const core = cores.find((x) => x.id === a._pos[0]);
    const r = { authors: a.AUTHORS || [], memoryMib: a.MEMORY_MIB ? Number(a.MEMORY_MIB[0]) : 8, hostedDespiteGate: a.HOSTED_DESPITE_GATE ? a.HOSTED_DESPITE_GATE.join(" ") : null, runArgs: a.RUN_ARGS || [],
      // a Fantasy CFW (FM1VST docs/VIRTUAL-CARTS.md): host-only, its host capabilities and folders
      virtual: "VIRTUAL" in a, needs: a.NEEDS || [], folders: a.FOLDERS || [] };
    if (core) core.rfm1 = r; else cores.push({ id: a._pos[0], file, rfm1: r, orphanRfm1: true });
  }
  return cores;
}

export async function scanGlue(ref) {
  ref = ref || (await glueRef());
  const files = (await git(cfg.fm1vst, ["ls-tree", "-r", "--name-only", ref, "core-glue"])).split("\n").filter((f) => f.endsWith(".cmake"));
  const gm = parseGitmodules(await git(cfg.fm1vst, ["show", `${ref}:.gitmodules`]));
  const pins = {};
  for (const l of (await git(cfg.fm1vst, ["ls-tree", ref, "cores/"])).split("\n")) {
    const m = /^160000 commit ([0-9a-f]{40})\t(.+)$/.exec(l);
    if (m) pins[m[2]] = m[1];
  }
  const out = {};
  for (const f of files) {
    const text = await git(cfg.fm1vst, ["show", `${ref}:${f}`]);
    if (!/fm1_add_core\s*\(|fm1_add_rfm1\s*\(/.test(text)) continue;
    for (const c of parseGlue(text, f)) {
      if (c.orphanRfm1 && out[c.id]) { out[c.id].rfm1 = c.rfm1; continue; }
      const sub = c.submodule ? gm[c.submodule] : null;
      out[c.id] = { ...out[c.id], ...c, url: sub ? sub.url : null, pin: c.submodule ? pins[c.submodule] || null : null };
    }
  }
  return { ref, cores: out };
}

// ---------- RemoteFM1FW release ----------
export async function latestRelease(force = false) {
  const cf = join(cfg.cache, "release.json");
  if (!force && existsSync(cf) && Date.now() - statSync(cf).mtimeMs < 10 * 60e3) return JSON.parse(readFileSync(cf, "utf8"));
  const j = JSON.parse(await runOk("gh", ["release", "view", "--repo", cfg.ghRepo, "--json", "tagName,name,publishedAt,url,body,assets"]));
  const rel = { tag: j.tagName, name: j.name, publishedAt: j.publishedAt, url: j.url, body: j.body,
    assets: j.assets.map((a) => ({ name: a.name, size: a.size, url: a.url })) };
  writeFileSync(cf, JSON.stringify(rel, null, 1));
  return rel;
}

// download the release's assets into cache/release/<tag>/ (once) and read each manifest
export async function syncRelease(rel, log) {
  const dir = join(cfg.cache, "release", rel.tag);
  mkdirSync(dir, { recursive: true });
  const missing = rel.assets.filter((a) => !existsSync(join(dir, a.name)) || statSync(join(dir, a.name)).size !== a.size);
  if (missing.length) await runOk("gh", ["release", "download", rel.tag, "--repo", cfg.ghRepo, "--dir", dir, "--clobber",
    ...missing.flatMap((a) => ["-p", a.name])], { log });
  return dir;
}

export function releaseManifests(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) if (n.endsWith(".rfm1")) {
    try { const i = readRfm1(join(dir, n)); out[i.manifest.id] = { file: n, ...i, credits: undefined }; }
    catch (e) { out[n] = { file: n, error: String(e.message) }; }
  }
  return out;
}

// ---------- README table ----------
export function parseReadmeTable(md) {
  const rows = {};
  for (const l of md.split("\n")) {
    const m = /^\|\s*`([^`]+\.rfm1)`\s*\|(.*)\|\s*$/.exec(l);
    if (!m) continue;
    const cells = m[2].split("|").map((s) => s.trim());
    const link = /\[([^\]]+)\]\((https:\/\/github\.com\/[^)]+?)(?:\/tree\/([0-9a-f]{7,40}))?\)/.exec(cells[3] || "");
    const id = m[1].replace(/\.rfm1$/, "").replace(/-.*$/, "");   // ids have no dash: the version may (1.1.5-rb)
    rows[id] = { file: m[1], firmware: cells[0], author: cells[1], license: cells[2], repo: link ? link[1] : null,
      repoUrl: link ? link[2] : null, commit: link ? link[3] : null, hosted: /†/.test(cells[0]), virtual: /‡/.test(cells[0]) };
  }
  return rows;
}

// ---------- upstream stable releases ----------
export function ghSlug(url) {
  const m = /github\.com[/:]([^/]+)\/([^/.\s]+?)(?:\.git)?\/?$/.exec(url || "");
  return m ? `${m[1]}/${m[2]}` : null;
}

const upCache = new Map();
export async function upstreamLatest(slug, force = false) {
  if (!slug) return { error: "no GitHub URL" };
  const hit = upCache.get(slug);
  if (!force && hit && Date.now() - hit.t < 15 * 60e3) return hit.v;
  let v = { slug };
  const rels = await run("gh", ["api", `repos/${slug}/releases?per_page=40`]);
  let stable = [];
  if (rels.code === 0) {
    stable = JSON.parse(rels.out).filter((r) => !r.draft && !r.prerelease && isStableTag(r.tag_name)).map((r) => ({ tag: r.tag_name, date: r.published_at, url: r.html_url, source: "release" }));
  }
  if (!stable.length) {
    const tags = await run("gh", ["api", `repos/${slug}/tags?per_page=100`]);
    if (tags.code === 0) stable = JSON.parse(tags.out).filter((t) => isStableTag(t.name)).map((t) => ({ tag: t.name, sha: t.commit.sha, source: "tag" }));
  }
  stable.sort((a, b) => cmpVer(b.tag, a.tag));
  if (stable.length) {
    const s = stable[0];
    v = { ...v, ...s, version: verOf(s.tag) };
    if (!v.sha) {
      const c = await run("gh", ["api", `repos/${slug}/commits/${encodeURIComponent(s.tag)}`, "-q", ".sha"]);
      if (c.code === 0) v.sha = c.out.trim();
    }
  } else v.error = rels.code === 0 ? "no stable release or tag" : `gh api: ${(rels.err || "").trim().slice(0, 200)}`;
  upCache.set(slug, { t: Date.now(), v });
  return v;
}

// the hub entry's verdict without the GitHub calls when it cannot be an update (beta, unclean, not newer)
function hubEntryCheap(hub, id, slug, cur) {
  if (!hub) return null;
  const e = hubEntryFor(hub, id, slug);
  if (!e) return { ok: false, reason: "not on the hub" };
  const v = cleanHubVersion(e.version);
  if (e.beta || !v || (cur && cmpVer(v, cur) <= 0)) return { ok: false, hubId: e.id, raw: e.version, source: e.source, version: v,
    reason: e.beta ? `beta on the hub (${e.version})` : !v ? `version "${e.version}" is not a plain stable number` : `hub ${e.version}: not newer than ${cur}` };
  return { ok: true };
}

// ---------- the merged view ----------
export async function catalog({ upstream = false, force = false, log } = {}) {
  const [glue, rel] = await Promise.all([scanGlue(), latestRelease(force)]);
  const dir = await syncRelease(rel, log);
  const manifests = releaseManifests(dir);
  const readme = existsSync(join(cfg.fwRepo, "README.md")) ? parseReadmeTable(readFileSync(join(cfg.fwRepo, "README.md"), "utf8")) : {};
  const hub = upstream ? await hubCatalog(force) : null;
  const ids = new Set([...Object.keys(manifests), ...Object.keys(readme), ...Object.values(glue.cores).filter((c) => c.rfm1).map((c) => c.id)]);
  const list = [];
  for (const id of [...ids].sort()) {
    const g = glue.cores[id] || {}, m = manifests[id] || {}, r = readme[id] || {};
    const e = {
      id, inRelease: !!m.file, releaseFile: m.file || null, sha256: m.sha256 || null, size: m.size || null,
      name: m.manifest?.name || r.firmware || id, version: m.manifest?.version || null,
      license: m.manifest?.license || g.license || null, authors: m.manifest?.authors || g.rfm1?.authors || [],
      sourceUrl: m.manifest?.source_url || null, builtBy: m.manifest?.built_by || null, glueUrl: m.manifest?.glue_url || null,
      releaseCommit: (/@([0-9a-f]+)$/.exec(m.manifest?.source_url || "") || [])[1] || null,
      readme: r.file ? r : null,
      glue: g.id ? { file: g.file, family: g.family, version: g.version, versionFile: g.versionFile, submodule: g.submodule,
        url: g.url, pin: g.pin, gated: g.gated, rfm1: g.rfm1 || null, recursive: g.recursive } : null,
      repo: ghSlug(g.url) || (r.repo || null), hostedDespiteGate: g.rfm1?.hostedDespiteGate || null,
      virtual: !!(m.manifest?.virtual ?? g.rfm1?.virtual),
    };
    if (upstream && e.repo) {
      const u = await upstreamLatest(e.repo, force);
      e.upstream = u;
      // the firmware hub's non-beta release (README "Firmware hub"); checked against GitHub only when it is newer
      const cur = e.glue?.version || e.version;
      const h = hubEntryCheap(hub, id, e.repo, cur);
      e.hub = h && h.ok !== false ? await hubOffer(hub, id, e.repo) : h;
      // the author's target and the owner's pin first (lib/target.js); "author's target: X" in the update check
      const normal = e.glue?.pin && cur ? chooseUpdate(u, e.hub, cur, e.glue.pin, cmpVer) : null;
      const [at, op] = await Promise.all([authorTarget(e.repo, force), ownerPin(id, e.repo)]);
      const pick = e.glue?.pin ? choosePick({ normal, author: at, owner: op, cur, pin: e.glue.pin, slug: e.repo, cmpVer }) : { up: normal, warnings: [], authorTarget: null };
      e.authorTarget = pick.authorTarget; e.pickWhy = pick.why || null; e.pickWarnings = pick.warnings; e.ownerPin = op ? { tag: op.tag || null, ignoreTarget: !!op.ignoreTarget, allowDowngrade: !!op.allowDowngrade } : null;
      const up = pick.up;
      e.update = up ? { source: up.source, tag: up.tag, sha: up.sha, version: up.version, hubVersion: up.hubVersion || null } : null;
      e.updateAvailable = !!up;
      e.pinMatchesStable = !!(u.sha && e.glue?.pin === u.sha) || !!(e.hub?.ok && e.hub.sha === e.glue?.pin);
    }
    list.push(e);
  }
  return { glueRef: glue.ref, hub: hub ? { from: hub.from, url: hub.url, updated: hub.updated, stale: !!hub.stale, errors: hub.errors || [] } : null, release: { tag: rel.tag, url: rel.url, publishedAt: rel.publishedAt, assets: rel.assets.length }, firmwares: list };
}
