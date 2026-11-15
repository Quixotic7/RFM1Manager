// SPDX-License-Identifier: GPL-3.0-only
// The author's own .rfm1: a firmware whose GitHub release carries an .rfm1 built from the commit the manager pins
// ships that file unchanged (renamed to <id>-<version>.rfm1 only) in place of the manager's build. It is checked
// as a build is (rfm1_check, the manifest rules with source_url at the pin, rfm1_run). RemoteFM1FW still hosts the
// copy: the site and the apps read RemoteFM1FW (GitHub's release downloads send no CORS header for the browser).
// The record (RFM1Manager/author-rfm1.json, the manager's own) names each file's release for the README.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { APP, cfg, run, verOf } from "./util.js";
import { readRfm1 } from "./rfm1.js";

const RECORD = () => join(APP, "author-rfm1.json");
export function readAuthorRecord() {
  try { return JSON.parse(readFileSync(RECORD(), "utf8")); } catch (_) { return {}; }
}
export function recordAuthorFile(file, entry) {
  const r = readAuthorRecord();
  if (entry) r[file] = entry; else delete r[file];
  writeFileSync(RECORD(), JSON.stringify(r, null, 1) + "\n");
}

const commitOf = (m) => (/@([0-9a-f]{7,40})$/.exec(m?.source_url || "") || [])[1] || null;
const samePin = (c, pin) => !!c && !!pin && (pin.startsWith(c) || c.startsWith(pin));

// a built_by that is not FM1VST's (fm1_add_rfm1) is the author's own toolchain
export const isAuthorBuild = (m) => !/^FM1VST \S+ \([0-9a-f]+\)/.test(m?.built_by || "");

// the newest release (draft releases never) whose .rfm1 asset's manifest names `pin`; tagHint's release is tried
// first. Assets are cached by their id in cache/author-rfm1/. null when none matches (the manager builds as before).
export async function findAuthorRfm1(job, slug, pin, { tagHint = null, maxDownloads = 6 } = {}) {
  if (!slug || !pin) return null;
  const r = await run("gh", ["api", `repos/${slug}/releases?per_page=30`]);
  if (r.code) { job.log(`author .rfm1: could not list ${slug}'s releases (${(r.err || "").trim().slice(0, 160)}): building`); return null; }
  let rels = JSON.parse(r.out).filter((x) => !x.draft && x.assets.some((a) => a.name.endsWith(".rfm1")));
  if (!rels.length) return null;
  rels.sort((a, b) => (b.tag_name === tagHint) - (a.tag_name === tagHint));
  const dir = join(cfg.cache, "author-rfm1", slug.replace("/", "__"));
  mkdirSync(dir, { recursive: true });
  let tried = 0;
  for (const rel of rels) {
    for (const a of rel.assets.filter((x) => x.name.endsWith(".rfm1"))) {
      if (tried++ >= maxDownloads) { job.log(`author .rfm1: no release asset of ${slug} at ${pin.slice(0, 12)} in the newest ${maxDownloads}: building`); return null; }
      const f = join(dir, `${a.id}-${a.name}`);
      if (!existsSync(f) || readFileSync(f).length !== a.size) {
        const d = await run("gh", ["release", "download", rel.tag_name, "-R", slug, "-p", a.name, "-O", f, "--clobber"], { log: job.log, commands: job.commands });
        if (d.code) { job.log(`author .rfm1: ${rel.tag_name}/${a.name} could not be downloaded`); continue; }
      }
      let info;
      try { info = readRfm1(f); } catch (e) { job.log(`author .rfm1: ${rel.tag_name}/${a.name}: ${e.message}`); continue; }
      const c = commitOf(info.manifest);
      // the source-commit rule is for the manager's own builds: an author's file counts as the release it is attached
      // to (the owner, 2026-11-15), so a file whose manifest names another commit (built before an amend) is the
      // pinned release's when that release's tag is the pin and the versions agree
      let viaTag = false;
      if (!samePin(c, pin)) {
        const t = await run("gh", ["api", `repos/${slug}/commits/${encodeURIComponent(rel.tag_name)}`, "-q", ".sha"]);
        viaTag = t.code === 0 && samePin(t.out.trim(), pin) && info.manifest.version === verOf(rel.tag_name);
        if (!viaTag) continue;
        job.log(`author .rfm1: warning: ${rel.tag_name}/${a.name} names commit ${c ? c.slice(0, 12) : "(none)"}, the tag is ${pin.slice(0, 12)}: taken as the release's file (author-built, the author's own test)`);
      }
      job.log(`author .rfm1: ${slug} ${rel.tag_name} ships ${a.name} (${info.manifest.id} ${info.manifest.version}, built_by ${info.manifest.built_by}) for the pin ${pin.slice(0, 12)}: used in place of a build`);
      return { path: f, asset: a.name, size: a.size, tag: rel.tag_name, url: rel.html_url, prerelease: !!rel.prerelease, download: a.browser_download_url, info, viaTag, manifestCommit: c };
    }
  }
  job.log(`author .rfm1: ${slug}'s release files are of other commits than the pin ${pin.slice(0, 12)}: building`);
  return null;
}

// out/ files of the same firmware (by manifest id, or the core's id when the author's id differs) other than keep
export function sameFirmwareInOut(ids, keep) {
  if (!existsSync(cfg.out)) return [];
  return readdirSync(cfg.out).filter((n) => n.endsWith(".rfm1") && n !== keep && ids.includes(n.replace(/\.rfm1$/, "").replace(/-.*$/, "")));
}
