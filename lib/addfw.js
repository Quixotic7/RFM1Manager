// SPDX-License-Identifier: GPL-3.0-only
// Add a firmware from a GitHub URL: detect its base family by comparing it with the cores FM1VST already builds
// (file layout similarity + markers + fork parent), pick the closest core, scaffold submodule + glue + fm1_add_rfm1
// from it, try a build. Detection-only mode writes the bundle and touches no worktree.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cfg, run, runOk, git, moveAside } from "./util.js";
import { ghSlug, upstreamLatest, scanGlue } from "./catalog.js";
import { ensureWorktree, buildCore, writeBundle, errorExcerpt } from "./build.js";

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
  const up = await upstreamLatest(slug, true);
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
  const closest = sims.find((s) => s.folder === fam[0]) || sims[0];
  return {
    slug, url: `https://github.com/${slug}`, name: info.name, description: info.description, owner: info.owner.login,
    license: info.license?.spdx_id && info.license.spdx_id !== "NOASSERTION" ? info.license.spdx_id : null,
    parent: info.parent?.full_name || null, upstream: up, ref, files: paths.length,
    family: fam[0], familyFolder: fam[0], closest: closest?.id || null, scores, similar: sims.slice(0, 6),
    alreadyInCatalog: sims.filter((s) => s.same).map((s) => s.id),
  };
}
function re0(fam) {
  return { felucca_web: /felucca/i, sloop: /sloop/i, dinghy: /zvenson|vave/i, fm1base: /fm1-base|charlesvestal/i, choralroot: /choralroot/i, melodee: /melodee/i, plat: /fm1-(fomni|x0x|fimba)/i, speak37: /speak/i }[fam] || /^$/;
}

const SPDX = { "GPL-3.0": "GPL-3.0-only", "GPL-2.0": "GPL-2.0-only", "LGPL-3.0": "LGPL-3.0-only" };

