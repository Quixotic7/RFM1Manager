// SPDX-License-Identifier: GPL-3.0-only
// Stage a release (every .rfm1 + SHA256SUMS + notes) into staging/<tag>/, preview it, and publish it only on an
// explicit, typed confirmation (or dry-run: everything checked, the commands shown, nothing pushed or created).
// A publish updates the rolling release `current` (the full set, always Latest) in place and creates a dated release
// with only the added and updated files (README "7. Publish").
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { cfg, run, moveAside, shq, cmpVer } from "./util.js";
import { latestRelease, syncRelease, scanGlue } from "./catalog.js";
import { readRfm1, manifestProblems } from "./rfm1.js";
import { readReadme, refreshReadme } from "./readme.js";
import { syncVirtual } from "./meta.js";

const NAME_RE = /^[a-z0-9_]{1,31}-[A-Za-z0-9._+-]+\.rfm1$/;
// owner rule: never ship raw preset/sysex sources (compiled into the wasm is fine)
const FORBIDDEN_RE = /\.(syx|sysex|mid|midi|json|bin|wav|aif|aiff|txt|zip|tar|gz|c|h|py)$/i;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function collectFiles({ exclude = [] } = {}) {
  const rel = await latestRelease();
  const dir = await syncRelease(rel);
  const byId = new Map();
  const add = (path, origin) => {
    const name = path.split("/").pop();
    let info;
    try { info = readRfm1(path); } catch (e) { byId.set(`bad:${name}`, { file: name, path, origin, error: e.message }); return; }
    const id = info.manifest.id;
    const prev = byId.get(id);
    if (prev && origin === "release") return;
    if (prev && prev.origin === "built" && statSync(prev.path).mtimeMs > statSync(path).mtimeMs) return;
    // a build older than the release's file (the nightly author sync may have moved it on) never replaces it
    if (prev && prev.origin === "release" && origin === "built" && cmpVer(info.manifest.version, prev.manifest.version) < 0) return;
    byId.set(id, { id, file: name, path, origin, manifest: info.manifest, sha256: info.sha256, size: info.size, licenses: info.licenses });
  };
  for (const n of readdirSync(dir)) if (n.endsWith(".rfm1")) add(join(dir, n), "release");
  if (existsSync(cfg.out)) for (const n of readdirSync(cfg.out)) if (n.endsWith(".rfm1")) add(join(cfg.out, n), "built");
  // everything else in out/ is refused when staged (shown in the preview's problems)
  const stray = existsSync(cfg.out) ? readdirSync(cfg.out).filter((n) => !n.endsWith(".rfm1") && !n.startsWith(".")) : [];
  return { rel, files: [...byId.values()].filter((f) => !exclude.includes(f.id)), stray };
}

// ---------- the rolling release ----------
// `current` (always Latest) holds the full set: every current .rfm1 + SHA256SUMS, updated in place by each publish
// (what the apps' and the site's releases/latest read). Each publish also gets a dated release (its tag, never Latest)
// with only the files it added or updated + their SHA256SUMS: the history the apps' "older versions" page reads.
export const ROLLING = "current";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const fileSha = (p) => sha256(readFileSync(p));

function releaseNotes(tag, files, dated, prevName, prevSums) {
  const what = dated.length ? `the ${dated.length} file${dated.length === 1 ? "" : "s"} this publish added or updated; SHA256SUMS lists their SHA-256`
    : "nothing added or updated (no files)";
  const lines = [`RemoteFM1 firmware files (.rfm1), ${tag}: ${what}. The full set (${files.length} files) is the release \`${ROLLING}\` (always Latest).`, ""];
  const added = [], changed = [];
  for (const f of files) {
    const old = [...prevSums.entries()].find(([n]) => n.replace(/\.rfm1$/, "").replace(/-.*$/, "") === f.id);
    if (!old) added.push(f); else if (old[1] !== f.sha256) changed.push({ f, was: old[0] });
  }
  const removed = [...prevSums.keys()].filter((n) => n.endsWith(".rfm1") && !files.some((f) => f.id === n.replace(/\.rfm1$/, "").replace(/-.*$/, "")));
  if (added.length) lines.push("**Added:** " + added.map((f) => `\`${f.file}\` (${f.manifest.name} ${f.manifest.version})`).join(", "));
  if (changed.length) lines.push("**Updated:** " + changed.map(({ f, was }) => `\`${f.file}\` (was \`${was}\`)`).join(", "));
  if (removed.length) lines.push("**Removed:** " + removed.map((n) => `\`${n}\``).join(", "));
  if (added.length || changed.length || removed.length) lines.push("");
  lines.push(`Compared with ${prevName}. Each file's licence texts, credits and its exact source (source_url at its commit) are inside it; README.md lists them with the FM1VST commit that built each one, or the author's release for a file the author built.`);
  return lines.join("\n") + "\n";
}

