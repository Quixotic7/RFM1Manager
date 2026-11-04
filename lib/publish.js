// SPDX-License-Identifier: GPL-3.0-only
// Stage a release (every .rfm1 + SHA256SUMS + notes) into staging/<tag>/, preview it, and publish it only on an
// explicit, typed confirmation (or dry-run: everything checked, the commands shown, nothing pushed or created).
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cfg, run, runOk, moveAside } from "./util.js";
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
    byId.set(id, { id, file: name, path, origin, manifest: info.manifest, sha256: info.sha256, size: info.size, licenses: info.licenses });
  };
  for (const n of readdirSync(dir)) if (n.endsWith(".rfm1")) add(join(dir, n), "release");
  if (existsSync(cfg.out)) for (const n of readdirSync(cfg.out)) if (n.endsWith(".rfm1")) add(join(cfg.out, n), "built");
  // everything else in out/ is refused when staged (shown in the preview's problems)
  const stray = existsSync(cfg.out) ? readdirSync(cfg.out).filter((n) => !n.endsWith(".rfm1") && !n.startsWith(".")) : [];
  return { rel, files: [...byId.values()].filter((f) => !exclude.includes(f.id)), stray };
}

function releaseNotes(tag, files, prevRel, prevSums) {
  const lines = [`RemoteFM1 firmware files (.rfm1), ${tag}. ${files.length} files; SHA256SUMS lists their SHA-256.`, ""];
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
  lines.push(`Compared with ${prevRel.tag}. Each file's licence texts, credits and its exact source (source_url at its commit) are inside it; README.md lists them with the FM1VST commit that built each one.`);
  return lines.join("\n") + "\n";
}

function parseSums(t) {
  const m = new Map();
  for (const l of String(t).split("\n")) { const r = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(l.trim()); if (r) m.set(r[2], r[1]); }
  return m;
}

export async function stage({ tag, notes, exclude = [] }) {
  if (!TAG_RE.test(tag || "")) throw new Error(`bad tag "${tag}"`);
  const { rel, files, stray } = await collectFiles({ exclude });
  const glue = await scanGlue();
  const dir = join(cfg.staging, tag);
  const moved = moveAside(dir);
  mkdirSync(dir, { recursive: true });
  const problems = [];
  for (const s of stray) problems.push(`out/${s}: not an .rfm1 (refused)`);
  const prevDir = join(cfg.cache, "release", rel.tag);
  const prevSums = existsSync(join(prevDir, "SHA256SUMS")) ? parseSums(readFileSync(join(prevDir, "SHA256SUMS"), "utf8")) : new Map();
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
  const sums = ok.sort((a, b) => a.file.localeCompare(b.file)).map((f) => `${f.sha256}  ${f.file}\n`).join("");
  writeFileSync(join(dir, "SHA256SUMS"), sums);
  const relNotes = notes && notes.trim() ? notes : releaseNotes(tag, ok, rel, prevSums);
  writeFileSync(join(dir, "RELEASE-NOTES.md"), relNotes);
  const readme = await refreshReadme(readReadme(), ok);
  writeFileSync(join(dir, "README.preview.md"), readme);
  const tagExists = (await run("gh", ["release", "view", tag, "--repo", cfg.ghRepo, "--json", "tagName"])).code === 0;
  if (tagExists) problems.push(`release ${tag} already exists on ${cfg.ghRepo}`);
  const preview = {
    tag, repo: cfg.ghRepo, dir, previous: rel.tag, created: new Date().toISOString(), movedAside: moved,
    files: ok.map((f) => ({ file: f.file, id: f.id, size: f.size, sha256: f.sha256, origin: f.origin, version: f.manifest.version,
      license: f.manifest.license, source_url: f.manifest.source_url, built_by: f.manifest.built_by, licenses: f.licenses.length,
      hosted: !!f.hostedDespiteGate, virtual: f.manifest.virtual === true, changed: prevSums.get(f.file) !== f.sha256 })),
    sums, notes: relNotes, readmeChanged: readme !== readReadme(), problems,
  };
  writeFileSync(join(dir, "..", `${tag}.preview.json`), JSON.stringify(preview, null, 1));
  return preview;
}

export function readPreview(tag) {
  const p = join(cfg.staging, `${tag}.preview.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

// the publish: dryRun (default) checks and lists; a real one needs confirm === tag, typed in the UI
export async function publish({ tag, confirm, dryRun = true, log }) {
  const pv = readPreview(tag);
  if (!pv) throw new Error(`stage ${tag} first`);
  const dir = pv.dir;
  const files = readdirSync(dir).filter((n) => n.endsWith(".rfm1")).sort();
  const plan = [];
  const fw = cfg.fwRepo;
  // re-check what is on disk now against the preview (nothing swapped since)
  const sums = parseSums(readFileSync(join(dir, "SHA256SUMS"), "utf8"));
  const problems = [...pv.problems];
  for (const n of readdirSync(dir)) if (!/\.rfm1$|^SHA256SUMS$|^RELEASE-NOTES\.md$|^README\.preview\.md$/.test(n)) problems.push(`${n}: unexpected file in staging (refused)`);
  for (const n of files) { const i = readRfm1(join(dir, n)); if (sums.get(n) !== i.sha256) problems.push(`${n}: changed since the preview`); }
  if (files.length !== pv.files.length) problems.push("the staged file list changed since the preview");
  const status = (await run("git", ["-C", fw, "status", "--porcelain"])).out.trim();
  const branch = (await run("git", ["-C", fw, "branch", "--show-current"])).out.trim();
  plan.push(`cp ${join(dir, "README.preview.md")} ${join(fw, "README.md")}`);
  plan.push(`git -C ${fw} add README.md catalog docs`);
  plan.push(`git -C ${fw} commit -m "Release ${tag}"`);
  plan.push(`git -C ${fw} push origin ${branch}`);
  plan.push(`gh release create ${tag} --repo ${cfg.ghRepo} --title ${tag} --notes-file ${join(dir, "RELEASE-NOTES.md")} --target ${branch} ${files.map((f) => join(dir, f)).join(" ")} ${join(dir, "SHA256SUMS")}`);
  const out = { tag, dryRun, plan, problems, fwRepoBranch: branch, fwRepoStatus: status, files: files.length };
  if (dryRun) { for (const p of plan) log?.(`(dry run) ${p}`); return out; }
  if (confirm !== tag) throw new Error(`confirmation "${confirm}" does not match the tag "${tag}"`);
  if (problems.length) throw new Error(`not publishing: ${problems.join("; ")}`);
  if (branch !== "main") throw new Error(`RemoteFM1FW is on ${branch}, not main`);
  copyFileSync(join(dir, "README.preview.md"), join(fw, "README.md"));
  await runOk("git", ["-C", fw, "add", "README.md", ...["catalog", "docs"].filter((d) => existsSync(join(fw, d)))], { log });
  const staged = (await run("git", ["-C", fw, "diff", "--cached", "--name-only"])).out.trim();
  if (staged) await runOk("git", ["-C", fw, "commit", "-q", "-m", `Release ${tag}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`], { log });
  await runOk("git", ["-c", "http.postBuffer=524288000", "-C", fw, "push", "origin", branch], { log, timeoutMs: 20 * 60e3 });
  await runOk("gh", ["release", "create", tag, "--repo", cfg.ghRepo, "--title", tag, "--notes-file", join(dir, "RELEASE-NOTES.md"),
    "--target", branch, ...files.map((f) => join(dir, f)), join(dir, "SHA256SUMS")], { log, timeoutMs: 30 * 60e3 });
  out.published = true;
  return out;
}
