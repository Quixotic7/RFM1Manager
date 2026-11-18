// SPDX-License-Identifier: GPL-3.0-only
// RFM1Manager: a local web app for the RemoteFM1 .rfm1 firmware catalog. Plain Node http, no dependencies.
// Serves on 127.0.0.1 only and never opens a browser (headless).
import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { cfg, APP, run } from "./lib/util.js";
import { catalog, upstreamLatest, scanGlue, ghSlug } from "./lib/catalog.js";
import { startJob, getJob, listJobs, view, cancelJob } from "./lib/jobs.js";
import { buildCore, glueOnDisk } from "./lib/build.js";
import { addFirmware, detect, existingCore } from "./lib/addfw.js";
import { readMeta, setMeta, setImage, imagePath, importRemoteFM1, applyAuthorMeta, applyHubMeta, clearOverride, SCHEMA_MD } from "./lib/meta.js";
import { hubCatalog, hubEntryFor, hubCard } from "./lib/hub.js";
import { readAuthorMeta, gitSource, summary as authorSummary } from "./lib/authormeta.js";
import { readPins, setPin } from "./lib/target.js";
import { readReadme, saveReadme, refreshReadme } from "./lib/readme.js";
import { collectFiles, stage, readPreview, publish, initCurrent, ROLLING } from "./lib/publish.js";
import { siteStatus, refreshSite, siteFile, ensureSiteCurrent } from "./lib/site.js";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".json": "application/json", ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8", ".wav": "audio/wav", ".svg": "image/svg+xml",
  ".mjs": "text/javascript; charset=utf-8", ".wasm": "application/wasm", ".rfm1": "application/wasm", ".woff": "font/woff", ".woff2": "font/woff2" };