// `current`'s notes: the dated release's, and what `current` is
export function currentNotes(tag, notes, n) {
  return `${notes.replace(/\s+$/, "")}\n\n---\n\`${ROLLING}\` always holds the full set: every current .rfm1 file and SHA256SUMS (${n} files), updated in place by each publish. This is ${tag}: the dated release ${tag} holds only the files it added or updated, older dated releases hold the older versions.\n`;
}

function parseSums(t) {
  const m = new Map();
  for (const l of String(t).split("\n")) { const r = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(l.trim()); if (r) m.set(r[2], r[1]); }
  return m;
}
export const sumsText = (files) => [...files].sort((a, b) => a.file.localeCompare(b.file)).map((f) => `${f.sha256}  ${f.file}\n`).join("");

// the dated release's files: the staged ones that are new or changed against the previous full set (by name + SHA-256)
export function datedFiles(files, prevSums) {
  return files.filter((f) => prevSums.get(f.file) !== f.sha256).map((f) => f.file).sort();
}

const digestSha = (a) => (a?.digest && a.digest.startsWith("sha256:") ? a.digest.slice(7).toLowerCase() : null);

// what `current` needs to become the staged full set: uploads (new or changed), its SHA256SUMS, deletions (every asset
// that is not in the set). An asset without a digest is taken at its line in `current`'s own SHA256SUMS.
export function planCurrent({ files, assets = [], liveSums = new Map(), liveSumsText = null, sums }) {
  const byName = new Map(assets.map((a) => [a.name, a]));
  const want = new Set(files.map((f) => f.file));
  const shaOf = (n) => { const a = byName.get(n); return a ? digestSha(a) || liveSums.get(n) || null : null; };
  const upload = files.filter((f) => shaOf(f.file) !== f.sha256).map((f) => f.file).sort();
  const s = byName.get("SHA256SUMS");
  const sumsChanged = !s || (digestSha(s) ? digestSha(s) !== sha256(sums) : liveSumsText !== sums);
  const remove = assets.map((a) => a.name).filter((n) => n !== "SHA256SUMS" && !want.has(n)).sort();
  return { upload, sumsChanged, remove, same: !upload.length && !sumsChanged && !remove.length };
}

// the gh steps that bring `current` to a plan, ordered so readers see the least: new and changed files first (until
// SHA256SUMS follows, only those files are unlisted), then SHA256SUMS, then the stale files; then the check
export function currentSteps({ repo, dir, plan }) {
  const s = [];
  if (plan.upload.length) s.push({ cmd: "gh", args: ["release", "upload", ROLLING, "--repo", repo, "--clobber", ...plan.upload.map((f) => join(dir, f))], timeoutMs: 30 * 60e3 });
  if (plan.sumsChanged) s.push({ cmd: "gh", args: ["release", "upload", ROLLING, "--repo", repo, "--clobber", join(dir, "SHA256SUMS")] });
  for (const n of plan.remove) s.push({ cmd: "gh", args: ["release", "delete-asset", ROLLING, n, "--repo", repo, "--yes"] });
  s.push({ check: "assets" });
  return s;
}

// a publish's release steps: `current` brought up to date and checked, the dated release (not Latest), `current`'s
// title + notes naming it and marked Latest, checked
export function publishSteps({ tag, repo, dir, branch, plan, dated, datedExists = false }) {
  const s = currentSteps({ repo, dir, plan });
  if (!datedExists) s.push({ cmd: "gh", args: ["release", "create", tag, "--repo", repo, "--title", tag, "--notes-file", join(dir, "RELEASE-NOTES.md"),
    "--target", branch, "--latest=false", ...dated.map((f) => join(dir, f)), ...(dated.length ? [join(dir, "dated", "SHA256SUMS")] : [])], timeoutMs: 30 * 60e3 });
  s.push({ cmd: "gh", args: ["release", "edit", ROLLING, "--repo", repo, "--title", tag, "--notes-file", join(dir, "CURRENT-NOTES.md"), "--latest"] });
  s.push({ check: "latest" });
  return s;
}

