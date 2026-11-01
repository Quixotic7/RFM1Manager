// SPDX-License-Identifier: GPL-3.0-only
// Update + build + verify one firmware's .rfm1 in the manager's own FM1VST worktree, with a log bundle.
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, statSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { cfg, run, runOk, git, childEnv, isStableTag, verOf, cmpVer, moveAside } from "./util.js";
import { parseGlue, ghSlug, upstreamLatest } from "./catalog.js";
import { readRfm1, manifestProblems } from "./rfm1.js";

// ---------- worktree ----------
export async function ensureWorktree(job, wt = cfg.worktree, branch = cfg.branch, base = cfg.baseBranch) {
  if (existsSync(join(wt, ".git"))) {
    const b = (await git(wt, ["branch", "--show-current"])).trim();
    if (b !== branch) throw new Error(`${wt} is on branch ${b}, not ${branch}: refusing to touch it`);
    return wt;
  }
  const has = (await run("git", ["-C", cfg.fm1vst, "rev-parse", "--verify", "-q", `refs/heads/${branch}`])).code === 0;
  const args = has ? ["worktree", "add", wt, branch] : ["worktree", "add", "-b", branch, wt, base];
  await git(cfg.fm1vst, args, { log: job.log, commands: job.commands });
  return wt;
}

// ---------- python venv (Pillow + fonttools for the generators, plus the glue's PYTHON_NEEDS) ----------
export async function ensureVenv(job, needs = []) {
  const py = join(cfg.venv, "bin", "python");
  const o = { log: job.log, commands: job.commands };
  if (!existsSync(py)) await runOk(cfg.basePython, ["-m", "venv", cfg.venv], o);
  const chk = await run(py, ["-c", "import PIL, fontTools"]);
  if (chk.code !== 0) await runOk(py, ["-m", "pip", "install", "--quiet", "Pillow", "fonttools"], o);
  // raqm is Pillow built with Homebrew's libraqm (not a pip package); every other need is a module of that name
  for (const n of needs.filter((x) => x !== "raqm" && /^[A-Za-z_][\w.]*$/.test(x))) {
    if ((await run(py, ["-c", `import ${n}`])).code !== 0) await runOk(py, ["-m", "pip", "install", "--quiet", n], o);
  }
  return py;
}

// ---------- glue on disk (the worktree, including uncommitted scaffolds) ----------
function walk(d, out = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (n.endsWith(".cmake")) out.push(p);
  }
  return out;
}
function gitmodulesEntry(text, path) {
  let cur = null;
  for (const l of text.split("\n")) {
    const h = /^\s*\[submodule "(.+)"\]/.exec(l);
    if (h) { if (cur && cur.path === path) return cur; cur = { name: h[1] }; continue; }
    const kv = /^\s*(\w+)\s*=\s*(.+?)\s*$/.exec(l);
    if (kv && cur) cur[kv[1]] = kv[2];
  }
  return cur && cur.path === path ? cur : null;
}
export async function glueOnDisk(wt, id) {
  const gm = readFileSync(join(wt, ".gitmodules"), "utf8");
  for (const f of walk(join(wt, "core-glue"))) {
    const text = readFileSync(f, "utf8");
    if (!text.includes(id)) continue;
    const c = parseGlue(text, relative(wt, f)).find((x) => x.id === id && !x.orphanRfm1);
    if (!c) continue;
    const rf = parseGlue(text, relative(wt, f)).find((x) => x.id === id && x.orphanRfm1);
    if (rf) c.rfm1 = rf.rfm1;
    const e = c.submodule ? gitmodulesEntry(gm, c.submodule) : null;
    c.url = e ? e.url : null;
    c.subName = e ? e.name : null;
    const ls = c.submodule ? await run("git", ["-C", wt, "ls-tree", "HEAD", c.submodule]) : { out: "" };
    c.pinCommitted = (/commit ([0-9a-f]{40})/.exec(ls.out) || [])[1] || null;
    return c;
  }
  return null;
}

// the FM1_ONLY_CORES selector: the glue file's core_<name> stem, else its folder
export function selector(core) {
  const base = core.file.split("/").pop().replace(/\.cmake$/, "");
  return /^core_/.test(base) ? base.replace(/^core_/, "") : core.file.split("/").slice(-2, -1)[0];
}

