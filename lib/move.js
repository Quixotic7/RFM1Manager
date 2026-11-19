// SPDX-License-Identifier: GPL-3.0-only
// The Move catalog (RemoteFM14Move: FM-1 firmwares on the Ableton Move). Each .rfm1 of the catalog gets a native
// linux-aarch64 build (.rfm1m); the Move downloads them from a signed index.json on a GitHub release (tag
// move-catalog). The work is the remoteFM14Move checkout's own tools, never copied here:
//   make catalog                       builds (cached per .rfm1 sha256: only new or changed firmwares), checks, signs
//                                      dist/move-catalog/index.json, writes dist/move-catalog-report.{md,json}
//   tools/publish_move_catalog.py      uploads only the files the release lacks (by sha256), then the signature and
//                                      the index, back to back; --dry-run plans; --prune deletes old versions
// The signing key stays in ~/.config/remotefm14move/ (make catalog reads it there): the manager never reads, shows or
// uploads it; it only says whether the file is there.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { cfg, run } from "./util.js";

const repoDir = () => cfg.moveRepo || join(cfg.fm1vst, "..", "remoteFM14Move");
const GH = () => cfg.moveGh || "Quixotic7/remoteFM14Move";
const TAG = () => cfg.moveTag || "move-catalog";
const DIST = () => join(repoDir(), "dist", "move-catalog");
const KEY = () => process.env.CATALOG_SIGNING_KEY || join(homedir(), ".config", "remotefm14move", "catalog-signing-key.pem");
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch (_) { return null; } };

// one Move job at a time (make catalog and the upload share dist/); separate from the FM1VST build lock
let busy = null;
export const moveBusy = () => busy;
export function moveLock(id) {
  if (busy) throw Object.assign(new Error(`a Move catalog job is running (job ${busy})`), { status: 409 });
  busy = id;
}
export const moveUnlock = (id) => { if (busy === id) busy = null; };

// the release's assets: name -> sha256 (GitHub's digest) and the index the Move sees now; null: no such release
async function releaseState() {
  const r = await run("gh", ["api", `repos/${GH()}/releases/tags/${TAG()}`]);
  if (r.code !== 0) {
    if (/Not Found/.test(r.err + r.out)) return null;
    throw new Error(`gh: the release ${GH()} ${TAG()}: ${(r.err || r.out).trim().slice(0, 300)}`);
  }
  const rel = JSON.parse(r.out);
  const assets = {};
  for (let page = 1; ; page++) {
    const a = await run("gh", ["api", `repos/${GH()}/releases/${rel.id}/assets?per_page=100&page=${page}`]);
    if (a.code !== 0) throw new Error(`gh: the release's assets: ${a.err.trim().slice(0, 300)}`);
    const batch = JSON.parse(a.out);
    for (const x of batch) assets[x.name] = { sha256: (x.digest || "").replace(/^sha256:/, "") || null, size: x.size, id: x.id };
    if (batch.length < 100) break;
  }
  let index = null;
  if (assets["index.json"]) {
    const d = await run("gh", ["release", "download", TAG(), "-R", GH(), "-p", "index.json", "-O", "-"]);
    if (d.code === 0) try { index = JSON.parse(d.out); } catch (_) { /* a bad index: shown as none */ }
  }
  return { url: rel.html_url, assets, index };
}

// the live RemoteFM1 catalog's .rfm1 versions (what make catalog builds from)
async function liveCatalog() {
  try {
    const r = await fetch(`${cfg.rfm1Feed}?x=${Date.now()}`, { cache: "no-store" });
    const c = await r.json();
    return { generated: c.generated || null,
      sha: Object.fromEntries(c.firmwares.filter((f) => f.rfm1?.sha256).map((f) => [f.id, f.rfm1.sha256])),
      fw: Object.fromEntries(c.firmwares.filter((f) => f.rfm1?.file).map((f) => [f.id, { name: f.name, version: f.rfm1.version || null, file: f.rfm1.file.split("/").pop() }])) };
  } catch (e) { return { error: e.message, fw: {} }; }
}

// the version an .rfm1 file name carries (<id>-<version>.rfm1)
const verOfFile = (id, file) => file?.startsWith(`${id}-`) ? file.slice(id.length + 1).replace(/\.rfm1$/, "") : null;