export const stepText = (s) => s.check === "assets" ? `(check) every asset of ${ROLLING} matches its SHA256SUMS: the same .rfm1 names, each SHA-256 digest equal`
  : s.check === "latest" ? `(check) the Latest release is ${ROLLING}` : [s.cmd, ...s.args].map(shq).join(" ");

// `current`'s assets against a SHA256SUMS: the same .rfm1 names, each digest equal, nothing else (pure)
export function assetProblems(assets, sums, sumsSha) {
  const p = [];
  const byName = new Map(assets.map((a) => [a.name, a]));
  for (const [n, h] of sums) {
    const a = byName.get(n);
    if (!a) p.push(`${n}: in SHA256SUMS, not in ${ROLLING}`);
    else if (digestSha(a) && digestSha(a) !== h) p.push(`${n}: digest ${digestSha(a)}, SHA256SUMS says ${h}`);
  }
  for (const a of assets) {
    if (a.name === "SHA256SUMS") { if (digestSha(a) && digestSha(a) !== sumsSha) p.push("SHA256SUMS: not the one uploaded"); }
    else if (!sums.has(a.name)) p.push(`${a.name}: in ${ROLLING}, not in SHA256SUMS`);
  }
  if (!byName.has("SHA256SUMS")) p.push(`${ROLLING} has no SHA256SUMS`);
  return p;
}

async function ok(exec, cmd, args, opts = {}) {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")}: exit ${r.code}: ${(r.err || r.out).trim().slice(-2000)}`);
  return r.out;
}