// the other cores FM1_ONLY_CORES=<selector> configures too (a selector that is also a glue folder's name, e.g.
// "choralroot", takes the whole folder): their submodules must be checked out at HEAD's pins for the configure
export async function siblingCores(wt, core) {
  const sel = selector(core), out = [];
  for (const dir of readdirSync(join(wt, "core-glue"))) {
    const d = join(wt, "core-glue", dir);
    if (!statSync(d).isDirectory()) continue;
    for (const n of readdirSync(d)) {
      if (!/^core_.*\.cmake$/.test(n) || `core-glue/${dir}/${n}` === core.file) continue;
      if (dir !== sel && n.replace(/^core_|\.cmake$/g, "") !== sel) continue;
      for (const c of parseGlue(readFileSync(join(d, n), "utf8"), `core-glue/${dir}/${n}`)) {
        if (c.orphanRfm1 || !c.submodule || c.submodule === core.submodule || out.some((x) => x.submodule === c.submodule)) continue;
        const full = await glueOnDisk(wt, c.id);
        if (full && full.submodule) out.push(full);
      }
    }
  }
  return out;
}

// ---------- submodules ----------
// FM1VST's shared .git/config may point a submodule's URL at another worktree's module copy (which lacks newer pins
// and tags), so the manager always fetches from .gitmodules' URL, and falls back to the other worktrees' copies
// (read only: `git fetch <their module dir> <sha>`).
async function hasCommit(dir, sha) {
  return (await run("git", ["-C", dir, "cat-file", "-e", `${sha}^{commit}`])).code === 0;
}
function localCopies(sub, path) {
  const common = join(cfg.fm1vst, ".git");
  const dirs = [join(common, "modules", path)];
  const wd = join(common, "worktrees");
  if (existsSync(wd)) for (const n of readdirSync(wd)) dirs.push(join(wd, n, "modules", path));
  let own = null;
  try { own = realpathSync(join(sub, ".git")); } catch { /* */ }
  return dirs.filter((d) => existsSync(join(d, "HEAD")) && realpathSync(d) !== own);
}
export async function fetchCommit(job, wt, core, sha, tag = null) {
  const sub = join(wt, core.submodule);
  if (await hasCommit(sub, sha)) return "already there";
  const o = { log: job.log, commands: job.commands, timeoutMs: 30 * 60e3 };
  const shallow = (await run("git", ["-C", sub, "rev-parse", "--is-shallow-repository"])).out.trim() === "true";
  const tries = [];
  if (core.url) {
    tries.push([core.url, [...(shallow ? ["--unshallow"] : []), "--tags", core.url, ...(tag ? [`+refs/tags/${tag}:refs/tags/${tag}`] : [])]]);
    tries.push([core.url, [core.url, sha]]);
  }
  for (const d of localCopies(sub, core.submodule)) tries.push([d, [d, sha], d]);
  for (const [src, args, gd] of tries) {
    if (gd && (await run("git", ["--git-dir", gd, "cat-file", "-e", `${sha}^{commit}`])).code !== 0) continue;
    await run("git", ["-C", sub, "-c", "protocol.file.allow=always", "fetch", "-q", ...args], o);
    if (await hasCommit(sub, sha)) { job.log(`(${sha.slice(0, 12)} fetched from ${src})`); return src; }
  }
  throw new Error(`${core.submodule}: commit ${sha} not found at ${core.url || "(no URL)"} nor in any local worktree's copy`);
}
// the submodule checked out at `sha` (default: HEAD's pin), its own submodules too with SUBMODULES_RECURSIVE
export async function ensureSubmodule(job, wt, core, sha = core.pinCommitted, tag = null) {
  const sub = join(wt, core.submodule);
  const o = { log: job.log, commands: job.commands, timeoutMs: 30 * 60e3 };
  if (!existsSync(join(sub, ".git"))) {
    const pre = ["-c", "protocol.file.allow=always", ...(core.url && core.subName ? ["-c", `submodule.${core.subName}.url=${core.url}`] : [])];
    const r = await run("git", ["-C", wt, ...pre, "submodule", "update", "--init", core.submodule], o);
    if (r.code && !existsSync(join(sub, ".git"))) throw new Error(`git submodule update --init ${core.submodule}: exit ${r.code}: ${(r.err || r.out).trim().slice(-600)}`);
    if (r.code) job.log("(the clone is there; the commit is fetched next)");
  }
  if (sha) {
    await fetchCommit(job, wt, core, sha, tag);
    const head = (await run("git", ["-C", sub, "rev-parse", "HEAD"])).out.trim();
    // a clone whose checkout failed leaves an empty index (every file "deleted"): -f puts the tree back (the manager
    // never edits submodule sources; untracked generated files stay)
    const dirty = (await run("git", ["-C", sub, "status", "--porcelain", "-uno", "--ignore-submodules=all"])).out.trim();
    if (head !== sha || dirty) await git(sub, ["checkout", "-q", "-f", sha], o);
  }
  if (core.recursive) {
    const args = ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"];
    if ((await run("git", ["-C", sub, ...args], o)).code) {
      await git(sub, ["submodule", "sync", "--recursive"], o);
      await git(sub, args, o);
    }
  }
  return (await git(sub, ["rev-parse", "HEAD"])).trim();
}