// scaffold from the closest core, into a scratch worktree (default) or the manager worktree; then build
export async function addFirmware(job, { url, id, mode = "detect", target = "scratch", template }) {
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
    if (mode === "detect") { job.log("detection only: nothing scaffolded"); res.ok = true; return res; }

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
    // paths and URLs first (they contain the template's id), then the id itself
    const swap = (s) => s.replaceAll(`cores/${tplSub}`, "\u0001SUB\u0001").replaceAll(ghSlug(tpl.url) || "\u0002", "\u0001SLUG\u0001")
      .replace(new RegExp(`(?<![A-Za-z0-9])${tplId}(?![A-Za-z0-9])`, "g"), id)
      .replace(new RegExp(`(?<![A-Za-z0-9])${tplId.toUpperCase()}(?![A-Za-z0-9])`, "g"), id.toUpperCase())
      .replaceAll("\u0001SUB\u0001", subPath).replaceAll("\u0001SLUG\u0001", d.slug);
    const written = [];
    const tplFile = tpl.file.split("/").pop();
    if (tplFile === "core.cmake") throw new Error(`${tplId}'s glue is a folder-wide core.cmake: scaffold by hand (template ${folder})`);
    for (const n of readdirSync(tplDir)) {
      if (!(n === tplFile || n === `core_${tplId}.c` || n === `core_${tplId}_desc.c` || n.startsWith(`${tplId}_`) && n.endsWith(".c"))) continue;
      let text = swap(readFileSync(join(tplDir, n), "utf8"));
      // every whole-word use of the template id in the name (amb_amb.c -> <id>_<id>.c), as the swap does in the text
      let dest = n.replace(new RegExp(`(?<![A-Za-z0-9])${tplId}(?![A-Za-z0-9])`, "g"), id);
      if (n === tplFile) {
        text = stripGolden(text, id);
        if (tpl.version) text = text.replace(new RegExp(`(\\bVERSION\\s+)${tpl.version.replace(/\./g, "\\.")}\\b`, "g"), `$1${ver}`);
        text = text.replace(/(\bLICENSE\s+)\S+/, `$1${spdx}`);
        text = text.replace(/fm1_add_rfm1\([^)]*\)/s, `fm1_add_rfm1(${id} AUTHORS "${author.replace(/"/g, "")}")`);
        if (!/fm1_add_rfm1\(/.test(text)) text += `\nfm1_add_rfm1(${id} AUTHORS "${author.replace(/"/g, "")}")\n`;
        text = `# SPDX-License-Identifier: GPL-3.0-only\n# ${d.name} (${d.url}${d.upstream.tag ? `, tag ${d.upstream.tag}` : ""}; ${spdx}): scaffolded by RFM1Manager from ${tplId}'s glue (${folder}); review it\n` + text.replace(/^# SPDX-License-Identifier: GPL-3.0-only\n/, "");
      }
      writeFileSync(join(tplDir, dest), text);
      written.push(`${folder}/${dest}`);
    }
    res.glueFiles = written;
    job.log(`scaffolded ${written.join(", ")} from ${tplId}`);
    await git(wt, ["add", ".gitmodules", subPath, ...written], { log: job.log, commands: job.commands });
    await git(wt, ["commit", "-q", "-m", `${id}: scaffold from ${tplId}'s glue (${d.slug} ${d.upstream.tag || "default branch"}), by RFM1Manager\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`], { log: job.log, commands: job.commands });
    // ---- the build try, same bundle ----
    const b = await buildCore({ ...job, dir: null, log: job.log, commands: job.commands, lines: job.lines }, id, { wt, branch });
    res.build = b; res.ok = b.ok;
    if (!b.ok) job.status = "failed";
  } catch (e) {
    res.ok = false; res.error = e.message; job.status = "failed"; job.log(`ERROR: ${e.message}`);
  } finally {
    await writeAddBundle(job, res);
  }
  return res;
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
  const md = `# RFM1Manager add-firmware: ${d.slug || res.url} — ${res.mode === "detect" ? "detection only" : res.ok ? "scaffolded and built" : "FAILED"}

- **Repository:** ${d.url || res.url} (${d.description || "no description"}); owner ${d.owner}; licence ${res.license || d.license || "?"}${res.licenseFile ? ` (\`${res.licenseFile}\`)` : " (no LICENSE file found)"}; fork parent ${d.parent || "none"}
- **Latest stable release:** ${d.upstream?.tag || `none (${d.upstream?.error})`} ${d.upstream?.sha || ""}
- **Detected family:** \`${d.family}\` — closest existing core \`${d.closest}\`; scores ${Object.entries(d.scores || {}).map(([k, v]) => `${k} ${v.score}`).join(", ")}
- **Most similar cores (file layout):** ${(d.similar || []).map((s) => `${s.id} (${s.family}) ${s.similarity}`).join(", ")}
${d.alreadyInCatalog?.length ? `- **Already in the catalog as:** ${d.alreadyInCatalog.join(", ")}\n` : ""}${res.id ? `- **Scaffold:** from \`${res.template}\`'s glue, id \`${res.id}\`, submodule \`${res.submodule}\`, worktree \`${res.wt}\` (branch \`${res.branch}\`), glue ${(res.glueFiles || []).map((f) => `\`${f}\``).join(", ")}\n` : ""}${b.steps ? `- **Build steps:** ${Object.entries(b.steps).map(([k, v]) => `${k}: ${v}`).join("; ")}\n` : ""}${res.error ? `- **Error:** ${res.error}\n` : ""}
${excerpt ? `## First error (with context)\n\n\`\`\`\n${excerpt}\n\`\`\`\n` : ""}
## What to do next

The glue is a copy of \`${d.closest}\`'s with names swapped: the unit (\`core_<id>.c\`) and descriptor (\`core_<id>_desc.c\`)
usually need the new firmware's own entry points, includes, generate step and version source. FM1VST's
\`core-glue/common/README.md\` ("Adding a core") and \`docs/RFM1.md\` describe both. Full log: \`${join(job.dir, "build.log")}\`.
`;
  writeFileSync(join(job.dir, "SUMMARY-FOR-LLM.md"), md);
}