async function downloadAsset(exec, repo, tag, name) {
  const d = join(cfg.scratch, `dl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  await ok(exec, "gh", ["release", "download", tag, "--repo", repo, "--dir", d, "-p", name]);
  return readFileSync(join(d, name));
}

// `current` as it is now on GitHub (read only): its assets with digests and its SHA256SUMS text
export async function liveCurrent(exec, repo) {
  const r = await exec("gh", ["release", "view", ROLLING, "--repo", repo, "--json", "name,isDraft,assets"]);
  if (r.code !== 0) {
    if (/not found/i.test(`${r.err}${r.out}`)) return { exists: false, assets: [], sumsText: null };
    throw new Error(`gh release view ${ROLLING}: ${(r.err || r.out).trim()}`);
  }
  const j = JSON.parse(r.out);
  const assets = j.assets.map((a) => ({ name: a.name, size: a.size, digest: a.digest || null }));
  const sumsText = assets.some((a) => a.name === "SHA256SUMS") ? (await downloadAsset(exec, repo, ROLLING, "SHA256SUMS")).toString("utf8") : null;
  return { exists: true, name: j.name, draft: !!j.isDraft, assets, sumsText };
}

async function latestTag(exec, repo) {
  const r = await exec("gh", ["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"]);
  return r.code === 0 ? r.out.trim() : null;
}

// the checks: every asset against SHA256SUMS (an asset without a digest is downloaded and hashed); Latest is `current`
async function checkAssets(exec, repo, sumsTxt, log) {
  const j = JSON.parse(await ok(exec, "gh", ["release", "view", ROLLING, "--repo", repo, "--json", "assets"]));
  const assets = j.assets.map((a) => ({ name: a.name, size: a.size, digest: a.digest || null }));
  const sums = parseSums(sumsTxt);
  const p = assetProblems(assets, sums, sha256(sumsTxt));
  for (const a of assets) if (!digestSha(a) && (sums.has(a.name) || a.name === "SHA256SUMS")) {
    const h = sha256(await downloadAsset(exec, repo, ROLLING, a.name));
    if (h !== (a.name === "SHA256SUMS" ? sha256(sumsTxt) : sums.get(a.name))) p.push(`${a.name}: downloaded SHA-256 ${h} does not match`);
  }
  if (p.length) throw new Error(`${ROLLING} does not match its SHA256SUMS: ${p.join("; ")}`);
  log?.(`ok: ${ROLLING} has ${sums.size} .rfm1 files + SHA256SUMS, every one matching`);
}

async function runSteps(steps, { exec, log, repo, sumsTxt }) {
  for (const s of steps) {
    if (s.check === "assets") await checkAssets(exec, repo, sumsTxt, log);
    else if (s.check === "latest") {
      const t = await latestTag(exec, repo);
      if (t !== ROLLING) throw new Error(`the Latest release is ${t}, not ${ROLLING}`);
      log?.(`ok: the Latest release is ${ROLLING}`);
    } else await ok(exec, s.cmd, s.args, { log, timeoutMs: s.timeoutMs });
  }
}

// the cached latest release (lib/catalog.js, 10 minutes) is stale after a change to `current`
function staleReleaseCache() {
  const cf = join(cfg.cache, "release.json");
  if (existsSync(cf)) utimesSync(cf, new Date(0), new Date(0));
}

export async function stage({ tag, notes, exclude = [] }) {
  if (!TAG_RE.test(tag || "") || tag === ROLLING) throw new Error(`bad tag "${tag}"${tag === ROLLING ? ` (${ROLLING} is the rolling release: give the dated tag)` : ""}`);
  const { rel, files, stray } = await collectFiles({ exclude });
  const glue = await scanGlue();
  const dir = join(cfg.staging, tag);
  const moved = moveAside(dir);
  mkdirSync(dir, { recursive: true });
  const problems = [];
  for (const s of stray) problems.push(`out/${s}: not an .rfm1 (refused)`);
  const prevDir = join(cfg.cache, "release", rel.tag);
  const prevSumsText = existsSync(join(prevDir, "SHA256SUMS")) ? readFileSync(join(prevDir, "SHA256SUMS"), "utf8") : null;
  const prevSums = prevSumsText !== null ? parseSums(prevSumsText) : new Map();
  const prevName = rel.name || rel.tag;
  const ok = [];
  const pushed = new Map();
  for (const f of files) {
    if (f.error) { problems.push(`${f.file}: ${f.error}`); continue; }
    if (!NAME_RE.test(f.file) || FORBIDDEN_RE.test(f.file)) { problems.push(`${f.file}: refused (only <id>-<version>.rfm1 files are released; no raw .syx/preset sources)`); continue; }
    if (f.file !== `${f.manifest.id}-${f.manifest.version}.rfm1`) problems.push(`${f.file}: name does not match its manifest (${f.manifest.id}-${f.manifest.version}.rfm1)`);
    const g = glue.cores[f.id];
    for (const p of manifestProblems({ manifest: f.manifest, licenses: f.licenses }, null)) problems.push(`${f.file}: ${p}`);
    if (g?.gated && !g.rfm1?.hostedDespiteGate) problems.push(`${f.file}: its core is GATED without HOSTED_DESPITE_GATE`);
    // GPL: the glue commit named in built_by must be public (on FM1VST's remote), or the file's source is incomplete
    const bc = (/FM1VST \S+ \(([0-9a-f]+)\)/.exec(f.manifest.built_by || "") || [])[1];
    if (f.origin === "built" && bc) {
      if (!pushed.has(bc)) pushed.set(bc, (await run("git", ["-C", cfg.fm1vst, "branch", "-r", "--contains", bc])).out.trim() !== "");
      if (!pushed.get(bc)) problems.push(`${f.file}: built from FM1VST ${bc}, which is not on FM1VST's remote yet (push the glue first: its glue_url must be public)`);
    }
    copyFileSync(f.path, join(dir, f.file));
    ok.push({ ...f, hostedDespiteGate: g?.rfm1?.hostedDespiteGate || null });
  }
  // catalog.json's virtual flag follows the manifests (a Fantasy CFW), so the catalog committed with the release says it
  syncVirtual(ok);
  // the folder must hold nothing but .rfm1 + SHA256SUMS + notes (refuse anything else, raw .syx above all)
  for (const n of readdirSync(dir)) if (!n.endsWith(".rfm1")) problems.push(`${n}: unexpected file in staging (refused)`);
  ok.sort((a, b) => a.file.localeCompare(b.file));
  const sums = sumsText(ok);
  writeFileSync(join(dir, "SHA256SUMS"), sums);
  // the dated release: only the new and changed files, with their own SHA256SUMS (dated/SHA256SUMS)
  const dated = datedFiles(ok, prevSums);
  if (dated.length) {
    mkdirSync(join(dir, "dated"), { recursive: true });
    writeFileSync(join(dir, "dated", "SHA256SUMS"), sumsText(ok.filter((f) => dated.includes(f.file))));
  }
  const removed = [...prevSums.keys()].filter((n) => n.endsWith(".rfm1") && !ok.some((f) => f.file === n)).sort();
  const relNotes = notes && notes.trim() ? notes : releaseNotes(tag, ok, dated, prevName, prevSums);
  writeFileSync(join(dir, "RELEASE-NOTES.md"), relNotes);
  writeFileSync(join(dir, "CURRENT-NOTES.md"), currentNotes(tag, relNotes, ok.length));
  const readme = await refreshReadme(readReadme(), ok);
  writeFileSync(join(dir, "README.preview.md"), readme);
  const tagExists = (await run("gh", ["release", "view", tag, "--repo", cfg.ghRepo, "--json", "tagName"])).code === 0;
  if (tagExists) problems.push(`release ${tag} already exists on ${cfg.ghRepo}`);
  const preview = {
    tag, repo: cfg.ghRepo, dir, previous: rel.tag === ROLLING ? `${ROLLING} (${prevName})` : rel.tag, created: new Date().toISOString(), movedAside: moved,
    files: ok.map((f) => ({ file: f.file, id: f.id, size: f.size, sha256: f.sha256, origin: f.origin, version: f.manifest.version,
      license: f.manifest.license, source_url: f.manifest.source_url, built_by: f.manifest.built_by, licenses: f.licenses.length,
      hosted: !!f.hostedDespiteGate, virtual: f.manifest.virtual === true, changed: prevSums.get(f.file) !== f.sha256 })),
    sums, notes: relNotes, readmeChanged: readme !== readReadme(), problems,
    // the rolling release: what the dated release gets, what leaves `current`, and the SHA256SUMS staged against
    dated, removed, previousSumsSha: prevSumsText !== null ? sha256(prevSumsText) : null,
  };
  writeFileSync(join(dir, "..", `${tag}.preview.json`), JSON.stringify(preview, null, 1));
  return preview;
}