export async function moveStatus() {
  const dir = repoDir();
  if (!existsSync(join(dir, "Makefile"))) return { ok: false, error: `no remoteFM14Move checkout at ${dir} (config.json moveRepo)` };
  const local = readJson(join(DIST(), "index.json"));
  const report = readJson(join(dir, "dist", "move-catalog-report.json"));
  const [rel, live] = await Promise.all([releaseState().catch((e) => ({ error: e.message })), liveCatalog()]);
  const assets = rel?.assets || {};
  const relFw = Object.fromEntries((rel?.index?.firmwares || []).map((f) => [f.id, f]));
  const leftOut = Object.fromEntries((report?.left_out || []).map((f) => [f.id, f]));
  // the Move index names each firmware's source .rfm1 (file + sha256): matched to the catalog by that file's name (ids
  // can differ: the catalog's krisjangle is kris_jangle-*.rfm1), else by id
  const locals = local?.firmwares || [];
  const byFile = Object.fromEntries(Object.entries(live.fw).map(([cid, c]) => [c.file, cid]));
  const catIdOf = (l) => byFile[l.rfm1?.file] || (live.fw[l.id] ? l.id : null);
  const pairs = new Map(); // row key -> { cid, l }
  for (const [cid] of Object.entries(live.fw)) pairs.set(cid, { cid, l: null });
  for (const l of locals) {
    const cid = catIdOf(l);
    if (cid && pairs.has(cid)) pairs.get(cid).l = l;
    else if (!cid && [...pairs.values()].some((p) => p.l?.id === l.id)) continue;
    else pairs.set(cid || `move:${l.id}`, { cid, l });
  }
  for (const id of Object.keys(relFw)) if (![...pairs.values()].some((p) => (p.l?.id || p.cid) === id)) pairs.set(`move:${id}`, { cid: null, l: null, rid: id });
  const rows = [];
  let pendingFiles = 0, pendingBytes = 0;
  for (const [, { cid, l, rid }] of [...pairs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const id = l?.id || rid || cid;
    const cat = cid ? live.fw[cid] : null;
    const catVer = cat ? (cat.version || verOfFile(cid, cat.file)) : null;
    const pend = (l?.files || []).filter((f) => assets[f.name]?.sha256 !== f.sha256);
    for (const f of pend) { pendingFiles++; try { pendingBytes += statSync(join(DIST(), f.name)).size; } catch (_) { /* counted without a size */ } }
    const lo = leftOut[id] || (cid && leftOut[cid]) || Object.values(leftOut).find((x) => cat && x.name === cat.name);
    let state;
    if (lo && !l && (!catVer || lo.version === catVer)) state = "left out";
    else if (cat && (!l || (l.rfm1?.sha256 && live.sha?.[cid] && l.rfm1.sha256 !== live.sha[cid]) || (catVer && l.version !== catVer))) state = "needs build";
    else if (!cat && l) state = "not in the catalog";
    else if (pend.length || !rel || !relFw[id] || relFw[id].version !== l?.version) state = "pending upload";
    else state = "live";
    rows.push({ id, name: l?.name || cat?.name || lo?.name || id, catalog: catVer, built: l?.version || null, live: relFw[id]?.version || null,
      pending: pend.length, state, why: lo?.why?.trim() || null });
  }
  const wanted = new Set((local?.firmwares || []).flatMap((f) => f.files.map((x) => x.name)));
  const stale = Object.keys(assets).filter((n) => !wanted.has(n) && n !== "index.json" && n !== "index.json.sig");
  // the index's firmwares changed (a rerun of make catalog with nothing new only restamps `generated`: not an update)
  const indexPending = !!local && (!rel?.index || JSON.stringify(rel.index.firmwares) !== JSON.stringify(local.firmwares));
  const indexRestamped = !!local && !!rel?.index && !indexPending && rel.index.generated !== local.generated;
  const count = (s) => rows.filter((r) => r.state === s).length;
  return {
    ok: true, repo: dir, gh: GH(), tag: TAG(), release: rel ? (rel.error ? { error: rel.error } : { url: rel.url, assets: Object.keys(assets).length }) : null,
    key: existsSync(KEY()), busy,
    local: local ? { generated: local.generated, catalog: local.catalog_generated || report?.catalog || null, firmwares: local.firmwares.length } : null,
    report: report ? { generated: report.generated, catalog: report.catalog, tried: report.tried, passed: report.passed, leftOut: (report.left_out || []).length, seconds: report.seconds } : null,
    live: { generated: live.generated, error: live.error, firmwares: Object.keys(live.fw).length },
    summary: { needsBuild: count("needs build"), pendingUpload: count("pending upload"), live: count("live"), leftOut: count("left out"),
      pendingFiles, pendingBytes, indexPending, indexRestamped, stale: stale.length },
    firmwares: rows,
  };
}

// make catalog (Docker): only new or changed firmwares are built, the rest come from its cache
export async function moveBuild(job) {
  const dir = repoDir();
  if (!existsSync(KEY())) throw new Error("no Move catalog signing key in ~/.config/remotefm14move/ (make catalog signs index.json with it)");
  const d = await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (d.code !== 0) throw new Error("Docker is not running (make catalog builds the .rfm1m files in its image)");
  const r = await run("make", ["catalog"], { cwd: dir, log: job.log, commands: job.commands });
  if (r.code !== 0) throw new Error(`make catalog: exit ${r.code}`);
  const rep = join(dir, "dist", "move-catalog-report.md");
  if (existsSync(rep)) { job.log(""); for (const l of readFileSync(rep, "utf8").split("\n")) job.log(l); }
  const report = readJson(join(dir, "dist", "move-catalog-report.json"));
  return { report: report ? { generated: report.generated, catalog: report.catalog, tried: report.tried, passed: report.passed,
    leftOut: (report.left_out || []).map((f) => ({ id: f.id, version: f.version, why: f.why?.trim() })) } : null };
}

// the delta upload (a dry run plans; a real one needs the owner's confirm upstream of this call)
export async function movePublish(job, { dryRun = true, prune = false } = {}) {
  const args = ["tools/publish_move_catalog.py", "--dir", "dist/move-catalog", "--repo", GH(), "--tag", TAG()];
  if (dryRun) args.push("--dry-run");
  if (prune) args.push("--prune");
  const r = await run("python3", args, { cwd: repoDir(), log: job.log, commands: job.commands });
  if (r.code !== 0) throw new Error(`publish_move_catalog.py: exit ${r.code}: ${(r.err || r.out).trim().split("\n").pop()}`);
  return { dryRun, prune, out: r.out.trim() };
}