const send = (res, code, body, type = "application/json") => {
  const b = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 1);
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(b);
};
const body = (req, limit = 2 * 1048576) => new Promise((ok, bad) => {
  const chunks = []; let n = 0;
  req.on("data", (c) => { n += c.length; if (n > limit) { bad(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
  req.on("end", () => ok(Buffer.concat(chunks)));
  req.on("error", bad);
});
const json = async (req) => { const b = await body(req); return b.length ? JSON.parse(b.toString("utf8")) : {}; };

const routes = [];
const route = (method, re, fn) => routes.push({ method, re, fn });

route("GET", /^\/api\/config$/, () => ({ ...cfg, schema: SCHEMA_MD }));
route("GET", /^\/api\/catalog$/, (req, q) => catalog({ upstream: q.get("upstream") === "1", force: q.get("force") === "1" }));
route("GET", /^\/api\/upstream\/([a-z0-9_]+)$/, async (req, q, [, id]) => {
  const g = (await scanGlue()).cores[id];
  if (!g) throw Object.assign(new Error(`no glue for ${id}`), { status: 404 });
  return { id, pin: g.pin, version: g.version, upstream: await upstreamLatest(ghSlug(g.url), q.get("force") === "1") };
});

// builds: one at a time (one worktree)
route("POST", /^\/api\/build$/, async (req) => {
  const { id, update = false } = await json(req);
  if (!/^[a-z0-9_]{1,31}$/.test(id || "")) throw Object.assign(new Error("bad id"), { status: 400 });
  const j = startJob("build", `${update ? "update" : "rebuild"}-${id}`, (job) => buildCore(job, id, { update: !!update }), { exclusive: true, queue: true });
  return view(j);
});
route("POST", /^\/api\/build-all$/, async (req) => {
  const { update = false, ids } = await json(req);
  const cat = await catalog({ upstream: !!update });
  const list = ids || cat.firmwares.filter((f) => f.glue?.rfm1 && (!update || f.updateAvailable)).map((f) => f.id);
  const j = startJob("build-all", `${update ? "update" : "rebuild"}-all`, async (job) => {
    const results = [];
    for (const id of list) {
      const sub = startJob("build", `${update ? "update" : "rebuild"}-${id}`, (sj) => buildCore(sj, id, { update: !!update }));
      job.log(`${id}: job ${sub.id}, bundle ${sub.dir}`);
      while (sub.status === "running") await new Promise((r) => setTimeout(r, 1000));
      results.push({ id, job: sub.id, status: sub.status, bundle: sub.dir });
      job.log(`${id}: ${sub.status}`);
    }
    if (results.some((r) => r.status !== "ok")) job.status = "failed";
    return { results };
  }, { exclusive: true, bundle: false, queue: true });
  return { ...view(j), ids: list };
});
// the owner's pins (lib/target.js): { tag } / { ignoreTarget } / { allowDowngrade }; {} clears
route("GET", /^\/api\/pins$/, () => readPins());
route("PUT", /^\/api\/pins\/([a-z0-9_]+)$/, async (req, q, [, id]) => ({ id, pin: setPin(id, await json(req)) }));
route("GET", /^\/api\/jobs$/, () => listJobs());
// a queued build or add taken out of the queue (a running job is not stopped)
route("DELETE", /^\/api\/jobs\/(\d+)$/, (req, q, [, id]) => {
  if (!cancelJob(id)) throw Object.assign(new Error(`job ${id} is not queued`), { status: 409 });
  return view(getJob(id));
});
route("GET", /^\/api\/jobs\/(\d+)$/, (req, q, [, id]) => {
  const j = getJob(id);
  if (!j) throw Object.assign(new Error("no such job"), { status: 404 });
  return view(j, Number(q.get("since") || 0));
});

// log bundles
route("GET", /^\/api\/logs$/, () => readdirSync(cfg.logs).filter((n) => statSync(join(cfg.logs, n)).isDirectory()).sort().reverse()
  .map((n) => {
    let r = null; try { r = JSON.parse(readFileSync(join(cfg.logs, n, "result.json"), "utf8")); } catch (_) {}
    return { name: n, files: readdirSync(join(cfg.logs, n)), ok: r ? !!r.ok : null };
  }));
route("GET", /^\/api\/logs\/([^/]+)\/([^/]+)$/, (req, q, [, d, f], res) => {
  const p = normalize(join(cfg.logs, d, f));
  if (!p.startsWith(cfg.logs + "/") || !existsSync(p)) throw Object.assign(new Error("not found"), { status: 404 });
  send(res, 200, readFileSync(p), MIME[extname(p)] || "text/plain; charset=utf-8");
});

// add firmware
route("POST", /^\/api\/add$/, async (req) => {
  const a = await json(req);
  if (!ghSlug(a.url)) throw Object.assign(new Error("a https://github.com/<owner>/<repo> URL"), { status: 400 });
  const mode = a.mode === "scaffold" ? "scaffold" : "detect";
  const j = startJob("add", `add-${mode}-${ghSlug(a.url).replace("/", "_")}`, (job) => addFirmware(job, { ...a, mode }), { exclusive: mode === "scaffold", queue: true });
  return view(j);
});
route("GET", /^\/api\/detect$/, (req, q) => detect(q.get("url")));
route("GET", /^\/api\/existing$/, (req, q) => existingCore(q.get("url")));

// catalog metadata
route("GET", /^\/api\/meta$/, () => readMeta());
// when each firmware was last added or updated: the newest manager-branch commit to its glue (core-glue/*/core_<id>.cmake)
route("GET", /^\/api\/meta\/updated$/, async () => {
  const r = await run("git", ["-C", cfg.worktree, "log", "--format=@%cI", "--name-only", "--", "core-glue"]);
  const out = {};
  let date = null;
  for (const l of r.out.split("\n")) {
    if (l.startsWith("@")) date = l.slice(1);
    else { const m = /^core-glue\/[^/]+\/core_([a-z0-9_]+)\.cmake$/.exec(l); if (m && date && !out[m[1]]) out[m[1]] = date; }
  }
  return out;
});
route("POST", /^\/api\/meta-import$/, async (req) => { const b = await json(req); return importRemoteFM1((await catalog()).firmwares.map((f) => f.id), !!b.overwrite); });
route("PUT", /^\/api\/meta\/([a-z0-9_]+)$/, async (req, q, [, id]) => setMeta(id, await json(req)));
route("POST", /^\/api\/meta\/([a-z0-9_]+)\/image$/, async (req, q, [, id]) => setImage(id, await body(req, 1048576 + 1)));
// the firmware's own RemoteFM1Metadata.json: its submodule in the manager worktree (checked out by a build)
async function firmwareRepo(id) {
  const core = await glueOnDisk(cfg.worktree, id);
  if (!core?.submodule) throw Object.assign(new Error(`no glue with a submodule for ${id}`), { status: 404 });
  const dir = join(cfg.worktree, core.submodule);
  if (!existsSync(join(dir, ".git"))) throw Object.assign(new Error(`${core.submodule} is not checked out: build ${id} once`), { status: 409 });
  return { core, dir };
}
// read it again now (at the submodule's checked-out commit, the one last built, or body.commit) and update the card
route("POST", /^\/api\/meta\/([a-z0-9_]+)\/author-read$/, async (req, q, [, id]) => {
  const b = await json(req);
  const { dir } = await firmwareRepo(id);
  const sha = (await run("git", ["-C", dir, "rev-parse", "--verify", "-q", `${b.commit || "HEAD"}^{commit}`])).out.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw Object.assign(new Error(`no commit ${b.commit || "HEAD"} in ${dir}`), { status: 400 });
  const r = await readAuthorMeta(dir, sha);
  const applied = applyAuthorMeta(id, r);
  return { read: authorSummary(r), applied, card: readMeta().firmwares[id] || null };
});
// the Hub's fmhub.json as a fallback for every built firmware's card (or body.ids): fills only free fields
route("POST", /^\/api\/meta\/hub-fill$/, async (req) => {
  const b = await json(req);
  const hub = await hubCatalog(true);
  if (!hub.firmwares?.length) throw Object.assign(new Error(`the Hub's catalog could not be read: ${(hub.errors || []).join("; ")}`), { status: 502 });
  const cores = Object.values((await scanGlue()).cores).filter((c) => c.rfm1);
  const want = Array.isArray(b.ids) ? new Set(b.ids) : null, report = {};
  for (const c of cores) {
    const id = c.id;
    if (want && !want.has(id)) continue;
    const notes = [];
    const r = await applyHubMeta(id, hubCard(hubEntryFor(hub, id, ghSlug(c.url))), (n) => notes.push(n));
    if (r.changed || notes.length) report[id] = notes;
  }
  return { from: hub.from, updated: hub.updated, changed: report };
});
route("POST", /^\/api\/meta\/([a-z0-9_]+)\/clear-override$/, async (req, q, [, id]) => {
  const { field } = await json(req);
  return clearOverride(id, String(field || ""), async (commit, path) => {
    const f = await gitSource((await firmwareRepo(id)).dir, commit)(path, 1048576);
    if (f.error) throw new Error(`${path} at ${commit.slice(0, 12)}: ${f.error}`);
    return f.buf;
  });
});
route("GET", /^\/api\/meta\/(images\/[a-z0-9_]+\.(?:png|jpg|webp))$/, (req, q, [, rel], res) => {
  const p = imagePath(rel);
  if (!p || !existsSync(p)) throw Object.assign(new Error("not found"), { status: 404 });
  send(res, 200, readFileSync(p), MIME[extname(p)]);
});

// README
route("GET", /^\/api\/readme$/, () => ({ md: readReadme() }));
route("PUT", /^\/api\/readme$/, async (req) => { const { md } = await json(req); if (typeof md !== "string" || !md.trim()) throw new Error("empty README"); saveReadme(md); return { saved: true }; });
route("POST", /^\/api\/readme\/refresh$/, async (req) => {
  const { md } = await json(req);
  const { files } = await collectFiles();
  const g = (await scanGlue()).cores;
  return { md: await refreshReadme(md ?? readReadme(), files.filter((f) => !f.error).map((f) => ({ ...f, hostedDespiteGate: g[f.id]?.rfm1?.hostedDespiteGate }))) };
});

// release
route("GET", /^\/api\/release\/files$/, async () => {
  const { rel, files, stray } = await collectFiles();
  return { previous: rel.tag, stray, files: files.map((f) => ({ file: f.file, id: f.id, origin: f.origin, size: f.size, sha256: f.sha256, error: f.error })) };
});
route("POST", /^\/api\/stage$/, async (req) => stage(await json(req)));
route("GET", /^\/api\/stage\/([A-Za-z0-9._-]+)$/, (req, q, [, tag]) => readPreview(tag) || Promise.reject(Object.assign(new Error("not staged"), { status: 404 })));
route("POST", /^\/api\/publish$/, async (req) => {
  const a = await json(req);
  const dryRun = a.dryRun !== false;
  if (!dryRun && (a.confirm !== a.tag || !a.tag)) throw Object.assign(new Error("type the tag to confirm a real publish"), { status: 400 });
  const j = startJob("publish", `publish-${dryRun ? "dryrun-" : ""}${a.tag}`, (job) => publish({ ...a, dryRun, log: job.log }), { exclusive: true });
  return view(j);
});
// the one-time switch-over to the rolling release: `current` made from the newest full dated release ({from});
// dryRun (default) reads and lists, a real one needs confirm: "current"
route("POST", /^\/api\/release\/init-current$/, async (req) => {
  const a = await json(req);
  const dryRun = a.dryRun !== false;
  if (!dryRun && a.confirm !== ROLLING) throw Object.assign(new Error(`type "${ROLLING}" to confirm the switch-over`), { status: 400 });
  const j = startJob("publish", `init-current-${dryRun ? "dryrun-" : ""}${a.from}`, (job) => initCurrent({ from: a.from, confirm: a.confirm, dryRun, log: job.log }), { exclusive: true });
  return view(j);
});

// "Test in RemoteFM1": the site's copy (lib/site.js) at /rfm1/, the manager's .rfm1 files at /files/
route("GET", /^\/favicon\.ico$/, (req, q, m, res) => { res.writeHead(204); res.end(); });
route("GET", /^\/api\/site$/, () => siteStatus());
route("POST", /^\/api\/site\/refresh$/, () => refreshSite());
route("GET", /^\/rfm1\/(.*)$/, async (req, q, [, rest], res) => {
  const f = await siteFile(decodeURIComponent(rest));
  if (!f) return send(res, 404, "not found", "text/plain");
  send(res, 200, f.body, MIME[extname(f.path)] || "application/octet-stream");
});
const RFM1_NAME = /^[A-Za-z0-9_][A-Za-z0-9._+-]*\.rfm1$/, TAG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
route("GET", /^\/files\/(out|release|staging)\/(?:([^/]+)\/)?([^/]+)$/, (req, q, [, where, tag, name], res) => {
  if (!RFM1_NAME.test(name) || (where === "out") !== !tag || (tag && !TAG_NAME.test(tag))) throw Object.assign(new Error("not found"), { status: 404 });
  const p = where === "out" ? join(cfg.out, name) : where === "release" ? join(cfg.cache, "release", tag, name) : join(cfg.staging, tag, name);
  if (!existsSync(p)) throw Object.assign(new Error("not found"), { status: 404 });
  send(res, 200, readFileSync(p), "application/wasm");
});
// the page for one id: its newest built file in out/, else the latest release's (the files a stage would release)
const siteUrl = (file, id) => `/rfm1/site/?rfm1=${encodeURIComponent(file)}&rfm1id=${encodeURIComponent(id)}`;
route("GET", /^\/rfm1m\/open\/([a-z0-9_]+)$/, async (req, q, [, id], res) => {
  const { rel, files } = await collectFiles();
  const f = files.find((x) => x.id === id);
  if (!f) throw Object.assign(new Error(`no .rfm1 for ${id} in out/ or release ${rel.tag}`), { status: 404 });
  const file = f.origin === "built" ? `/files/out/${f.file}` : `/files/release/${rel.tag}/${f.file}`;
  await ensureSiteCurrent().catch(() => {});
  res.writeHead(302, { Location: siteUrl(file, id), "Cache-Control": "no-store" });
  res.end();
});

// Only this machine's own pages: a Host of the manager's own address (no DNS rebinding), and no request that changes
// anything from another site (a page open in the browser could otherwise POST a build or a publish to localhost)
const OWN_HOSTS = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, `[::1]:${cfg.port}`]);
function refusal(method, h) {
  if (!OWN_HOSTS.has(String(h.host || "").toLowerCase())) return "Host is not the manager's own address";
  if (method === "GET" || method === "HEAD") return null;
  if (h.origin !== undefined && !OWN_HOSTS.has(String(h.origin).toLowerCase().replace(/^http:\/\//, ""))) return "a request from another site";
  if (h["sec-fetch-site"] && !["same-origin", "none"].includes(h["sec-fetch-site"])) return "a request from another site";
  return null;
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const no = refusal(req.method, req.headers);
  if (no) return send(res, 403, { error: `refused: ${no}` });
  try {
    for (const r of routes) {
      const m = r.method === req.method && r.re.exec(u.pathname);
      if (!m) continue;
      const out = await r.fn(req, u.searchParams, m, res);
      if (!res.headersSent) send(res, 200, out ?? {});
      return;
    }
    if (req.method !== "GET") return send(res, 404, { error: "no route" });
    const p = normalize(join(APP, "public", u.pathname === "/" ? "index.html" : u.pathname));
    if (!p.startsWith(join(APP, "public")) || !existsSync(p) || statSync(p).isDirectory()) return send(res, 404, "not found", "text/plain");
    send(res, 200, readFileSync(p), MIME[extname(p)] || "application/octet-stream");
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
  }
});
server.listen(cfg.port, cfg.host, () => {
  writeFileSync(join(APP, `.server-${cfg.port}.pid`), String(process.pid));
  console.log(`RFM1Manager on http://${cfg.host}:${cfg.port}/ (pid ${process.pid}); no browser is opened`);
});
