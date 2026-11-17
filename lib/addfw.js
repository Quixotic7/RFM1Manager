// SPDX-License-Identifier: GPL-3.0-only
// Add a firmware from a GitHub URL: detect its base family by comparing it with the cores FM1VST already builds
// (file layout similarity + markers + fork parent), pick the closest core, scaffold submodule + glue + fm1_add_rfm1
// from it, try a build. Detection-only mode writes the bundle and touches no worktree.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cfg, run, runOk, git, moveAside, childEnv } from "./util.js";
import { ghSlug, upstreamLatest, scanGlue } from "./catalog.js";
import { ensureWorktree, buildCore, writeBundle, errorExcerpt, ensureVenv } from "./build.js";
import { authorTarget } from "./target.js";

const FAMILY_MARKERS = {
  fm1base: [/^app\/fm1\.toml$/, /^base\/?$/, /fm1-base/i],
  felucca_web: [/^platforms\//, /felucca/i, /^felucca-base/],
  sloop: [/sloop/i, /^SLOOP\.md$/, /clipper/i],
  dinghy: [/dinghy/i, /vave/i, /^smk37-port\.yaml$/],
  choralroot: [/choralroot/i, /crf_/i, /purplemonkey/i],
  melodee: [/melodee/i],
  plat: [/^firmware\/src\/app\//, /^host\/[^/]+_host\.c$/, /^firmware\/src\/dsp\//],
  speak37: [/speak/i],
};

async function tree(slug, sha) {
  const f = join(cfg.cache, "trees", `${slug.replace("/", "__")}@${sha}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const r = await run("gh", ["api", `repos/${slug}/git/trees/${sha}?recursive=1`, "-q", "[.tree[].path]"]);
  if (r.code) return null;
  const paths = JSON.parse(r.out);
  mkdirSync(join(cfg.cache, "trees"), { recursive: true });
  writeFileSync(f, JSON.stringify(paths));
  return paths;
}
// a path's shape: the first three levels, with file names reduced to their extension (so layouts compare, not names)
function shape(paths) {
  const s = new Set();
  for (const p of paths) {
    const parts = p.split("/").slice(0, 3);
    if (parts.length && /\.[A-Za-z0-9]+$/.test(parts[parts.length - 1]) && parts.length > 1) parts[parts.length - 1] = "*" + parts[parts.length - 1].replace(/^.*\./, ".");
    s.add(parts.join("/"));
  }
  return s;
}
const jaccard = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };

export async function detect(url, log = () => {}) {
  const slug = ghSlug(url);
  if (!slug) throw new Error(`not a GitHub repository URL: ${url}`);
  const info = JSON.parse(await runOk("gh", ["api", `repos/${slug}`]));
  const up = { ...(await upstreamLatest(slug, true)) };   // a copy: the cached object stays as GitHub said
  // a fork's "latest stable release" that is its parent's own tag at the parent's commit (inherited with the fork, not
  // a release of this firmware: HYP-1's v1.1 is AMB-1's): not a stable release of this repository
  if (up.sha && up.tag && info.parent) {
    const pr = await run("gh", ["api", `repos/${info.parent.full_name}/commits/${encodeURIComponent(up.tag)}`, "-q", ".sha"]);
    if (!pr.code && pr.out.trim() === up.sha) {
      log(`${up.tag} = ${up.sha.slice(0, 7)} is ${info.parent.full_name}'s own tag (inherited by the fork): not a release of ${slug}`);
      up.inherited = `${up.tag} is ${info.parent.full_name}'s own tag at the same commit ${up.sha.slice(0, 7)}, inherited by the fork: not a release of this repository`;
    }
  }
  // the author's target (RemoteFM1Metadata.json on the default branch) in place of the manager's pick
  const at = await authorTarget(slug, true);
  if (at.found && at.error) log(`warning: author's target: ${at.error}`);
  if (at.found && at.sha) {
    log(`author's target: ${at.target} = ${at.sha.slice(0, 7)} (in place of ${up.tag || "no stable release"})`);
    Object.assign(up, { tag: at.tag, sha: at.sha, version: at.version, source: "target", authorTarget: at.target });
    delete up.error; delete up.inherited;
  }
  const ref = up.sha || info.default_branch;
  log(`${slug}: default branch ${info.default_branch}, latest stable ${up.tag || "(none: " + up.error + ")"}, parent ${info.parent?.full_name || "-"}, licence ${info.license?.spdx_id || "-"}`);
  const paths = (await tree(slug, ref)) || [];
  const readme = await run("gh", ["api", `repos/${slug}/readme`, "-H", "Accept: application/vnd.github.raw"]);
  const text = readme.code === 0 ? readme.out.slice(0, 20000) : "";
  const gm = paths.includes(".gitmodules") ? await run("gh", ["api", `repos/${slug}/contents/.gitmodules?ref=${ref}`, "-H", "Accept: application/vnd.github.raw"]) : { out: "" };
  const me = shape(paths);
  // the existing cores, each at its pin
  const glue = await scanGlue();
  const sims = [];
  for (const c of Object.values(glue.cores)) {
    const s = ghSlug(c.url);
    if (!s || !c.pin || !c.family) continue;
    const t = await tree(s, c.pin);
    if (!t) continue;
    sims.push({ id: c.id, family: c.family, folder: c.file.split("/")[1], slug: s, similarity: Number(jaccard(me, shape(t)).toFixed(3)), same: s.toLowerCase() === slug.toLowerCase() });
  }
  sims.sort((a, b) => b.similarity - a.similarity);
  const scores = {};
  for (const [fam, res] of Object.entries(FAMILY_MARKERS)) {
    let sc = 0; const hits = [];
    for (const re of res) {
      if (paths.some((p) => re.test(p))) { sc += 2; hits.push(`path ${re}`); }
      if (re.source.length > 4 && re.test(text)) { sc += 1; hits.push(`README ${re}`); }
      if (re.test(gm.out || "")) { sc += 2; hits.push(`.gitmodules ${re}`); }
    }
    if (info.parent && re0(fam).test(info.parent.full_name)) { sc += 5; hits.push(`fork of ${info.parent.full_name}`); }
    const best = sims.find((s) => s.folder === fam);
    if (best) sc += best.similarity * 10;
    scores[fam] = { score: Number(sc.toFixed(2)), hits, closest: best ? best.id : null };
  }
  const fam = Object.entries(scores).sort((a, b) => b[1].score - a[1].score)[0];
  let closest = sims.find((s) => s.folder === fam[0]) || sims[0];
  // the platform generation: a firmware on a base (fm1-base's base/, Felucca's felucca-base/ or firmware/bsp) gets the
  // family's core whose base is of the closest date (a newer fm1-base needs chip/ota.c before plat_fm1.c: a glue
  // written for it), fewer extra glue files breaking a tie (a day each)
  let generation = null;
  const nb = await baseOf(slug, ref, paths);
  if (nb && nb.date) {
    const cands = [];
    for (const s0 of sims.filter((x) => x.folder === fam[0] && !x.same)) {
      const c = glue.cores[s0.id];
      const b = await baseOf(s0.slug, c.pin, await tree(s0.slug, c.pin) || []);
      const date = b?.date || (await commitDate(s0.slug, c.pin));
      if (!date) continue;
      const extra = await extraGlueFiles(c, glue.ref);
      const dd = Math.abs(Date.parse(date) - Date.parse(nb.date)) / 864e5;
      cands.push({ id: s0.id, base: b ? `${b.slug}@${b.sha.slice(0, 7)}` : "(vendored: the pin's date)", date, days: Number(dd.toFixed(1)), extra, score: Number((dd + extra).toFixed(1)) });
    }
    cands.sort((x, y) => x.score - y.score);
    generation = { base: `${nb.path} ${nb.slug}@${nb.sha.slice(0, 7)} (${nb.date})`, candidates: cands };
    if (cands.length && cands[0].id !== closest?.id) {
      log(`template by base generation: ${cands[0].id} (base ${cands[0].date}) over ${closest?.id}: the new firmware's base is ${nb.date}`);
      closest = sims.find((x) => x.id === cands[0].id);
      scores[fam[0]].closest = closest.id;
    }
  }
  return {
    slug, url: `https://github.com/${slug}`, name: info.name, description: info.description, owner: info.owner.login,
    license: info.license?.spdx_id && info.license.spdx_id !== "NOASSERTION" ? info.license.spdx_id : null,
    parent: info.parent?.full_name || null, upstream: up, ref, files: paths.length,
    family: fam[0], familyFolder: fam[0], closest: closest?.id || null, scores, similar: sims.slice(0, 6),
    alreadyInCatalog: sims.filter((s) => s.same).map((s) => s.id), generation,
  };
}
// the base submodule (or vendored base) of a repository at a ref: { path, slug, sha, date }
const BASE_PATHS = ["base", "felucca-base", "firmware/bsp"];
async function baseOf(slug, ref, paths) {
  const f = join(cfg.cache, "bases.json");
  const cache = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  const key = `${slug}@${ref}`;
  if (key in cache) return cache[key];
  let out = null;
  for (const p of BASE_PATHS) {
    const r = await run("gh", ["api", `repos/${slug}/contents/${p}?ref=${ref}`]);
    if (r.code) continue;
    let j; try { j = JSON.parse(r.out); } catch { continue; }
    if (!Array.isArray(j) && j.type === "submodule" && j.submodule_git_url) {
      const bs = ghSlug(j.submodule_git_url);
      out = { path: p, slug: bs, sha: j.sha, date: bs ? await commitDate(bs, j.sha) : null };
      break;
    }
    if (Array.isArray(j) && paths.some((x) => x.startsWith(`${p}/`))) { out = { path: p, slug, sha: ref, date: await commitDate(slug, ref), vendored: true }; break; }
  }
  cache[key] = out;
  writeFileSync(f, JSON.stringify(cache, null, 1));
  return out;
}
async function commitDate(slug, sha) {
  const r = await run("gh", ["api", `repos/${slug}/commits/${sha}`, "-q", ".commit.committer.date"]);
  return r.code ? null : r.out.trim() || null;
}
// how many glue units besides core_<id>.c / _desc.c a core has (<id>_*.c: what a scaffold from it copies)
async function extraGlueFiles(c, ref) {
  const dir = c.file.replace(/\/[^/]+$/, "");
  const ls = await run("git", ["-C", cfg.fm1vst, "ls-tree", "--name-only", `${ref}:${dir}`]);
  return ls.out.split("\n").filter((n) => n.startsWith(`${c.id}_`) && n.endsWith(".c")).length;
}
function re0(fam) {
  return { felucca_web: /felucca/i, sloop: /sloop/i, dinghy: /zvenson|vave/i, fm1base: /fm1-base|charlesvestal/i, choralroot: /choralroot/i, melodee: /melodee/i, plat: /fm1-(fomni|x0x|fimba)/i, speak37: /speak/i }[fam] || /^$/;
}

const SPDX = { "GPL-3.0": "GPL-3.0-only", "GPL-2.0": "GPL-2.0-only", "LGPL-3.0": "LGPL-3.0-only" };

// scaffold from the closest core, into a scratch worktree (default) or the manager worktree; then build
export async function addFirmware(job, { url, id, mode = "detect", target = "scratch", template, hostedDespiteGate = null }) {
  const res = { mode, target, url };
  job.result = res;
  try {
    const d = await detect(url, job.log);
    res.detect = d;
    job.log(`family: ${d.family} (closest core: ${d.closest}); scores: ${Object.entries(d.scores).map(([k, v]) => `${k} ${v.score}`).join(", ")}`);
    // clone (shallow, at the stable tag when there is one) for its LICENSE and a look at its tree
    const clone = join(cfg.scratch, "clones", `${d.slug.replace("/", "__")}@${(d.upstream.tag || "HEAD")}`);
    if (!existsSync(clone)) {
      const a = ["clone", "--depth", "1", "--recurse-submodules", "--shallow-submodules", ...(d.upstream.tag ? ["--branch", d.upstream.tag] : []), d.url, clone];
      const r = await run("git", a, { log: job.log, commands: job.commands, timeoutMs: 20 * 60e3 });
      if (r.code) throw new Error("clone failed");
    }
    res.clone = clone;
    const lic = readdirSync(clone).find((n) => /^(LICENSE|LICENCE|COPYING)(\.md|\.txt)?$/i.test(n));
    res.licenseFile = lic || null;
    if (!d.license && lic) {
      const t = readFileSync(join(clone, lic), "utf8");
      d.license = /GNU GENERAL PUBLIC LICENSE\s+Version 3/i.test(t) ? "GPL-3.0-only" : /Mozilla Public License Version 2\.0/i.test(t) ? "MPL-2.0" : /MIT License/i.test(t) ? "MIT" : null;
    }
    const spdx = SPDX[d.license] || d.license || "NOASSERTION";
    const user = await run("gh", ["api", `users/${d.owner}`, "-q", ".name // .login"]);
    const author = (user.out || d.owner).trim() || d.owner;
    res.license = spdx; res.author = author;
    if (!lic) job.log("warning: no LICENSE file at the repository root: the .rfm1 must carry licence texts (LICENSE_FILES)");
    if (!d.upstream.sha) job.log("warning: no stable release: the owner pins stable releases only, so the scaffold uses the default branch for a trial build only");
    // the repository is already a core in FM1VST (same .gitmodules URL): never a copy; enable it as .rfm1 + update
    const glue0 = await scanGlue();
    const existing = d.alreadyInCatalog.map((x) => glue0.cores[x]).filter(Boolean);
    if (existing.length) {
      const e = existing.find((c) => !c.rfm1) || existing[0];
      res.existing = { id: e.id, file: e.file, rfm1: !!e.rfm1, gated: e.gated || null, action: e.rfm1 ? "already an .rfm1: update + build" : "enable as .rfm1 + update" };
      job.log(`${d.slug} is already a core in FM1VST: ${e.id} (${e.file})${e.rfm1 ? ", already an .rfm1" : ", no fm1_add_rfm1 yet"}: ${res.existing.action}, in the manager worktree`);
    }
    if (mode === "detect") { job.log("detection only: nothing scaffolded"); res.ok = true; return res; }
    if (d.upstream.inherited && target === "manager" && !res.existing) throw new Error(`no stable release of its own: ${d.upstream.inherited} (the owner pins stable releases only; a scratch scaffold can still try it)`);
    if (res.existing) {
      res.id = res.existing.id; res.wt = cfg.worktree; res.branch = cfg.branch;
      const b = await buildCore({ ...job, dir: null, wavDir: job.dir, log: job.log, commands: job.commands, lines: job.lines }, res.existing.id,
        { update: true, prepare: res.existing.rfm1 ? null : (core, wt) => enableRfm1(job, core, wt, { author, hostedDespiteGate }) });
      res.build = b; res.ok = b.ok;
      if (!b.ok) job.status = "failed";
      return res;
    }

    // ---- scaffold ----
    const glue = await scanGlue();
    const tplId = template || d.closest;
    const tpl = glue.cores[tplId];
    if (!tpl) throw new Error(`no template core ${tplId}`);
    const wt = target === "manager" ? cfg.worktree : join(cfg.fm1vst, ".claude", "worktrees", "rfm1-manager-scratch");
    const branch = target === "manager" ? cfg.branch : "rfm1-manager-scratch";
    if (target !== "manager" && existsSync(wt)) {
      // a fresh scratch worktree each time: the old one is moved aside (scratch/trash), its branch dropped
      job.log(`moving the old scratch worktree aside: ${moveAside(wt)}`);
      await run("git", ["-C", cfg.fm1vst, "worktree", "prune"], { log: job.log, commands: job.commands });
      await run("git", ["-C", cfg.fm1vst, "branch", "-D", branch], { log: job.log, commands: job.commands });
    }
    await ensureWorktree(job, wt, branch, (await run("git", ["-C", cfg.fm1vst, "rev-parse", "--verify", "-q", `refs/heads/${cfg.branch}`])).code === 0 ? cfg.branch : cfg.baseBranch);
    res.wt = wt; res.branch = branch;
    id = (id || d.name.toLowerCase().replace(/^fm1-|-fm1$/g, "").replace(/[^a-z0-9_]/g, "")).slice(0, 31);
    if (!/^[a-z0-9_]{1,31}$/.test(id)) throw new Error(`bad id ${id}`);
    if (glue.cores[id] && target === "manager") throw new Error(`${id} exists already in the catalog's glue`);
    if (glue.cores[id]) id = `${id}_new`.slice(0, 31);
    res.id = id; res.template = tplId;
    let subPath = `cores/${d.name}`;
    if (existsSync(join(wt, subPath)) || readFileSync(join(wt, ".gitmodules"), "utf8").includes(`path = ${subPath}\n`)) subPath = `cores/${d.name}-${id}`;
    res.submodule = subPath;
    if (!existsSync(join(wt, subPath, ".git"))) {
      const r = await run("git", ["-C", wt, "-c", "protocol.file.allow=always", "submodule", "add", "--name", subPath.slice(6), d.url, subPath], { log: job.log, commands: job.commands, timeoutMs: 30 * 60e3 });
      if (r.code) throw new Error("git submodule add failed");
    }
    if (d.upstream.sha) {
      await git(join(wt, subPath), ["fetch", "-q", "--tags", "origin"], { log: job.log, commands: job.commands });
      await git(join(wt, subPath), ["checkout", "-q", d.upstream.sha], { log: job.log, commands: job.commands });
    }
    await run("git", ["-C", join(wt, subPath), "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"], { log: job.log, commands: job.commands, timeoutMs: 30 * 60e3 });
    // the template's glue files: its .cmake, unit, desc and the EXTRA_SOURCES named after it
    const folder = tpl.file.replace(/\/[^/]+$/, "");
    const tplDir = join(wt, folder);
    const tplSub = tpl.submodule.slice(6);
    const ver = d.upstream.version || "0.0";
    const written = [];
    const tplFile = tpl.file.split("/").pop();
    if (tplFile === "core.cmake") throw new Error(`${tplId}'s glue is a folder-wide core.cmake: scaffold by hand (template ${folder})`);
    // the glue files copied, and their new names (every whole-word use of the template id: amb_amb.c -> <id>_<id>.c)
    const copies = readdirSync(tplDir).filter((n) => n === tplFile || n === `core_${tplId}.c` || n === `core_${tplId}_desc.c` || n.startsWith(`${tplId}_`) && n.endsWith(".c"));
    const renames = Object.fromEntries(copies.map((n) => [n, n.replace(new RegExp(`(?<![A-Za-z0-9])${esc(tplId)}(?![A-Za-z0-9])`, "g"), id)]));
    const swapOpts = { tplId, id, tplSub, subPath, tplSlug: ghSlug(tpl.url), slug: d.slug, renames };
    for (const n of copies) {
      let text = glueSwap(readFileSync(join(tplDir, n), "utf8"), { ...swapOpts, cmake: n.endsWith(".cmake") });
      const dest = renames[n];
      if (n === tplFile) {
        text = stripGolden(text, id);
        const g = stripGated(text);
        if (g.reason) {
          text = g.text; res.templateGate = g.reason;
          job.log(`the template ${tplId} is GATED ("${g.reason}"): the scaffold is not; check the new firmware for the same material (gating it is the owner's call)`);
        }
        if (tpl.version) text = text.replace(new RegExp(`(\\bVERSION\\s+)${tpl.version.replace(/\./g, "\\.")}\\b`, "g"), `$1${ver}`);
        const tTom = [wt, cfg.worktree].map((w) => join(w, tpl.submodule, "app", "fm1.toml")).find((f) => existsSync(f)) || "", nTom = join(wt, subPath, "app", "fm1.toml");
        if (d.family === "fm1base" && existsSync(tTom) && existsSync(nTom)) {
          const f = fm1baseFromToml(text, { tpl: readFm1Toml(readFileSync(tTom, "utf8")), neu: readFm1Toml(readFileSync(nTom, "utf8")), ver });
          text = f.text; res.fromToml = f.notes;
          for (const x of f.notes) job.log(`fm1.toml: ${x}`);
        }
        text = text.replace(/(\bLICENSE\s+)\S+/, `$1${spdx}`);
        // the .rfm1 line: the new firmware's own authors and licence texts (never the template's LICENSE_FILES)
        const lics = licenseFilesOf(join(wt, subPath), spdx);
        const q = (x) => `"${String(x).replace(/"/g, "'")}"`;
        const line = `fm1_add_rfm1(${id} AUTHORS ${q(author)}${lics.length ? `\n             LICENSE_FILES ${lics.map(q).join("\n                           ")}` : ""})`;
        const at = callSpan(text, "fm1_add_rfm1");
        text = at ? text.slice(0, at[0]) + line + text.slice(at[1]) : `${text.replace(/\s*$/, "\n")}${line}\n`;
        res.licenseFiles = lics;
        text = `# SPDX-License-Identifier: GPL-3.0-only\n# ${d.name} (${d.url}${d.upstream.tag ? `, tag ${d.upstream.tag}` : ""}; ${spdx}): scaffolded by RFM1Manager from ${tplId}'s glue (${folder}); review it\n` + text.replace(/^# SPDX-License-Identifier: GPL-3.0-only\n/, "");
      }
      writeFileSync(join(tplDir, dest), text);
      written.push(`${folder}/${dest}`);
    }
    res.glueFiles = written;
    job.log(`scaffolded ${written.join(", ")} from ${tplId}`);
    // GEN: what the new firmware's generator writes, not the template's list
    const cmRel = written.find((f) => f.endsWith(".cmake"));
    if (cmRel) res.gen = await fixGenList(job, wt, cmRel, join(wt, subPath));
    // every #include / SOURCE / UNIT / DESC / EXTRA_SOURCES / INCLUDES path of the new glue must exist
    res.unresolved = unresolvedRefs(wt, folder, written, subPath);
    for (const u of res.unresolved) job.log(`unresolved: ${u}`);
    const title = `scaffold from ${tplId}'s glue (${d.slug} ${d.upstream.tag || "default branch"}), by RFM1Manager`;
    const sub = { ...job, dir: null, wavDir: job.dir, log: job.log, commands: job.commands, lines: job.lines };
    let b;
    if (target !== "manager") {
      // the scratch worktree: committed first (it is recreated per scaffold), then the build try
      await git(wt, ["add", ".gitmodules", subPath, ...written], { log: job.log, commands: job.commands });
      await git(wt, ["commit", "-q", "-m", `${id}: ${title}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`], { log: job.log, commands: job.commands });
      b = await buildCore(sub, id, { wt, branch });
    } else {
      // the manager worktree: committed only when every check passed; else taken out again (the tree stays clean),
      // the scaffolded glue kept in the bundle (glue-scaffold/) for a hand port
      b = await buildCore(sub, id, { wt, branch, prepare: async () => ({ step: "scaffold", files: [".gitmodules", subPath, ...written], title, body: `Template ${tplId} (${folder}); detection: family ${d.family}, similarity ${d.similar?.[0]?.similarity ?? "?"}.` }) });
      if (!b.ok) res.unscaffolded = await unscaffold(job, wt, subPath, written);
    }
    res.build = b; res.ok = b.ok;
    if (!b.ok) job.status = "failed";
  } catch (e) {
    res.ok = false; res.error = e.message; job.status = "failed"; job.log(`ERROR: ${e.message}`);
  } finally {
    await writeAddBundle(job, res);
  }
  return res;
}

// a template's GATED is about the template's own material (orbit's OP-1 port), never the new firmware's: dropped,
// with the reason returned for the log and the summary (the owner decides a new gate)
export function stripGated(text) {
  const m = /\n?[ \t]*\bGATED\s+"((?:[^"\\]|\\.)*)"/.exec(text);
  return m ? { text: text.replace(m[0], ""), reason: m[1] } : { text, reason: null };
}

