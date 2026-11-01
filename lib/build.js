// SPDX-License-Identifier: GPL-3.0-only
// Update + build + verify one firmware's .rfm1 in the manager's own FM1VST worktree, with a log bundle.
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { cfg, run, runOk, git, childEnv, isStableTag, verOf, cmpVer } from "./util.js";
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

// ---------- python venv (Pillow + fonttools for the generators) ----------
export async function ensureVenv(job) {
  const py = join(cfg.venv, "bin", "python");
  if (!existsSync(py)) await runOk(cfg.basePython, ["-m", "venv", cfg.venv], { log: job.log, commands: job.commands });
  const chk = await run(py, ["-c", "import PIL, fontTools"]);
  if (chk.code !== 0) await runOk(py, ["-m", "pip", "install", "--quiet", "Pillow", "fonttools"], { log: job.log, commands: job.commands });
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
export async function glueOnDisk(wt, id) {
  const gm = readFileSync(join(wt, ".gitmodules"), "utf8");
  for (const f of walk(join(wt, "core-glue"))) {
    const text = readFileSync(f, "utf8");
    if (!text.includes(id)) continue;
    const c = parseGlue(text, relative(wt, f)).find((x) => x.id === id && !x.orphanRfm1);
    if (!c) continue;
    const rf = parseGlue(text, relative(wt, f)).find((x) => x.id === id && x.orphanRfm1);
    if (rf) c.rfm1 = rf.rfm1;
    const re = new RegExp(`\\[submodule "[^"]+"\\]\\s*\\n\\s*path\\s*=\\s*${(c.submodule || "@@").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n\\s*url\\s*=\\s*(\\S+)`);
    const m = re.exec(gm);
    c.url = m ? m[1] : null;
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

export async function ensureSubmodule(job, wt, core) {
  const args = ["-c", "protocol.file.allow=always", "submodule", "update", "--init"];
  if (core.recursive) args.push("--recursive");
  await git(wt, [...args, core.submodule], { log: job.log, commands: job.commands, timeoutMs: 30 * 60e3 });
  return (await git(join(wt, core.submodule), ["rev-parse", "HEAD"])).trim();
}

// ---------- the pin bump ----------
export async function bumpPin(job, wt, core, up) {
  if (!up.sha || !isStableTag(up.tag)) throw new Error(`no stable upstream release to pin (${up.tag || up.error})`);
  const sub = join(wt, core.submodule);
  await git(sub, ["fetch", "--tags", "origin"], { log: job.log, commands: job.commands });
  await git(sub, ["checkout", "-q", up.sha], { log: job.log, commands: job.commands });
  if (core.recursive) await git(sub, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"], { log: job.log, commands: job.commands });
  const gf = join(wt, core.file);
  let text = readFileSync(gf, "utf8");
  const oldV = core.version, newV = up.version;
  if (oldV && oldV !== newV) {
    text = text.replace(new RegExp(`(\\bVERSION\\s+)${oldV.replace(/\./g, "\\.")}\\b`, "g"), `$1${newV}`)
      .replace(new RegExp(`(FM1CORE_VERSION=\\\\?")${oldV.replace(/\./g, "\\.")}`, "g"), `$1${newV}`);
  }
  text = text.replace(/(tag\s+)v?\d+(\.\d+)+/g, `$1${up.tag}`);
  writeFileSync(gf, text);
  await git(wt, ["add", core.submodule, core.file], { log: job.log, commands: job.commands });
  const st = (await git(wt, ["diff", "--cached", "--name-only"])).trim();
  if (!st) { job.log("(nothing to commit: already at that pin)"); return null; }
  const msg = `${core.id}: ${oldV || "?"} -> ${newV} (${up.slug} ${up.tag} = ${up.sha.slice(0, 7)}), stable release\n\nPin bump by RFM1Manager.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  await git(wt, ["commit", "-q", "-m", msg], { log: job.log, commands: job.commands });
  return (await git(wt, ["rev-parse", "HEAD"])).trim();
}

// ---------- build + verify ----------
export async function buildCore(job, id, { update = false, wt = cfg.worktree, branch = cfg.branch } = {}) {
  const res = { id, wt, update, steps: {} };
  job.result = res;
  try {
    await ensureWorktree(job, wt, branch);
    const py = await ensureVenv(job);
    const core = await glueOnDisk(wt, id);
    if (!core) throw new Error(`no fm1_add_core(${id}) glue in ${wt}/core-glue`);
    if (!core.rfm1) throw new Error(`${core.file} has no fm1_add_rfm1(${id}) line`);
    if (core.gated && !core.rfm1.hostedDespiteGate) throw new Error(`${id} is GATED without HOSTED_DESPITE_GATE: not built (CORES-PLAN.md 6)`);
    res.core = core;
    res.pinBefore = await ensureSubmodule(job, wt, core);
    res.steps.submodule = "ok";
    if (update) {
      const up = await upstreamLatest(ghSlug(core.url), true);
      res.upstream = up;
      const cur = core.version;
      if (up.sha && up.sha !== res.pinBefore && (!cur || cmpVer(up.version, cur) > 0)) {
        res.bumpCommit = await bumpPin(job, wt, core, up);
        Object.assign(core, await glueOnDisk(wt, id));
        res.steps.bump = `-> ${up.tag}`;
      } else { res.steps.bump = `no newer stable release (${up.tag || up.error}); rebuilding at the current pin`; job.log(res.steps.bump); }
    }
    res.pin = (await git(join(wt, core.submodule), ["rev-parse", "HEAD"])).trim();
    const B = join(wt, "build-mgr", id);
    const env = childEnv();
    const conf = ["-S", wt, "-B", B, "-DFM1_RFM1=ON", "-DFM1_RFM1_ONLY=ON",
      `-DFM1_PUBLIC_BUILD=${core.rfm1.hostedDespiteGate ? "OFF" : "ON"}`, `-DFM1_ONLY_CORES=${selector(core)}`,
      `-DFM1_EMCC=${cfg.emcc}`, `-DCR_PYTHON=${py}`];
    let r = await run("cmake", conf, { env, log: job.log, commands: job.commands });
    if (r.code) { res.steps.configure = "failed"; throw new Error("cmake configure failed"); }
    res.steps.configure = "ok";
    r = await run("cmake", ["--build", B, "--target", `rfm1_${id}`, "rfm1_run", "-j", String(cfg.jobs)], { env, log: job.log, commands: job.commands, timeoutMs: 60 * 60e3 });
    if (r.code) { res.steps.build = "failed"; throw new Error("build failed"); }
    res.steps.build = "ok";
    const files = readdirSync(join(B, "rfm1")).filter((n) => n.startsWith(`${id}-`) && n.endsWith(".rfm1"))
      .map((n) => join(B, "rfm1", n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (!files.length) throw new Error(`no ${id}-*.rfm1 in ${B}/rfm1`);
    const file = files[0];
    res.file = file;
    // 1. the format
    r = await run(py, [join(wt, "tools", "rfm1_check.py"), file], { env, log: job.log, commands: job.commands });
    res.steps.rfm1_check = r.code ? "failed" : "ok";
    // 2. owner rules: licence texts, source_url at the exact pinned commit
    const info = readRfm1(file);
    res.manifest = info.manifest; res.sha256 = info.sha256; res.size = info.size; res.licenses = info.licenses;
    const probs = manifestProblems(info, res.pin);
    res.steps.manifest = probs.length ? `failed: ${probs.join("; ")}` : "ok";
    for (const p of probs) job.log(`manifest check: ${p}`);
    // 3. boot, chord, screen (rfm1_run fails on a trap, a halt, silence or no LCD write)
    const wav = join(job.dir || cfg.scratch, `${id}.wav`);
    r = await run(join(B, "rfm1_run"), [...core.rfm1.runArgs, "--wav", wav, file], { env, log: job.log, commands: job.commands, timeoutMs: 10 * 60e3 });
    const m = /chord rms ([0-9.]+) \(peak ([0-9.]+)\), (\d+) LCD writes, ([0-9.]+)x real time/.exec(r.out + r.err);
    res.run = m ? { rms: Number(m[1]), peak: Number(m[2]), lcdWrites: Number(m[3]), realtime: Number(m[4]), line: m[0] } : null;
    const audible = res.run && res.run.rms > 0, drew = res.run && res.run.lcdWrites > 0;
    res.steps.rfm1_run = r.code === 0 && audible && drew ? "ok" : `failed (exit ${r.code}${res.run ? `, rms ${res.run.rms}, ${res.run.lcdWrites} LCD writes` : ""})`;
    res.ok = Object.values(res.steps).every((s) => s === "ok" || String(s).startsWith("->") || String(s).startsWith("no newer"));
    // only the manager worktree's builds are release candidates (scratch scaffolds never reach out/)
    if (res.ok && wt === cfg.worktree) {
      mkdirSync(cfg.out, { recursive: true });
      const dest = join(cfg.out, file.split("/").pop());
      copyFileSync(file, dest);
      res.out = dest;
    }
    if (!res.ok) job.status = "failed";
  } catch (e) {
    res.ok = false; res.error = e.message; job.status = "failed"; job.log(`ERROR: ${e.message}`);
  } finally {
    await writeBundle(job, res);
  }
  return res;
}

// ---------- the log bundle ----------
const ERR_RE = /(\berror:|fatal error|undefined symbol|wasm-ld: error|CMake Error|ld: error|No such file or directory|Traceback \(most recent call last\)|ModuleNotFoundError|rfm1_run: .*(trap|halt|silent|fail)|^error: )/i;
export function errorExcerpt(lines) {
  const i = lines.findIndex((l) => ERR_RE.test(l));
  if (i < 0) {
    const f = lines.findIndex((l) => /\bfailed\b|ERROR:/i.test(l));
    return f < 0 ? "" : lines.slice(Math.max(0, f - 25), f + 5).join("\n");
  }
  return lines.slice(Math.max(0, i - 10), i + 25).join("\n");
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
  const md = `# RFM1Manager build: ${res.id} — ${res.ok ? "OK" : "FAILED"}

- **What:** the \`.rfm1\` of \`${res.id}\` (FM1VST \`fm1_add_rfm1\`, target \`rfm1_${res.id}\`)${res.bumpCommit ? `, after a pin bump to ${res.upstream.tag} (FM1VST commit ${res.bumpCommit.slice(0, 12)})` : res.update ? " (update requested: already at the latest stable release, rebuilt at the current pin)" : " (rebuild at the current pin)"}
- **From:** ${c.url || "?"} at \`${res.pin || "?"}\`${res.upstream ? ` (upstream latest stable: ${res.upstream.tag || res.upstream.error} ${res.upstream.sha ? res.upstream.sha.slice(0, 12) : ""})` : ""}
- **Glue:** FM1VST ${ver.fm1vst || "?"} in \`${res.wt}\`; family \`${c.family || "?"}\`, glue files: ${glueFiles.map((f) => `\`${f}\``).join(", ") || "?"}${glueDir ? `, folder \`${glueDir}/\`` : ""}
- **Toolchain:** ${ver.emcc}; ${ver.cmake}; ${ver.python}
- **Steps:** ${Object.entries(res.steps || {}).map(([k, v]) => `${k}: ${v}`).join("; ") || "(none)"}
${res.run ? `- **rfm1_run:** ${res.run.line}\n` : ""}${res.manifest ? `- **Manifest:** ${res.manifest.name} ${res.manifest.version}, ${res.manifest.license}, source_url ${res.manifest.source_url}, ${res.licenses.length} licence text(s)\n` : ""}${res.error ? `- **Error:** ${res.error}\n` : ""}
${excerpt ? `## First error (with context)\n\n\`\`\`\n${excerpt}\n\`\`\`\n` : ""}
## Reproduce

\`\`\`sh
${job.commands.filter((l) => /cmake|rfm1_check|rfm1_run/.test(l)).join("\n")}
\`\`\`

Full log: \`${join(d, "build.log")}\`.
`;
  writeFileSync(join(d, "SUMMARY-FOR-LLM.md"), md);
}