// ---------- versions in the glue ----------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const xy = (v) => { const m = /^(\d)\.(\d)(?:\.\d+)*$/.exec(v || ""); return m ? m[1] + m[2] : null; };
const enc = (v) => (pad3(v).split(".").every((x) => /^\d+$/.test(x) && Number(x) < 100) ? pad3(v).split(".").map((x) => x.padStart(2, "0")).join("") : null);
const pad3 = (v) => { const p = v.split("."); while (p.length < 3) p.push("0"); return p.join("."); };
// VERSION_FILE + VERSION_REGEX at a commit of the submodule (as FM1Cores.cmake reads it: the first matching line)
export async function fileVersion(wt, core, commit) {
  if (!core.versionFile || !core.versionRegex || !commit) return null;
  const subRel = relative(core.submodule, core.source || core.submodule);
  const r = await run("git", ["-C", join(wt, core.submodule), "show", `${commit}:${join(subRel, core.versionFile)}`]);
  if (r.code) return null;
  let re;
  try { re = new RegExp(core.versionRegex.replace(/\\(["\\])/g, "$1")); } catch { return null; }
  for (const l of r.out.split("\n")) { const m = re.exec(l); if (m) return m[core.versionGroup || 1] || null; }
  return null;
}
// the "(https://github.com/<slug>, tag vX" header comment
function tagCommentVersion(text, slug) {
  const m = new RegExp(`github\\.com/${esc(slug || "@@")}[^\\n]*?\\btag\\s+((?:[A-Za-z][\\w]*[-_])?v?\\d+(?:\\.\\d+)+)`, "i").exec(text);
  if (m) return verOf(m[1]);
  // else the header's "<Name> 1.6.1 (https://github.com/<slug>"
  const h = new RegExp(`\\s(\\d+(?:\\.\\d+)+)\\s+\\(https?://github\\.com/${esc(slug || "@@")}\\b`, "i").exec(text);
  return h ? h[1] : null;
}
// the glue files of one core: core_<sel>.cmake, core_<sel>.c, core_<sel>_desc.c
function glueFilesOf(wt, core) {
  const dir = core.file.replace(/\/[^/]+$/, ""), sel = selector(core);
  return [core.file, `${dir}/core_${sel}.c`, `${dir}/core_${sel}_desc.c`].filter((f, i, a) => a.indexOf(f) === i && existsSync(join(wt, f)));
}
// every unambiguous spelling of the old version -> the new one; returns { text, changes: [what] }
export function bumpText(text, oldV, newV, { slug, tag, sha }) {
  const changes = [];
  const sub = (re, fn, what) => { text = text.replace(re, (...a) => { const r = fn(...a); if (r !== a[0]) changes.push(`${what}: ${a[0].trim()} -> ${r.trim()}`); return r; }); };
  const S = esc(slug || "@@");
  // the header comment's tag (and its "= <sha>") on the line naming the repository
  sub(new RegExp(`(github\\.com/${S}[^\\n]*?\\btag\\s+)((?:[A-Za-z][\\w]*[-_])?v?\\d+(?:\\.\\d+)+)(\\s*=\\s*[0-9a-f]{7,40})?`, "gi"),
    (m, a, t, h) => `${a}${tag}${h ? ` = ${sha.slice(0, 7)}` : ""}`, "tag comment");
  if (oldV && newV && oldV !== newV) {
    const O = esc(oldV), P = esc(pad3(oldV)), END = "(?![\\w]|\\.\\d)";
    const nv = (m) => (m.includes(pad3(oldV)) && pad3(oldV) !== oldV ? pad3(newV) : newV);
    sub(new RegExp(`(\\bVERSION\\s+)${O}${END}`, "g"), (m, a) => `${a}${newV}`, "VERSION");
    sub(new RegExp(`(set\\(\\s*\\w*ver\\w*\\s+"?)(${P}|${O})${END}("?\\s*\\))`, "gi"), (m, a, v, b) => `${a}${v === pad3(oldV) && v !== oldV ? pad3(newV) : newV}${b}`, "set()");
    sub(new RegExp(`(\\\\?")(v?)(${P}|${O})(\\\\?")`, "g"), (m, a, v, x, b) => `${a}${v}${nv(x)}${b}`, "quoted");
    sub(new RegExp(`(--release\\s+)(${P}|${O})${END}`, "g"), (m, a, x) => `${a}${nv(x)}`, "--release");
    // an unquoted NAME_VERSION=0.5 / CR_VERSION=0.5 (a define or an env assignment)
    sub(new RegExp(`(\\b[A-Z][A-Z0-9_]*VER(?:SION)?=)(${P}|${O})${END}`, "g"), (m, a, x) => `${a}${nv(x)}`, "assignment");
    // "<Name> 1.4 (https://github.com/<slug>": the header's name + version
    sub(new RegExp(`(\\s)${O}(?=\\s+\\(https?://github\\.com/${S})`, "gi"), (m, a) => `${a}${newV}`, "header");
    // an fm1-base identity: FM-1_<prefix> + the version as two digits per part (1.4.0 -> 010400)
    if (enc(oldV) && enc(newV)) sub(new RegExp(`(FM-1_\\d+?)${enc(oldV)}(?!\\d)`, "g"), (m, a) => `${a}${enc(newV)}`, "identity");
    // a Felucca-style build.py --release identity: FM-1_<family digit>XY, one digit each of X.Y (X.Y.Z keeps X.Y's;
    // Felucca's are FM-1_9XY, Skiff's FM-1_7XY)
    if (xy(oldV) && xy(newV) && xy(oldV) !== xy(newV))
      sub(new RegExp(`(FELUCCA_ID\\s*=?\\s*\\\\?"FM-1_\\d)${xy(oldV)}(?=\\\\?")`, "g"), (m, a) => `${a}${xy(newV)}`, "identity");
  }
  return { text, changes };
}
// what still names the old version, or an identity that may encode it: for the summary's manual steps
// an identity line is fine when its digits end with the new version's X.Y or its two-digit encoding
function leftovers(text, file, oldV, newV) {
  const out = [];
  if (!oldV) return out;
  const re = new RegExp(`(?<![\\w.\\-])v?${esc(oldV)}(?![\\w]|\\.\\d)`);
  text.split("\n").forEach((l, i) => {
    if (re.test(l)) out.push(`${file}:${i + 1}: still names ${oldV}: ${l.trim().slice(0, 160)}`);
    else if (/FELUCCA_ID|identity|\b_?\w*_id\b/.test(l) && /FM-1_\d+/.test(l) && !/^\s*(#(?!define)|\/?\*)/.test(l)
      && !(/FM-1_(\d+)/.exec(l)[1].endsWith(xy(newV) || "@") || /FM-1_(\d+)/.exec(l)[1].endsWith(enc(newV) || "@"))) out.push(`${file}:${i + 1}: an identity that may encode the version (check build.py --release): ${l.trim().slice(0, 160)}`);
  });
  return out;
}

// ---------- the pin bump (not committed until every check passed) ----------
export async function applyBump(job, wt, core, up) {
  if (!up.sha || !isStableTag(up.tag)) throw new Error(`no stable upstream release to pin (${up.tag || up.error})`);
  const slug = ghSlug(core.url);
  const files = glueFilesOf(wt, core);
  const oldV = core.version || (await fileVersion(wt, core, core.pinCommitted)) || tagCommentVersion(readFileSync(join(wt, core.file), "utf8"), slug);
  await ensureSubmodule(job, wt, core, up.sha, up.tag);
  const newV = core.version ? up.version : (await fileVersion(wt, core, up.sha)) || up.version;
  const bump = { oldV, newV, tag: up.tag, sha: up.sha, oldPin: core.pinCommitted, files, changes: [], manual: [] };
  for (const f of files) {
    const p = join(wt, f);
    const before = readFileSync(p, "utf8");
    const { text, changes } = bumpText(before, oldV, newV, { slug, tag: up.tag, sha: up.sha });
    if (text !== before) writeFileSync(p, text);
    bump.changes.push(...changes.map((c) => `${f}: ${c}`));
    bump.manual.push(...leftovers(text, f, oldV !== newV ? oldV : null, newV));
  }
  for (const c of bump.changes) job.log(`bump: ${c}`);
  for (const m of bump.manual) job.log(`bump (manual step): ${m}`);
  return bump;
}
export async function commitBump(job, wt, core, bump, up) {
  const o = { log: job.log, commands: job.commands };
  await git(wt, ["add", core.submodule, ...bump.files], o);
  const st = (await git(wt, ["diff", "--cached", "--name-only"])).trim();
  if (!st) { job.log("(nothing to commit: already at that pin)"); return null; }
  const body = [bump.changes.length ? `Version strings:\n${bump.changes.map((c) => `- ${c}`).join("\n")}` : "",
    bump.manual.length ? `Left for a hand edit:\n${bump.manual.map((c) => `- ${c}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
  const msg = `${core.id}: ${bump.oldV || "?"} -> ${bump.newV} (${up.slug} ${up.tag} = ${up.sha.slice(0, 7)}), stable release\n\nPin bump by RFM1Manager; built and verified (rfm1_check, manifest, rfm1_run) before this commit.${body ? `\n\n${body}` : ""}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  await git(wt, ["commit", "-q", "-m", msg], o);
  return (await git(wt, ["rev-parse", "HEAD"])).trim();
}
// a failed update: the glue files and the submodule back to HEAD's (the tree stays clean)
export async function restoreBump(job, wt, core, bump) {
  const o = { log: job.log, commands: job.commands };
  job.log("restoring the glue and the submodule to HEAD's pin (the update is not committed)");
  await run("git", ["-C", wt, "reset", "-q", "--", core.submodule, ...bump.files], o);
  await run("git", ["-C", wt, "checkout", "-q", "HEAD", "--", ...bump.files], o);
  await ensureSubmodule(job, wt, core, bump.oldPin);
  // a nested submodule the new release added (Felucca 1.8's firmware/bsp) stays behind as an untracked checkout: aside
  const sub = join(wt, core.submodule);
  const others = (await run("git", ["-C", sub, "ls-files", "--others", "--exclude-standard", "--directory"])).out.split("\n").filter(Boolean);
  for (const p of others) {
    const d = join(sub, p.replace(/\/$/, ""));
    if (existsSync(join(d, ".git"))) job.log(`(moved aside the nested checkout ${relative(wt, d)} -> ${moveAside(d)})`);
  }
  const st = (await run("git", ["-C", wt, "status", "--short", "--", core.submodule, ...bump.files])).out.trim();
  if (st) throw new Error(`could not restore ${core.submodule} / its glue: ${st}`);
}

// ---------- build + verify ----------
async function buildAndVerify(job, res, core, wt, py, tag = "") {
  const id = res.id, k = (s) => `${s}${tag}`;
  const B = join(wt, "build-mgr", id);
  const env = childEnv();
  const o = { env, log: job.log, commands: job.commands };
  // -U: FM1Cores.cmake caches each PYTHON_NEEDS check, so a need installed since (ensureVenv) would stay "missing"
  const conf = ["-S", wt, "-B", B, "-U", "FM1_PY_HAS_*", "-DFM1_RFM1=ON", "-DFM1_RFM1_ONLY=ON",
    `-DFM1_PUBLIC_BUILD=${core.rfm1.hostedDespiteGate ? "OFF" : "ON"}`, `-DFM1_ONLY_CORES=${selector(core)}`,
    `-DFM1_EMCC=${cfg.emcc}`, `-DCR_PYTHON=${py}`];
  let r = await run("cmake", conf, o);
  if (r.code) { res.steps[k("configure")] = "failed"; return false; }
  res.steps[k("configure")] = "ok";
  r = await run("cmake", ["--build", B, "--target", `rfm1_${id}`, "rfm1_run", "-j", String(cfg.jobs)], { ...o, timeoutMs: 60 * 60e3 });
  if (r.code) { res.steps[k("build")] = "failed"; return false; }
  res.steps[k("build")] = "ok";
  const files = readdirSync(join(B, "rfm1")).filter((n) => n.startsWith(`${id}-`) && n.endsWith(".rfm1"))
    .map((n) => join(B, "rfm1", n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files.length) { res.steps[k("build")] = `failed: no ${id}-*.rfm1 in ${B}/rfm1`; return false; }
  const file = files[0];
  res.file = file;
  // 1. the format
  r = await run(py, [join(wt, "tools", "rfm1_check.py"), file], o);
  res.steps[k("rfm1_check")] = r.code ? "failed" : "ok";
  // 2. owner rules: licence texts, source_url at the exact pinned commit (and built_by naming HEAD after the commit)
  const info = readRfm1(file);
  res.manifest = info.manifest; res.sha256 = info.sha256; res.size = info.size; res.licenses = info.licenses;
  const probs = manifestProblems(info, res.pin);
  if (tag) {
    const head = (await git(wt, ["rev-parse", "--short=12", "HEAD"])).trim();
    if (!String(info.manifest.built_by || "").includes(head)) probs.push(`built_by (${info.manifest.built_by}) does not name HEAD ${head}`);
  }
  res.steps[k("manifest")] = probs.length ? `failed: ${probs.join("; ")}` : "ok";
  for (const p of probs) job.log(`manifest check: ${p}`);
  // 3. boot, chord, screen (rfm1_run fails on a trap, a halt, silence or no LCD write)
  const wav = join(job.dir || cfg.scratch, `${id}.wav`);
  r = await run(join(B, "rfm1_run"), [...core.rfm1.runArgs, "--wav", wav, file], { ...o, timeoutMs: 10 * 60e3 });
  const m = /chord rms ([0-9.]+) \(peak ([0-9.]+)\), (\d+) LCD writes, ([0-9.]+)x real time/.exec(r.out + r.err);
  res.run = m ? { rms: Number(m[1]), peak: Number(m[2]), lcdWrites: Number(m[3]), realtime: Number(m[4]), line: m[0] } : null;
  const audible = res.run && res.run.rms > 0, drew = res.run && res.run.lcdWrites > 0;
  res.steps[k("rfm1_run")] = r.code === 0 && audible && drew ? "ok" : `failed (exit ${r.code}${res.run ? `, rms ${res.run.rms}, ${res.run.lcdWrites} LCD writes` : ""})`;
  return Object.values(res.steps).every(stepOk);
}
const stepOk = (s) => s === "ok" || String(s).startsWith("->") || String(s).startsWith("no newer");

export async function buildCore(job, id, { update = false, wt = cfg.worktree, branch = cfg.branch } = {}) {
  const res = { id, wt, update, steps: {} };
  job.result = res;
  let core = null, bump = null;
  try {
    await ensureWorktree(job, wt, branch);
    core = await glueOnDisk(wt, id);
    if (!core) throw new Error(`no fm1_add_core(${id}) glue in ${wt}/core-glue`);
    if (!core.rfm1) throw new Error(`${core.file} has no fm1_add_rfm1(${id}) line`);
    if (core.gated && !core.rfm1.hostedDespiteGate) throw new Error(`${id} is GATED without HOSTED_DESPITE_GATE: not built (CORES-PLAN.md 6)`);
    res.core = core;
    const py = await ensureVenv(job, core.pythonNeeds || []);
    res.pinBefore = core.pinCommitted;
    if (update) {
      const up = await upstreamLatest(ghSlug(core.url), true);
      res.upstream = up;
      // the current version: the glue's VERSION, else its VERSION_FILE at the pin, else the header's tag comment
      let cur = core.version;
      if (!cur) {
        if (existsSync(join(wt, core.submodule, ".git")) && core.pinCommitted) cur = await fileVersion(wt, core, core.pinCommitted);
        cur = cur || tagCommentVersion(readFileSync(join(wt, core.file), "utf8"), ghSlug(core.url));
      }
      if (up.sha && up.sha !== core.pinCommitted && (!cur || cmpVer(up.version, cur) > 0)) {
        // the old pin is not needed: clone if missing, then fetch the tag's commit
        bump = await applyBump(job, wt, core, up);
        res.bump = bump;
        res.steps.submodule = "ok";
        Object.assign(core, await glueOnDisk(wt, id));
        res.steps.bump = `-> ${up.tag}`;
      } else {
        res.pinBefore = await ensureSubmodule(job, wt, core);
        res.steps.submodule = "ok";
        res.steps.bump = `no newer stable release (${up.tag || up.error}); rebuilding at the current pin`; job.log(res.steps.bump);
      }
    } else {
      res.pinBefore = await ensureSubmodule(job, wt, core);
      res.steps.submodule = "ok";
    }
    res.pin = (await git(join(wt, core.submodule), ["rev-parse", "HEAD"])).trim();
    for (const sc of await siblingCores(wt, core)) {
      job.log(`(${selector(core)} also configures ${sc.id}: ${sc.submodule} at its pin)`);
      await ensureSubmodule(job, wt, sc);
    }
    res.ok = await buildAndVerify(job, res, core, wt, py);
    if (res.ok && bump) {
      // every check passed: commit the bump, then rebuild so built_by names that commit, and check again
      res.bumpCommit = await commitBump(job, wt, core, bump, res.upstream);
      if (res.bumpCommit) {
        res.ok = await buildAndVerify(job, res, core, wt, py, " (after the commit)");
        if (!res.ok) {
          job.log("the rebuild after the commit failed: undoing the commit");
          await git(wt, ["reset", "-q", "HEAD~1"], { log: job.log, commands: job.commands });
          res.bumpCommit = null;
        }
      }
      bump = res.bumpCommit ? null : bump;
    }
    // only the manager worktree's builds are release candidates (scratch scaffolds never reach out/)
    if (res.ok && wt === cfg.worktree) {
      mkdirSync(cfg.out, { recursive: true });
      const dest = join(cfg.out, res.file.split("/").pop());
      copyFileSync(res.file, dest);
      res.out = dest;
    }
    if (!res.ok) { job.status = "failed"; res.error = res.error || `failed: ${Object.entries(res.steps).filter(([, v]) => !stepOk(v)).map(([k, v]) => `${k} ${v}`).join("; ")}`; job.log(`ERROR: ${res.error}`); }
  } catch (e) {
    res.ok = false; res.error = e.message; job.status = "failed"; job.log(`ERROR: ${e.message}`);
  } finally {
    if (bump && !res.ok) {
      try { await restoreBump(job, wt, core, bump); res.restored = true; }
      catch (e) { res.restored = false; res.restoreError = e.message; job.log(`ERROR: restore: ${e.message}`); }
    }
    await writeBundle(job, res);
  }
  return res;
}

// ---------- the log bundle ----------
// the first real error: git's fatal:, CMake Error, a compiler / linker error, make's "No rule", a Python traceback,
// rfm1_run's own verdict; the manager's own "ERROR:" line only when nothing else matched. Command echoes ("$ ...")
// and CMake status lines never count.
const ERR_STRONG = /(^fatal:|^error:|CMake Error|\berror:|fatal error|undefined symbol|wasm-ld: error|ld: error|No rule to make target|Traceback \(most recent call last\)|ModuleNotFoundError|rfm1_run: .*(trap|halt|silent|fail))/i;
export function errorExcerpt(lines) {
  const real = (l) => !/^\$ /.test(l) && !/^-- /.test(l) && !/^ERROR: /.test(l) && !/^bump/.test(l);
  let i = lines.findIndex((l) => real(l) && ERR_STRONG.test(l));
  if (i < 0) i = lines.findIndex((l) => /^ERROR: /.test(l) || (real(l) && /\bfailed\b/i.test(l)));
  if (i < 0) return "";
  // context: the command that produced it (the nearest "$ " line, up to 10 back, CMake status lines skipped) + 25 after
  let s = i;
  for (let j = i - 1; j >= Math.max(0, i - 10); j--) { if (/^-- /.test(lines[j])) break; s = j; if (/^\$ /.test(lines[j])) break; }
  return lines.slice(s, i + 25).join("\n");
}

async function versions(wt) {
  const v = async (c, a) => { const r = await run(c, a); return (r.out || r.err).split("\n")[0].trim(); };
  const out = {
    emcc: await v(cfg.emcc, ["--version"]), cmake: await v("cmake", ["--version"]),
    python: await v(join(cfg.venv, "bin", "python"), ["--version"]), node: process.version, git: await v("git", ["--version"]),
  };
  if (existsSync(join(wt, ".git"))) {
    out.fm1vst = `${(await run("git", ["-C", wt, "rev-parse", "HEAD"])).out.trim()} (${(await run("git", ["-C", wt, "branch", "--show-current"])).out.trim()})`;
    out.fm1vstStatus = (await run("git", ["-C", wt, "status", "--short"])).out.trim();
  }
  return out;
}

export async function writeBundle(job, res) {
  if (!job.dir) return;
  const d = job.dir;
  const ver = await versions(res.wt || cfg.worktree);
  res.versions = ver;
  writeFileSync(join(d, "commands.txt"), job.commands.join("\n") + "\n");
  const envKeys = ["PATH", "DYLD_FALLBACK_LIBRARY_PATH", "EMSDK", "EM_CONFIG", "PYTHONPATH", "CC", "CXX", "HOME", "SHELL"];
  const env = childEnv();
  writeFileSync(join(d, "env.txt"), envKeys.map((k) => `${k}=${env[k] ?? ""}`).join("\n") + "\n");
  writeFileSync(join(d, "versions.txt"), Object.entries(ver).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n");
  const excerpt = res.ok ? "" : errorExcerpt(job.lines);
  writeFileSync(join(d, "error-excerpt.txt"), excerpt || "(no error)\n");
  writeFileSync(join(d, "result.json"), JSON.stringify(res, null, 1));
  const c = res.core || {};
  const glueDir = c.file ? c.file.replace(/\/[^/]+$/, "") : null;
  const glueFiles = glueDir ? [c.file, ...["c", "_desc.c"].map((s) => `${glueDir}/core_${c.id}${s === "c" ? ".c" : s}`)].filter((f, i) => i === 0 || existsSync(join(res.wt || cfg.worktree, f))) : [];
  const b = res.bump;
  const bumpMd = b ? `## Pin bump\n\n- ${b.oldV || "?"} -> ${b.newV} (${b.tag} = ${b.sha.slice(0, 12)}; old pin ${b.oldPin ? b.oldPin.slice(0, 12) : "?"}): ${res.bumpCommit ? `committed as ${res.bumpCommit.slice(0, 12)}` : res.ok ? "nothing to commit" : `**not committed**: ${res.restored === false ? `restore FAILED (${res.restoreError}), check the worktree` : "the glue and the submodule were restored to HEAD's pin, the tree is clean"}`}
${b.changes.map((x) => `- version string: ${x}`).join("\n")}
${b.manual.length ? `\n### Manual steps (not bumped: ambiguous or derived)\n\n${b.manual.map((x) => `- ${x}`).join("\n")}\n` : ""}
` : "";
  const failedSteps = Object.entries(res.steps || {}).filter(([, v]) => !stepOk(v)).map(([k]) => k);
  const hint = !res.ok ? `\n## What to look at\n\n${failedSteps.includes("configure") ? "CMake's configure failed: the CMake Error below names the glue line (core-glue/...) and what it wanted." : failedSteps.includes("build") ? "The build failed: an upstream release that changed its sources or generators (new / renamed generated headers, new source files) needs the glue (core-glue/<family>/core_<id>.cmake GEN / EXTRA_SOURCES, the unit .c) changed by hand, following the family's other cores; never edit the submodule." : failedSteps.length ? `Failed checks: ${failedSteps.join(", ")}.` : "The job stopped before building (submodule / fetch / glue): see the error."}\n` : "";
  const md = `# RFM1Manager build: ${res.id} — ${res.ok ? "OK" : "FAILED"}

- **What:** the \`.rfm1\` of \`${res.id}\` (FM1VST \`fm1_add_rfm1\`, target \`rfm1_${res.id}\`)${res.bumpCommit ? `, after a pin bump to ${res.upstream.tag} (FM1VST commit ${res.bumpCommit.slice(0, 12)})` : b ? `, trying the update to ${b.tag} (not committed)` : res.update ? " (update requested: already at the latest stable release, rebuilt at the current pin)" : " (rebuild at the current pin)"}
- **From:** ${c.url || "?"} at \`${res.pin || "?"}\`${res.upstream ? ` (upstream latest stable: ${res.upstream.tag || res.upstream.error} ${res.upstream.sha ? res.upstream.sha.slice(0, 12) : ""})` : ""}
- **Glue:** FM1VST ${ver.fm1vst || "?"} in \`${res.wt}\`; family \`${c.family || "?"}\`, glue files: ${glueFiles.map((f) => `\`${f}\``).join(", ") || "?"}${glueDir ? `, folder \`${glueDir}/\`` : ""}
- **Toolchain:** ${ver.emcc}; ${ver.cmake}; ${ver.python}
- **Steps:** ${Object.entries(res.steps || {}).map(([k, v]) => `${k}: ${v}`).join("; ") || "(none)"}
${res.run ? `- **rfm1_run:** ${res.run.line}\n` : ""}${res.manifest ? `- **Manifest:** ${res.manifest.name} ${res.manifest.version}, ${res.manifest.license}, source_url ${res.manifest.source_url}, built_by ${res.manifest.built_by}, ${res.licenses.length} licence text(s)\n` : ""}${res.error ? `- **Error:** ${res.error}\n` : ""}
${bumpMd}${hint}${excerpt ? `\n## First error (with context)\n\n\`\`\`\n${excerpt}\n\`\`\`\n` : ""}
## Reproduce

\`\`\`sh
${job.commands.filter((l) => /cmake|rfm1_check|rfm1_run/.test(l)).join("\n")}
\`\`\`

Full log: \`${join(d, "build.log")}\`.
`;
  writeFileSync(join(d, "SUMMARY-FOR-LLM.md"), md);
}
