// SPDX-License-Identifier: GPL-3.0-only
// "Test in RemoteFM1": a read-only copy of the RemoteFM1 site (origin/main of the RemoteFM1 repo, `git archive`d into
// cache/site-<commit>/), served by the manager at /rfm1/ in the site's dev layout (the page at /rfm1/site/, its
// catalog's "../engines/..", "../remote/.." next to it). The served index.html loads the manager's loader
// (public/rfm1m/loader.js) in place of js/main.js: it puts the manager's .rfm1 into the site's own library
// (js/library.js) and then starts the site. The RemoteFM1 repo is only fetched and read; nothing in it is touched.
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync, unlinkSync, copyFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { cfg, runOk, git, moveAside } from "./util.js";

const STATE = () => join(cfg.cache, "site.json");
const PARTS = ["web/site", "web/engines", "web/remote"];   // what the page loads (web/build, web/vendor: not in a plain tree)

export function siteState() {
  try { const s = JSON.parse(readFileSync(STATE(), "utf8")); return existsSync(s.dir) ? s : null; } catch (_) { return null; }
}

export async function siteStatus() {
  const s = siteState();
  let originMain = null;
  try { originMain = (await git(cfg.remotefm1, ["rev-parse", "origin/main"])).trim(); } catch (_) {}
  return { ...(s || {}), originMain, current: !!s && s.commit === originMain, repo: cfg.remotefm1 };
}

let busy = null;
export function refreshSite() {
  if (!busy) busy = doRefresh().finally(() => { busy = null; });
  return busy;
}
async function doRefresh() {
  await git(cfg.remotefm1, ["fetch", "origin", "main"], { timeoutMs: 120e3 });
  const commit = (await git(cfg.remotefm1, ["rev-parse", "origin/main"])).trim();
  const dir = join(cfg.cache, `site-${commit.slice(0, 12)}`);
  if (!existsSync(join(dir, "web", "site", "index.html"))) {
    const tmp = `${dir}.tmp-${Date.now()}`, tar = `${tmp}.tar`;
    mkdirSync(tmp, { recursive: true });
    await git(cfg.remotefm1, ["archive", "--format=tar", "-o", tar, commit, ...PARTS]);
    await runOk("tar", ["-xf", tar, "-C", tmp]);
    unlinkSync(tar);
    renameSync(tmp, dir);
  }
  const subject = (await git(cfg.remotefm1, ["log", "-1", "--format=%s", commit])).trim();
  const s = { commit, dir, subject, exported: new Date().toISOString() };
  writeFileSync(STATE(), JSON.stringify(s, null, 1));
  return { ...s, originMain: commit, current: true };
}

// "Use my FM-1" loads build/remote/remotefm1.mjs: libremotefm1 in WebAssembly, a build output (RemoteFM1's Pages
// workflow runs web/remote/build.sh), so not in the exported tree. The first request builds it from the served commit
// (an archive of what the script compiles, in a scratch dir beside the copy; Emscripten from ~/emsdk) and keeps it
// in the copy. No Emscripten: a 404, as before, and the page keeps its Use my FM-1 stub.
const REMOTE = "build/remote/remotefm1.mjs";
let remoteBusy = null;
async function buildRemote(s) {
  const tmp = `${s.dir}.remote-${Date.now()}`, tar = `${tmp}.tar`;
  mkdirSync(tmp, { recursive: true });
  try {
    await git(cfg.remotefm1, ["archive", "--format=tar", "-o", tar, s.commit, "host", "proto", "firmware/src", "web/remote"]);
    await runOk("tar", ["-xf", tar, "-C", tmp]);
    unlinkSync(tar);
    await runOk("sh", [join(tmp, "web", "remote", "build.sh")], { timeoutMs: 300e3 });
    mkdirSync(join(s.dir, "web", "build", "remote"), { recursive: true });
    copyFileSync(join(tmp, "web", REMOTE), join(s.dir, "web", REMOTE));
  } finally {
    if (existsSync(tar)) unlinkSync(tar);
    moveAside(tmp);
  }
}
async function remoteModule(s) {
  const p = join(s.dir, "web", REMOTE);
  if (!existsSync(p)) {
    if (!remoteBusy) remoteBusy = buildRemote(s).catch((e) => console.error(`remotefm1.mjs: ${e.message}`)).finally(() => { remoteBusy = null; });
    await remoteBusy;
  }
  return existsSync(p) ? { path: p, body: readFileSync(p) } : null;
}

// /rfm1/<rest> -> a file of the exported tree (null: not one of its parts). index.html comes back rewritten.
export async function siteFile(rest) {
  let s = siteState();
  if (!s) s = await refreshSite();
  const web = join(s.dir, "web");
  if (rest === REMOTE) return remoteModule(s);
  if (rest === "site" || rest === "site/") rest = "site/index.html";
  const p = normalize(join(web, rest));
  if (!PARTS.some((part) => p.startsWith(join(s.dir, part) + "/"))) return null;
  if (!existsSync(p) || statSync(p).isDirectory()) return null;
  if (rest !== "site/index.html") return { path: p, body: readFileSync(p) };
  const html = readFileSync(p, "utf8");
  const tag = '<script type="module" src="js/main.js"></script>';
  if (!html.includes(tag)) throw new Error("the site's index.html no longer loads js/main.js as expected: the manager's loader can't be injected");
  return { path: p, body: html.replace(tag, `<script type="module" src="/rfm1m/loader.js"></script>`) };
}

// Before a Test / Capture: the site copy follows RemoteFM1's main (a new player, such as Fantasy CFW support, must
// not be missed): fetch at most every 5 minutes, export again when behind. A failed fetch keeps the copy there is.
let lastFetch = 0;
export async function ensureSiteCurrent() {
  if (Date.now() - lastFetch > 5 * 60e3) {
    lastFetch = Date.now();
    try { await git(cfg.remotefm1, ["fetch", "-q", "origin", "main"], { timeoutMs: 30e3 }); } catch (_) { return siteStatus(); }
  }
  const s = await siteStatus();
  return s.current ? s : refreshSite();
}