// fm1.toml's keys the fm1-base glue mirrors (a string or an array of strings per key; the rest is not read)
export function readFm1Toml(text) {
  const out = {};
  for (const m of String(text).matchAll(/^\s*([a-z0-9_]+)\s*=\s*(\[[^\]]*\]|"(?:[^"\\]|\\.)*")/gm)) {
    out[m[1]] = m[2].startsWith("[") ? [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]) : m[2].slice(1, -1);
  }
  return out;
}
const tomlUnits = (t) => ["o2", "os", "oz"].flatMap((k) => (Array.isArray(t[k]) ? t[k] : []));

// An fm1-base template's glue mirrors ITS fm1.toml: the compiled-apart units (o2, os, oz) in a set() list, the
// app's include folders in INCLUDES, the version, the identity (id_prefix + XXYYZZ) and the credits. Each is
// rewritten from the new firmware's fm1.toml; notes say what was (and what could not be) carried over.
export function fm1baseFromToml(text, { tpl, neu, ver }) {
  const notes = [];
  const tu = tomlUnits(tpl), nu = tomlUnits(neu);
  let units = false;
  if (tu.length) {
    text = text.replace(/^(\s*set\(\s*)(\w+)(\s+)([^)]*)\)/gm, (all, a, v, s, body) => {
      const items = cmakeTokens(body);
      if (units || items.length !== tu.length || !items.every((x) => tu.includes(x))) return all;
      units = true;
      notes.push(`units: set(${v}) is the new fm1.toml's o2/os/oz: ${nu.join(" ") || "(none)"} (the template's: ${tu.join(" ")})`);
      return `${a}${v}${s}${nu.join(" ")})`;
    });
  }
  if (!units) notes.push(tu.length ? "units: no set() list matches the template's o2/os/oz: check EXTRA_SOURCES by hand" : "units: the template's fm1.toml lists none");
  // INCLUDES ${X}/app/<dir>: the template's include folders out, the new ones in (after ${X}/app)
  const ti = Array.isArray(tpl.include) ? tpl.include : [], ni = Array.isArray(neu.include) ? neu.include : [];
  text = text.replace(/(\bINCLUDES\s+)([^\n)]*)/, (all, k, body) => {
    const toks = body.trim().split(/\s+/);
    const app = toks.find((x) => /^\$\{\w+\}\/app$/.test(x));
    if (!app) return all;
    const kept = toks.filter((x) => !ti.some((d) => x === `${app}/${d}`));
    const at = kept.indexOf(app) + 1;
    kept.splice(at, 0, ...ni.map((d) => `${app}/${d}`).filter((x) => !kept.includes(x)));
    notes.push(`INCLUDES: app/${ni.join(", app/") || "(no folders)"} (the template's: app/${ti.join(", app/") || "(none)"})`);
    return `${k}${kept.join(" ")}`;
  });
  if (ver) {
    const v3 = ver.split(".").concat(["0", "0"]).slice(0, 3).map((x) => String(parseInt(x, 10) || 0));
    text = text.replace(/^(\s*set\(\s*_\w+_ver\s+)[^)\s]+\)/m, `$1${ver})`);
    text = text.replace(/^(\s*set\(\s*_\w+_app_ver\s+)[^)\s]+\)/m, `$1${v3.join(".")})`);
    if (typeof neu.id_prefix === "string" && /^FM-1_\d+$/.test(neu.id_prefix)) {
      const fid = neu.id_prefix + v3.map((x) => x.padStart(2, "0").slice(-2)).join("");
      text = text.replace(/^(\s*set\(\s*_\w+_id\s+)FM-1_\d+\)/m, (all, a) => { notes.push(`identity: ${fid} (id_prefix ${neu.id_prefix} + XXYYZZ: check the firmware's own release identity)`); return `${a}${fid})`; });
    }
  }
  const who = neu.title || neu.name, cred = [who && neu.author ? `${who} by ${neu.author}.` : "", neu.credits || ""].join(" ").trim().replace(/["\\;]/g, "'");
  if (cred) text = text.replace(/(\bCREDITS\s+)"(?:[^"\\]|\\.)*"/, (all, k) => { notes.push(`CREDITS: from fm1.toml`); return `${k}"${cred}"`; });
  return { text, notes };
}

