// SPDX-License-Identifier: GPL-3.0-only
// Shared helpers: config, process runner (captures output, streams to a job log), small fs helpers.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, appendFileSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadConfig() {
  const root = resolve(APP, "..");
  const fm1vst = join(root, "FM1VST");
  const def = {
    host: "127.0.0.1",
    port: 4717,
    fm1vst,
    baseBranch: "rfm1-melodee",
    branch: "rfm1-manager",
    worktree: join(fm1vst, ".claude", "worktrees", "rfm1-manager"),
    fwRepo: join(root, "RemoteFM1FW"),
    ghRepo: "Quixotic7/RemoteFM1FW",
    fm1vstGh: "Quixotic7/FM1VST",
    emcc: "/opt/homebrew/bin/emcc",
    basePython: "/opt/homebrew/bin/python3.12",
    venv: join(APP, ".venv"),
    jobs: 8,
  };
  const p = process.env.RFM1M_CONFIG || join(APP, "config.json");
  let user = {};
  if (existsSync(p)) user = JSON.parse(readFileSync(p, "utf8"));
  const cfg = { ...def, ...user };
  if (process.env.RFM1M_PORT) cfg.port = Number(process.env.RFM1M_PORT);
  cfg.cache = join(APP, "cache");
  cfg.logs = join(APP, "logs");
  cfg.out = join(APP, "out");
  cfg.scratch = join(APP, "scratch");
  cfg.trash = join(APP, "scratch", "trash");
  cfg.staging = join(APP, "staging");
  for (const d of [cfg.cache, cfg.logs, cfg.out, cfg.scratch, cfg.trash, cfg.staging]) mkdirSync(d, { recursive: true });
  return cfg;
}
export const cfg = loadConfig();

// the env every child gets: Homebrew first (emcc, cmake), the venv's python on PATH, no GUI
export function childEnv(extra = {}) {
  const path = [join(cfg.venv, "bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH].join(":");
  return { ...process.env, PATH: path, DYLD_FALLBACK_LIBRARY_PATH: "/opt/homebrew/lib", GIT_TERMINAL_PROMPT: "0", ...extra };
}

// run a command; resolves { code, out, err } (never rejects). opts.log(line) gets every line; opts.logFile appends.
export function run(cmd, args = [], opts = {}) {
  return new Promise((res) => {
    const cmdline = [cmd, ...args].map(shq).join(" ");
    if (opts.log) opts.log(`$ ${opts.cwd ? `(cd ${shq(opts.cwd)}) ` : ""}${cmdline}`);
    if (opts.commands) opts.commands.push(`${opts.cwd ? `cd ${shq(opts.cwd)} && ` : ""}${cmdline}`);
    let out = "", err = "";
    let p;
    try {
      p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env || childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return res({ code: 127, out: "", err: String(e) });
    }
    const feed = (which) => {
      let buf = "";
      return (d) => {
        const s = d.toString();
        if (which === "out") out += s; else err += s;
        if (!opts.log) return;
        buf += s;
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const l of lines) opts.log(l);
      };
    };
    p.stdout.on("data", feed("out"));
    p.stderr.on("data", feed("err"));
    p.on("error", (e) => { err += String(e); });
    let timer = null;
    if (opts.timeoutMs) timer = setTimeout(() => { p.kill("SIGTERM"); err += "\n(timeout)"; }, opts.timeoutMs);
    p.on("close", (code) => { if (timer) clearTimeout(timer); res({ code: code ?? 1, out, err }); });
  });
}

export async function runOk(cmd, args, opts = {}) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")}: exit ${r.code}: ${(r.err || r.out).trim().slice(-2000)}`);
  return r.out;
}

export function shq(s) {
  s = String(s);
  return /^[A-Za-z0-9_\-+=.,/:@%^]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export const git = (cwd, args, opts = {}) => runOk("git", args, { cwd, ...opts });

// move a path aside into scratch/trash (a hook forbids rm -rf; nothing is deleted)
export function moveAside(p) {
  if (!existsSync(p)) return null;
  const dest = join(cfg.trash, `${Date.now()}-${p.split("/").pop()}`);
  renameSync(p, dest);
  return dest;
}

export function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

// stable-release rules (owner: pin upstream stable releases only)
export const PRE_RE = /(rc|beta|alpha|pre|preview|dev|nightly|test|snapshot|draft|wip)/i;
export function isStableTag(t) {
  return /^(?:[A-Za-z][A-Za-z0-9_]*[-_])?v?\d+(\.\d+){0,3}$/.test(t) && !PRE_RE.test(t);
}
export function verOf(t) { return String(t).replace(/^[A-Za-z][A-Za-z0-9_]*[-_](?=v?\d)/, "").replace(/^v/i, ""); }
export function cmpVer(a, b) {
  const pa = verOf(a).split(/[.\-]/).map((x) => parseInt(x, 10) || 0), pb = verOf(b).split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

export function appendLog(file, line) { appendFileSync(file, line + "\n"); }