export function readPreview(tag) {
  const p = join(cfg.staging, `${tag}.preview.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

// the publish: dryRun (default) checks and lists; a real one needs confirm === tag, typed in the UI.
// exec runs every git / gh command (lib/util.js run; the tests stub it)
export async function publish({ tag, confirm, dryRun = true, log, exec = run }) {
  const pv = readPreview(tag);
  if (!pv) throw new Error(`stage ${tag} first`);
  const dir = pv.dir;
  const repo = cfg.ghRepo;
  const files = readdirSync(dir).filter((n) => n.endsWith(".rfm1")).sort();
  const plan = [];
  const fw = cfg.fwRepo;
  // re-check what is on disk now against the preview (nothing swapped since)
  const sumsTxt = readFileSync(join(dir, "SHA256SUMS"), "utf8");
  const sums = parseSums(sumsTxt);
  const problems = [...pv.problems];
  if (tag === ROLLING) problems.push(`${ROLLING} is the rolling release: publish under a dated tag`);
  for (const n of readdirSync(dir)) if (!/\.rfm1$|^SHA256SUMS$|^RELEASE-NOTES\.md$|^CURRENT-NOTES\.md$|^README\.preview\.md$|^dated$/.test(n)) problems.push(`${n}: unexpected file in staging (refused)`);
  for (const n of files) { const i = readRfm1(join(dir, n)); if (sums.get(n) !== i.sha256) problems.push(`${n}: changed since the preview`); }
  if (files.length !== pv.files.length) problems.push("the staged file list changed since the preview");
  const dated = Array.isArray(pv.dated) ? pv.dated : [];
  if (!Array.isArray(pv.dated) || !existsSync(join(dir, "CURRENT-NOTES.md"))) problems.push("staged before the rolling release: stage again");
  if (dated.length) {
    const ds = existsSync(join(dir, "dated", "SHA256SUMS")) ? parseSums(readFileSync(join(dir, "dated", "SHA256SUMS"), "utf8")) : new Map();
    if (ds.size !== dated.length || dated.some((n) => !files.includes(n) || ds.get(n) !== sums.get(n))) problems.push("dated/SHA256SUMS does not list the dated files as staged");
  }
  if (existsSync(join(dir, "dated"))) for (const n of readdirSync(join(dir, "dated"))) if (n !== "SHA256SUMS") problems.push(`dated/${n}: unexpected file in staging (refused)`);
  const status = (await exec("git", ["-C", fw, "status", "--porcelain"])).out.trim();
  const branch = (await exec("git", ["-C", fw, "branch", "--show-current"])).out.trim();
  // `current` as it is now (read only, in a dry run too)
  const live = await liveCurrent(exec, repo);
  if (!live.exists) problems.push(`no release "${ROLLING}" on ${repo} yet: run the switch-over first (POST /api/release/init-current)`);
  else if (live.sumsText !== sumsTxt && sha256(live.sumsText ?? "") !== pv.previousSumsSha) problems.push(`${ROLLING} changed since this stage (another publish?): stage again`);
  // (the dated tag exists only after an earlier try of this publish failed later on: stage refuses an existing tag)
  const datedExists = (await exec("gh", ["release", "view", tag, "--repo", repo, "--json", "tagName"])).code === 0;
  const cur = planCurrent({ files: files.map((n) => ({ file: n, sha256: sums.get(n) })), assets: live.assets,
    liveSums: parseSums(live.sumsText || ""), liveSumsText: live.sumsText, sums: sumsTxt });
  const steps = publishSteps({ tag, repo, dir, branch, plan: cur, dated, datedExists });
  plan.push(`cp ${join(dir, "README.preview.md")} ${join(fw, "README.md")}`);
  plan.push(`git -C ${fw} add README.md catalog docs`);
  plan.push(`git -C ${fw} commit -m "Release ${tag}"`);
  plan.push(`git -C ${fw} push origin ${branch}`);
  if (datedExists) plan.push(`(release ${tag} exists already, from an earlier try of this publish: not created again)`);
  for (const s of steps) plan.push(stepText(s));
  const out = { tag, dryRun, plan, problems, fwRepoBranch: branch, fwRepoStatus: status, files: files.length,
    dated, current: { upload: cur.upload, sumsChanged: cur.sumsChanged, remove: cur.remove } };
  if (dryRun) { for (const p of plan) log?.(`(dry run) ${p}`); return out; }
  if (confirm !== tag) throw new Error(`confirmation "${confirm}" does not match the tag "${tag}"`);
  if (problems.length) throw new Error(`not publishing: ${problems.join("; ")}`);
  if (branch !== "main") throw new Error(`RemoteFM1FW is on ${branch}, not main`);
  copyFileSync(join(dir, "README.preview.md"), join(fw, "README.md"));
  await ok(exec, "git", ["-C", fw, "add", "README.md", ...["catalog", "docs"].filter((d) => existsSync(join(fw, d)))], { log });
  const staged = (await exec("git", ["-C", fw, "diff", "--cached", "--name-only"])).out.trim();
  if (staged) await ok(exec, "git", ["-C", fw, "commit", "-q", "-m", `Release ${tag}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`], { log });
  await ok(exec, "git", ["-c", "http.postBuffer=524288000", "-C", fw, "push", "origin", branch], { log, timeoutMs: 20 * 60e3 });
  try { await runSteps(steps, { exec, log, repo, sumsTxt }); } finally { staleReleaseCache(); }
  out.published = true;
  return out;
}

// the one-time switch-over: `current` made from the newest full dated release (its .rfm1 files + SHA256SUMS, each
// checked), marked Latest. Safe to re-run: nothing when `current` already holds that set and is Latest; a `current`
// left half-made by a failed run (titled `from`, or a draft) is finished. dryRun (default) only reads and lists.
export async function initCurrent({ from, confirm, dryRun = true, log, exec = run }) {
  if (!TAG_RE.test(from || "") || from === ROLLING) throw new Error(`bad tag "${from}": name the newest full dated release`);
  const repo = cfg.ghRepo;
  const v = JSON.parse(await ok(exec, "gh", ["release", "view", from, "--repo", repo, "--json", "tagName,name,assets"]));
  const assets = v.assets.map((a) => ({ name: a.name, size: a.size, digest: a.digest || null }));
  const dir = join(cfg.cache, "release", from);
  mkdirSync(dir, { recursive: true });
  const need = assets.filter((a) => { const p = join(dir, a.name);
    return !existsSync(p) || statSync(p).size !== a.size || (digestSha(a) && fileSha(p) !== digestSha(a)); });
  if (need.length) await ok(exec, "gh", ["release", "download", from, "--repo", repo, "--dir", dir, "--clobber", ...need.flatMap((a) => ["-p", a.name])], { log, timeoutMs: 30 * 60e3 });
  if (!existsSync(join(dir, "SHA256SUMS"))) throw new Error(`${from} has no SHA256SUMS`);
  const sumsTxt = readFileSync(join(dir, "SHA256SUMS"), "utf8");
  const sums = parseSums(sumsTxt);
  const problems = [];
  for (const a of assets) {
    if (a.name === "SHA256SUMS") continue;
    if (!a.name.endsWith(".rfm1")) { problems.push(`${a.name}: not an .rfm1 (only .rfm1 files + SHA256SUMS go to ${ROLLING})`); continue; }
    if (!sums.has(a.name)) problems.push(`${a.name}: not in ${from}'s SHA256SUMS`);
    else if (fileSha(join(dir, a.name)) !== sums.get(a.name)) problems.push(`${a.name}: does not match ${from}'s SHA256SUMS`);
  }
  for (const n of sums.keys()) if (!assets.some((a) => a.name === n)) problems.push(`${n}: in SHA256SUMS, not in ${from}`);
  if (!sums.size) problems.push(`${from}'s SHA256SUMS lists no file`);
  const files = [...sums.keys()].sort().map((n) => ({ file: n, sha256: sums.get(n) }));
  const live = await liveCurrent(exec, repo);
  const ndir = join(cfg.staging, `${ROLLING}-from-${from}`);
  mkdirSync(ndir, { recursive: true });
  const notesFile = join(ndir, "CURRENT-NOTES.md");
  writeFileSync(notesFile, `The full current set of RemoteFM1 firmware files (.rfm1): every current file and SHA256SUMS (${files.length} files). This release (tag \`${ROLLING}\`, always Latest) is updated in place by each publish; each publish also gets a dated release with only the files it added or updated. It started as ${from}.\n`);
  let steps;
  if (!live.exists) {
    steps = [{ cmd: "gh", args: ["release", "create", ROLLING, "--repo", repo, "--title", from, "--notes-file", notesFile, "--target", "main", "--latest",
      ...files.map((f) => join(dir, f.file)), join(dir, "SHA256SUMS")], timeoutMs: 30 * 60e3 }, { check: "assets" }, { check: "latest" }];
  } else {
    const plan = planCurrent({ files, assets: live.assets, liveSums: parseSums(live.sumsText || ""), liveSumsText: live.sumsText, sums: sumsTxt });
    if (plan.same && !live.draft) {
      steps = (await latestTag(exec, repo)) === ROLLING ? [] : [{ cmd: "gh", args: ["release", "edit", ROLLING, "--repo", repo, "--latest"] }, { check: "latest" }];
    } else if (live.name !== from && !live.draft) {
      throw new Error(`${ROLLING} exists ("${live.name}") and holds a different set: publishes keep it up to date, the switch-over is only for the first time`);
    } else {
      steps = [...currentSteps({ repo, dir, plan }),
        { cmd: "gh", args: ["release", "edit", ROLLING, "--repo", repo, "--title", from, "--notes-file", notesFile, "--draft=false", "--latest"] }, { check: "latest" }];
    }
  }
  const out = { from, dryRun, exists: live.exists, files: files.length, plan: steps.map(stepText), problems, nothingToDo: !steps.length };
  if (dryRun) { for (const p of out.plan) log?.(`(dry run) ${p}`); if (!steps.length) log?.(`${ROLLING} already holds ${from}'s files and is Latest: nothing to do`); return out; }
  if (confirm !== ROLLING) throw new Error(`type "${ROLLING}" to confirm the switch-over`);
  if (problems.length) throw new Error(`not switching over: ${problems.join("; ")}`);
  try { await runSteps(steps, { exec, log, repo, sumsTxt }); } finally { staleReleaseCache(); }
  out.done = true;
  return out;
}