function stripGolden(text, id) {
  // golden checks reference per-core scripts the scaffold does not have: drop them (and the if(TARGET ..) checks)
  text = text.replace(/^\s*include\([^)]*golden[^)]*\)\s*$/gm, "");
  text = text.replace(/^\s*\w*golden\w*\((?:[^()]|\([^()]*\))*\)\s*$/gm, "");
  text = text.replace(/^if\(TARGET [^)]*\)[\s\S]*?^endif\(\)\s*$/gm, "");
  return text;
}

async function writeAddBundle(job, res) {
  if (!job.dir) return;
  const b = res.build || {};
  const d = res.detect || {};
  // the build half writes the standard files; then the add-firmware summary on top
  await writeBundle(job, { ...b, id: res.id || d.name || "?", wt: res.wt || cfg.worktree, ok: res.ok, error: res.error || b.error, steps: b.steps || {} });
  const excerpt = res.ok ? "" : errorExcerpt(job.lines);
  writeFileSync(join(job.dir, "detect.json"), JSON.stringify(d, null, 1));
  const ex = res.existing;
  const pre = b.prepared;
  const exMd = ex ? `- **Already a core in FM1VST:** \`${ex.id}\` (\`${ex.file}\`, same .gitmodules URL): ${ex.action}, in the manager worktree (no copy scaffolded)${pre ? `; fm1_add_rfm1 AUTHORS "${pre.authors}", ${pre.licenses.length} LICENSE_FILES${pre.memoryMib ? `, MEMORY_MIB ${pre.memoryMib}` : ""}` : ""}${b.bump ? `; update ${b.bump.oldV} -> ${b.bump.newV} (${b.bump.label})` : b.steps?.bump ? `; ${b.steps.bump}` : ""}; ${b.ok ? `committed ${b.bumpCommit ? b.bumpCommit.slice(0, 12) : "(nothing to commit)"}${b.out ? `, ${b.out}` : ""}` : "not committed (the glue and the submodule were put back)"}\n` : "";
  const unres = res.unresolved?.length ? `\n## Unresolved references in the scaffolded glue\n\n${res.unresolved.map((u) => `- ${u}`).join("\n")}\n` : res.glueFiles ? "\nEvery #include / SOURCE / UNIT / DESC / EXTRA_SOURCES / INCLUDES path of the scaffolded glue resolves.\n" : "";
  const md = `# RFM1Manager add-firmware: ${d.slug || res.url} — ${res.mode === "detect" ? "detection only" : res.ok ? (ex ? `${ex.action}: done` : "scaffolded and built") : "FAILED"}

- **Repository:** ${d.url || res.url} (${d.description || "no description"}); owner ${d.owner}; licence ${res.license || d.license || "?"}${res.licenseFile ? ` (\`${res.licenseFile}\`)` : " (no LICENSE file found)"}; fork parent ${d.parent || "none"}
- **Latest stable release:** ${d.upstream?.tag || `none (${d.upstream?.error})`} ${d.upstream?.sha || ""}${d.upstream?.inherited ? ` — **not its own:** ${d.upstream.inherited}` : ""}
- **Detected family:** \`${d.family}\` — closest existing core \`${d.closest}\`; scores ${Object.entries(d.scores || {}).map(([k, v]) => `${k} ${v.score}`).join(", ")}
- **Most similar cores (file layout):** ${(d.similar || []).map((s) => `${s.id} (${s.family}) ${s.similarity}`).join(", ")}
${d.generation ? `- **Base generation:** ${d.generation.base}; the family's cores by base date (days apart + extra glue files): ${d.generation.candidates.map((c) => `${c.id} ${c.date.slice(0, 10)} (${c.score})`).join(", ")}\n` : ""}${res.gen ? `- **GEN:** ${res.gen.ok ? `the new firmware's generate step writes ${res.gen.after.join(" ")} (the template's list was ${res.gen.before.join(" ")})` : `the generate step failed: the template's list (${res.gen.before.join(" ")}) was kept`}\n` : ""}${exMd || (d.alreadyInCatalog?.length ? `- **Already in the catalog as:** ${d.alreadyInCatalog.join(", ")}\n` : "")}${res.id && !res.existing ? `- **Scaffold:** from \`${res.template}\`'s glue, id \`${res.id}\`, submodule \`${res.submodule}\`, worktree \`${res.wt}\` (branch \`${res.branch}\`), glue ${(res.glueFiles || []).map((f) => `\`${f}\``).join(", ")}\n` : ""}${b.steps ? `- **Build steps:** ${Object.entries(b.steps).map(([k, v]) => `${k}: ${v}`).join("; ")}\n` : ""}${res.error ? `- **Error:** ${res.error}\n` : ""}
${res.unscaffolded ? `- **Taken out again** (the manager worktree is ${res.unscaffolded.clean ? "clean" : "NOT clean: check it"}): the scaffolded glue is kept in \`${res.unscaffolded.kept}\`; moved aside: ${res.unscaffolded.moved.join("; ")}\n` : ""}${b.run ? `- **rfm1_run:** ${b.run.line}\n` : ""}${b.manifest ? `- **Manifest:** ${b.manifest.name} ${b.manifest.version}, source_url ${b.manifest.source_url}, ${b.licenses.length} licence text(s), ${b.size} bytes\n` : ""}${res.templateGate ? `- **Template gate not copied:** ${res.templateGate} — check the new firmware for the same material (a gate is the owner's call)\n` : ""}${res.fromToml?.length ? `- **From the new fm1.toml:** ${res.fromToml.join("; ")}\n` : ""}${unres}
${excerpt ? `## First error (with context)\n\n\`\`\`\n${excerpt}\n\`\`\`\n` : ""}
${ex ? `## What to do next\n\n${b.ok ? "Nothing: the core is an .rfm1 at the latest stable release, committed in the manager worktree (not pushed)." : `The core's glue (\`${ex.file}\` and its unit / descriptor) needs a hand port to the new release, following the family's other cores; then Add (or Build with update) again: the enable's edit and the bump are committed only when every check passes.`} Full log: \`${join(job.dir, "build.log")}\`.\n` : `## What to do next

The glue is a copy of \`${d.closest}\`'s with names swapped: the unit (\`core_<id>.c\`) and descriptor (\`core_<id>_desc.c\`)
usually need the new firmware's own entry points, includes, generate step and version source. FM1VST's
\`core-glue/common/README.md\` ("Adding a core") and \`docs/RFM1.md\` describe both. Full log: \`${join(job.dir, "build.log")}\`.
`}
`;
  writeFileSync(join(job.dir, "SUMMARY-FOR-LLM.md"), md);
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The scaffold's rename: only what the glue owns. The submodule path (its prefix; the firmware's own files after it
// stay as they are: `cores/grimm/firmware/src/grimm.c`), the repository slug, the copied glue files' names
// (core_<t>.c, core_<t>_desc.c, <t>_*.c), the glue's identifiers (fm1core_<t>*, FM1CORE_<T>_*, core_<t>*, rfm1_<t>),
// FM1CORE_ID-like "<t>" strings and, in the .cmake, the id as a call's first argument (fm1_add_core(<t>,
// dinghy_core(<t>, ..), its <t>_core / _obj / _hostsim targets and _<t>_* variables. Never an #include of the
// firmware's own files ("grimm.c"), its macros (GRIMM_WEB) or the template's other glue (grimm_hook/).
export function glueSwap(text, { tplId, id, tplSub, subPath, tplSlug, slug, renames = {}, cmake = false }) {
  const keep = [];
  const P = (s) => { keep.push(s); return `\u0001${keep.length - 1}\u0001`; };
  const t = esc(tplId), T = esc(tplId.toUpperCase()), N = "(?![A-Za-z0-9])";
  text = text.replace(new RegExp(`cores/${esc(tplSub)}(?![\\w.-])((?:/[^\\s"')<>;]*)?)`, "g"), (m, rest) => P(`${subPath}${rest}`));
  if (tplSlug) text = text.replace(new RegExp(esc(tplSlug), "gi"), () => P(slug));
  for (const [a, b] of Object.entries(renames)) text = text.replace(new RegExp(`(?<![\\w.-])${esc(a)}(?![\\w.])`, "g"), () => P(b));
  text = text.replace(new RegExp(`\\b(fm1core_|core_|rfm1_)${t}${N}`, "g"), (m, a) => P(a + id));
  text = text.replace(new RegExp(`\\b(FM1CORE_|CORE_)${T}${N}`, "g"), (m, a) => P(a + id.toUpperCase()));
  text = text.replace(new RegExp(`(\\b[A-Z0-9_]*ID\\s*=?\\s*\\\\?")${t}(\\\\?")`, "g"), (m, a, b) => P(a + id + b));
  if (cmake) {
    text = text.replace(new RegExp(`^(\\s*[A-Za-z_]\\w*\\s*\\(\\s*)${t}(?=[\\s)])`, "gm"), (m, a) => P(a + id));
    text = text.replace(new RegExp(`(?<![\\w/])${t}_(core|obj|hostsim)\\b`, "g"), (m, b) => P(`${id}_${b}`));
    text = text.replace(new RegExp(`\\b(gen|golden)_${t}${N}`, "g"), (m, a) => P(`${a}_${id}`));
    text = text.replace(new RegExp(`(\\$\\{|\\bset\\(\\s*)(_?)${t}_(?=\\w)`, "g"), (m, a, u) => P(`${a}${u}${id}_`));
  }
  return text.replace(/\u0001(\d+)\u0001/g, (m, i) => keep[Number(i)]);
}

function cmakeTokens(s) {
  const out = [], re = /"((?:[^"\\]|\\.)*)"|(#[^\n]*)|([^\s#()]+)/g;
  let m;
  while ((m = re.exec(s))) if (m[2] === undefined) out.push(m[1] !== undefined ? m[1] : m[3]);
  return out;
}
const PATH_KEYS = ["SOURCE", "UNIT", "DESC", "EXTRA_SOURCES", "INCLUDES", "CREDITS_FILES"];
const ALL_KEYS = /^[A-Z][A-Z0-9_]+$/;
// every #include "..." (and "x.c" / "x.h" string defines) in the new .c files and every path of fm1_add_core's SOURCE /
// UNIT / DESC / EXTRA_SOURCES / INCLUDES / CREDITS_FILES that resolves to no file: for the summary
export function unresolvedRefs(wt, folder, written, subPath) {
  const out = [], glueDir = join(wt, folder);
  const subFiles = (() => { try { return execList(join(wt, subPath)); } catch { return []; } })();
  const cm = written.find((f) => f.endsWith(".cmake"));
  const cmText = cm ? readFileSync(join(wt, cm), "utf8") : "";
  const vars = { CMAKE_SOURCE_DIR: wt, CMAKE_CURRENT_LIST_DIR: glueDir };
  for (const v of cmText.matchAll(/^\s*set\(\s*(\w+)\s+("(?:[^"\\]|\\.)*"|[^)\s]+)\s*\)/gm)) vars[v[1]] = v[2].replace(/^"|"$/g, "");
  const exp = (p, n = 0) => { const r = p.replace(/\$\{(\w+)\}/g, (m, k) => vars[k] ?? m); return r !== p && n < 5 ? exp(r, n + 1) : r; };
  const incDirs = [glueDir, join(wt, "core-glue", "common"), join(wt, "core-api")];
  let source = join(wt, subPath), generated = /\bGEN(_OUTPUTS)?\b/.test(cmText);
  const m = /fm1_add_core\s*\(([\s\S]*?)\)\s*$/m.exec(cmText);
  if (m) {
    let k = null;
    for (const tok of cmakeTokens(m[1])) {
      if (ALL_KEYS.test(tok)) { k = tok; continue; }
      if (!PATH_KEYS.includes(k)) continue;
      const p = exp(tok);
      if (/\$\{|\$</.test(p)) continue;
      const abs = p.startsWith("/") ? p : k === "CREDITS_FILES" ? join(source, p) : join(glueDir, p);
      if (k === "SOURCE") source = abs;
      if (k === "INCLUDES") incDirs.push(abs);
      if (!existsSync(abs)) out.push(`${cm}: ${k} ${tok}: not found${/\/gen\b|build\//.test(tok) && generated ? " (generated at build time?)" : ""}`);
    }
  }
  // source files named in set() lists (a template that builds its list with foreach: Mutable Dreams' third_party
  // .cc units): each must be somewhere in the new firmware's tree
  for (const v of cmText.matchAll(/^\s*set\(\s*(\w+)\s+([^)]*)\)/gm)) {
    for (const t of cmakeTokens(v[2]).filter((x) => /\.(c|cc|cpp)$/.test(x) && !/[${}<>]/.test(x))) {
      if (!subFiles.some((x) => x === t || x.endsWith("/" + t)) && !existsSync(join(glueDir, t))) out.push(`${cm}: set(${v[1]} .. ${t}): no such file in ${subPath} (the template's source list)`);
    }
  }
  for (const f of written.filter((x) => /\.[ch]$/.test(x))) {
    const text = readFileSync(join(wt, f), "utf8");
    const refs = [...text.matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)].map((x) => x[1])
      .concat([...text.matchAll(/^\s*#\s*define\s+\w+\s+"([^"\s]+\.[ch])"/gm)].map((x) => x[1]));
    for (const r of refs) {
      if (incDirs.some((d) => existsSync(join(d, r)))) continue;
      if (existsSync(join(wt, "core-glue")) && readdirSync(join(wt, "core-glue")).some((d) => existsSync(join(wt, "core-glue", d, r)))) continue;
      const rr = r.replace(/^(\.\.\/)+/, "").replace(new RegExp(`^${esc(subPath)}/`), "");
      if (subFiles.some((s) => s === rr || s.endsWith("/" + rr))) continue;
      out.push(`${f}: #include / path "${r}": no such file in the glue, core-glue/common, core-api, the INCLUDES or ${subPath}`);
    }
  }
  return out;
}
function execList(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      if (n.name === ".git") continue;
      if (n.isDirectory()) walk(join(d, n.name), rel ? `${rel}/${n.name}` : n.name);
      else out.push(rel ? `${rel}/${n.name}` : n.name);
    }
  };
  walk(dir, "");
  return out;
}

// ---- enable an existing core as .rfm1 ----
const LIC_PREFIX = /^(Apache-2\.0|CC-BY-SA-4\.0|CC-BY-4\.0|CC0-1\.0|MIT|OFL(?:-1\.1)?|BSD-\d-Clause|L?GPL-[23]\.0(?:-only|-or-later)?|MPL-2\.0|Zlib|ISC|Unlicense)(?:[-_.]|$)/i;
function spdxOfText(t) {
  if (/SIL OPEN FONT LICENSE[\s\S]{0,80}Version 1\.1/i.test(t)) return "OFL-1.1";
  if (/Apache License[\s,]+Version 2\.0/i.test(t)) return "Apache-2.0";
  if (/CC0 1\.0|Creative Commons Zero|CC0 1\.0 Universal/i.test(t)) return "CC0-1.0";
  if (/Attribution-ShareAlike 4\.0/i.test(t)) return "CC-BY-SA-4.0";
  if (/Attribution 4\.0 International/i.test(t)) return "CC-BY-4.0";
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(t)) return "LGPL";
  if (/GNU GENERAL PUBLIC LICENSE\s+Version 3/i.test(t)) return "GPL-3.0";
  if (/GNU GENERAL PUBLIC LICENSE\s+Version 2/i.test(t)) return "GPL-2.0";
  if (/Mozilla Public License Version 2\.0/i.test(t)) return "MPL-2.0";
  if (/Permission is hereby granted, free of charge/i.test(t)) return "MIT";
  if (/Redistribution and use in source and binary forms/i.test(t)) return "BSD";
  if (/zlib/i.test(t) && /altered source versions must be plainly marked/i.test(t)) return "Zlib";
  return null;
}
// the licence texts an .rfm1 carries, as the family's cores list them: the root LICENSE, LICENSING.md / NOTICE,
// every file in LICENSES/, and licence files elsewhere in the tree (a font's OFL in assets/fonts)
export function licenseFilesOf(srcDir, spdx) {
  const files = execList(srcDir).filter((f) => !/(^|\/)(node_modules|\.github|tests?|docs?\/ui-concept)\//.test(f));
  const out = [];
  const read = (f) => { try { return readFileSync(join(srcDir, f), "utf8").slice(0, 20000); } catch { return ""; } };
  const root = files.find((f) => /^(LICENSE|LICENCE|COPYING)(\.md|\.txt)?$/i.test(f));
  if (root) out.push(`${spdx || spdxOfText(read(root)) || "LICENSE"} ({name})=${root}`);
  for (const f of files.filter((f) => /^(LICENSING|NOTICE|THIRD[_-]PARTY[^/]*)(\.md|\.txt)?$/i.test(f))) out.push(`${f} ({name})=${f}`);
  for (const f of files.filter((f) => /^LICENSES\/[^/]+$/.test(f)).sort()) {
    const stem = f.slice(9).replace(/\.(txt|md)$/i, "");
    const kind = spdxOfText(read(f)) || (LIC_PREFIX.exec(stem) || [])[1] || stem;
    let what = stem.replace(LIC_PREFIX, "").replace(/^[-_.]+/, "");
    if (what === stem) what = stem.replace(new RegExp(`^${esc(kind.split("-")[0])}[-_.]?`, "i"), "");
    out.push(`${kind} (${what && what !== stem ? `${what} in ` : ""}{name})=${f}`);
  }
  for (const f of files.filter((f) => f.includes("/") && !f.startsWith("LICENSES/") && /(^|\/)([^/]*[-_.])?(LICEN[CS]E|OFL|COPYING)([-_.][^/]*)?\.(txt|md)$/i.test(f) && !/\.(c|h|py|js)$/.test(f)).sort()) {
    const base = f.split("/").pop().replace(/\.(txt|md)$/i, "").replace(/[-_.]?(LICEN[CS]E|OFL|COPYING)[-_.]?/i, "");
    const isFont = /fonts?\//i.test(f);
    const kind = spdxOfText(read(f)) || "licence";
    out.push(`${kind} (${base ? `the ${base}${isFont ? " font" : ""} in ` : `${f} in `}{name})=${f}`);
  }
  return out;
}
// the AUTHORS: the glue's CREDITS ("<Name> by <author>, ..."), else the repository owner's GitHub name
export function authorsOf(cmakeText, id, fallback) {
  const c = new RegExp(`fm1_add_core\\s*\\(\\s*${esc(id)}\\b[\\s\\S]*?\\bCREDITS\\s+"((?:[^"\\\\]|\\\\.)*)"`).exec(cmakeText);
  const m = c && /^\s*[^,;:]*?\bby\s+([^,;:()]+?)\s*(?:\(|,|;|:|\.(?:\s|$)|$)/.exec(c[1]);
  return m ? m[1].trim() : fallback;
}
async function enableRfm1(job, core, wt, { author, hostedDespiteGate = null }) {
  // a GATED core: only with the owner's reason (the request's hostedDespiteGate), as HOSTED_DESPITE_GATE
  const hdg = core.gated ? String(hostedDespiteGate || "").replace(/["\\;]/g, "").trim() : "";
  if (core.gated && !hdg) throw new Error(`${core.id} is GATED (${core.gated}): hosting it is the owner's call: give the reason (HOSTED_DESPITE_GATE) with the request, or add fm1_add_rfm1 by hand`);
  const file = join(wt, core.file);
  const text = readFileSync(file, "utf8");
  const src = join(wt, core.source || core.submodule);
  const authors = authorsOf(text, core.id, author);
  const lics = licenseFilesOf(src, core.license);
  const q = (s) => `"${s.replace(/"/g, "'")}"`;
  const line = `# the .rfm1 (cmake/FM1Rfm1.cmake: -DFM1_RFM1=ON; docs/RFM1.md), enabled by RFM1Manager. The licence texts: the
# firmware's own (its LICENSE${lics.some((l) => /=LICENSES\//.test(l)) ? ", LICENSES/" : ""}${lics.some((l) => /=LICENSING/.test(l)) ? ", LICENSING.md" : ""}${lics.some((l) => /font/.test(l)) ? ", the fonts'" : ""})
fm1_add_rfm1(${core.id} AUTHORS ${q(authors)}${hdg ? `\n             HOSTED_DESPITE_GATE ${q(hdg)}` : ""}${lics.length ? `\n             LICENSE_FILES ${lics.map(q).join("\n                           ")}` : ""})
`;
  writeFileSync(file, text.replace(/\s*$/, "\n") + line);
  job.log(`enable as .rfm1: ${core.file}: fm1_add_rfm1(${core.id}) AUTHORS ${q(authors)}, ${lics.length} LICENSE_FILES`);
  for (const l of lics) job.log(`  licence text: ${l}`);
  if (hdg) job.log(`enable as .rfm1: HOSTED_DESPITE_GATE "${hdg}" (gated: ${core.gated}): built with FM1_PUBLIC_BUILD=OFF, hosted only`);
  return { hostedDespiteGate: hdg || null, files: [core.file], title: hdg ? "enable as .rfm1 (hosted despite the gate: the owner's call)" : "enable as .rfm1", body: `fm1_add_rfm1(${core.id}) added by RFM1Manager's Add firmware (the repository is already this core): AUTHORS ${q(authors)}; licence texts:\n${lics.map((l) => `- ${l}`).join("\n")}`, authors, licenses: lics };
}

// is the URL's repository already a core in FM1VST (same .gitmodules URL)? Local only (the glue on the manager branch)
export async function existingCore(url) {
  const slug = ghSlug(url);
  if (!slug) return { slug: null, cores: [] };
  const glue = await scanGlue();
  const cores = Object.values(glue.cores).filter((c) => c.url && (ghSlug(c.url) || "").toLowerCase() === slug.toLowerCase() && !c.orphanRfm1)
    .map((c) => ({ id: c.id, file: c.file, rfm1: !!c.rfm1, gated: c.gated || null, action: c.rfm1 ? "already an .rfm1: update + build" : "enable as .rfm1 + update" }));
  return { slug, ref: glue.ref, cores };
}

// GEN: the headers the NEW firmware's own generate step writes (not the template's list). The step is run once in the
// scaffold, as FM1Cores.cmake runs it (cwd GEN_ROOT, PYTHONPATH=<GEN_ROOT>/tools, the glue's GEN_PYTHON or
// build.generate()), and build/gen is listed; the GEN list in the scaffolded .cmake becomes that list
export async function fixGenList(job, wt, cmakeRel, srcDefault) {
  const file = join(wt, cmakeRel);
  let text = readFileSync(file, "utf8");
  const m = /fm1_add_core\s*\(([\s\S]*?)\)\s*$/m.exec(text);
  if (!m || /\bNO_GEN\b/.test(m[1])) return null;
  const g = /(\bGEN\s+)((?:[\w.\-/]+\.h\b\s*)+)/.exec(m[1]);
  if (!g) return null;
  const vars = {};
  for (const s of text.matchAll(/^\s*set\(\s*(\w+)\s+("(?:[^"\\]|\\.)*"|[^)\s]+)\s*\)/gm)) vars[s[1]] = s[2].replace(/^"|"$/g, "").replace(/\\"/g, '"');
  const exp = (v) => v.replace(/\$\{(\w+)\}/g, (_, k) => k === "CMAKE_SOURCE_DIR" ? wt : vars[k] !== undefined ? exp(vars[k]) : `\${${k}}`);
  const tok = (k) => { const r = new RegExp(`\\b${k}\\s+("(?:[^"\\\\]|\\\\.)*"|\\S+)`).exec(m[1]); return r ? exp(r[1].replace(/^"|"$/g, "")) : null; };
  const src = tok("SOURCE") || srcDefault;
  const groot = join(src, tok("GEN_ROOT") || ".");
  const code = tok("GEN_PYTHON") || "__import__('build').generate()";
  if (!existsSync(join(groot, "tools", "build.py")) && !tok("GEN_PYTHON")) { job.log(`GEN: ${groot}/tools/build.py not found: the GEN list is the template's`); return null; }
  const needs = (/\bPYTHON_NEEDS\s+([\s\S]*?)(?=\s[A-Z_]{3,}\s|\s*$)/.exec(m[1]) || [, ""])[1].split(/\s+/).filter(Boolean);
  const py = await ensureVenv(job, needs);
  const r = await run(py, ["-c", code], { cwd: groot, env: childEnv({ PYTHONPATH: join(groot, "tools"), DYLD_FALLBACK_LIBRARY_PATH: "/opt/homebrew/lib" }), log: job.log, commands: job.commands, timeoutMs: 20 * 60e3 });
  const genDir = join(groot, "build", "gen");
  if (r.code || !existsSync(genDir)) { job.log(`GEN: the generate step failed (exit ${r.code}): the GEN list is the template's`); return { ok: false, before: g[2].trim().split(/\s+/) }; }
  const made = readdirSync(genDir).filter((n) => /\.(h|inc|c)$/.test(n)).sort();
  const before = g[2].trim().split(/\s+/);
  if (!made.length) return { ok: false, before };
  const args = m[1].replace(g[0], `${g[1]}${made.join(" ")} `);
  text = text.slice(0, m.index) + m[0].replace(m[1], args) + text.slice(m.index + m[0].length);
  writeFileSync(file, text);
  job.log(`GEN: the generate step wrote ${made.join(", ")} (the template's list: ${before.join(" ")})`);
  return { ok: true, before, after: made };
}

// a failed scaffold in the manager worktree out again: the glue copied into the bundle, then moved aside with the
// submodule's checkout (scratch/trash), .gitmodules back to HEAD's; the tree is as before the job
async function unscaffold(job, wt, subPath, written) {
  const o = { log: job.log, commands: job.commands };
  const keep = job.dir ? join(job.dir, "glue-scaffold") : null;
  if (keep) mkdirSync(keep, { recursive: true });
  await run("git", ["-C", wt, "reset", "-q", "--", ".gitmodules", subPath, ...written], o);
  writeFileSync(join(wt, ".gitmodules"), await git(wt, ["show", "HEAD:.gitmodules"]));
  const moved = [];
  for (const f of written) {
    if (keep && existsSync(join(wt, f))) writeFileSync(join(keep, f.split("/").pop()), readFileSync(join(wt, f)));
    moved.push(`${f} -> ${moveAside(join(wt, f))}`);
  }
  moved.push(`${subPath} -> ${moveAside(join(wt, subPath))}`);
  for (const m of moved) job.log(`(scaffold taken out: ${m})`);
  const st = (await run("git", ["-C", wt, "status", "--short"])).out.trim();
  if (st) job.log(`warning: the manager worktree is not clean after the scaffold was taken out:\n${st}`);
  return { kept: keep, moved, clean: !st };
}

// [start, end) of the first `name(...)` call: quotes and nested parentheses ("({name})") respected
export function callSpan(text, name) {
  const m = new RegExp(`\\b${name}\\s*\\(`).exec(text);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1, inq = false;
  for (; i < text.length && depth; i++) {
    const c = text[i];
    if (c === '"' && text[i - 1] !== "\\") inq = !inq;
    else if (!inq && c === "#") { while (i < text.length && text[i] !== "\n") i++; }
    else if (!inq && c === "(") depth++;
    else if (!inq && c === ")") depth--;
  }
  return [m.index, i];
}
