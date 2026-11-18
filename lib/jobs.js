// SPDX-License-Identifier: GPL-3.0-only
// Background jobs: each has a log (kept in memory and in its bundle folder), a status and a result. The UI polls.
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, stamp } from "./util.js";

const jobs = new Map();
let seq = 0;
let busyBuild = null; // one FM1VST worktree: one build at a time

// exclusive jobs (one FM1VST worktree) run one at a time; with queue, one asked for while another runs waits its turn
// (status "queued", first in first out) instead of being refused; a queued job can be cancelled
const waiting = [];
export function startJob(type, label, fn, { exclusive = false, bundle = true, queue = false } = {}) {
  if (exclusive && busyBuild && !queue) throw Object.assign(new Error(`a build is running (job ${busyBuild})`), { status: 409 });
  const id = `${++seq}`;
  const job = {
    id, type, label, status: "queued", queued: new Date().toISOString(), lines: [], commands: [], result: null, dir: null,
    log(l) { job.lines.push(l); if (job.dir) appendFileSync(join(job.dir, "build.log"), l + "\n"); },
  };
  jobs.set(id, job);
  const go = () => {
    job.status = "running"; job.started = new Date().toISOString();
    job.dir = bundle ? join(cfg.logs, `${stamp()}-${label.replace(/[^A-Za-z0-9_.-]+/g, "_")}`) : null;
    if (job.dir) mkdirSync(job.dir, { recursive: true });
    if (exclusive) busyBuild = id;
    Promise.resolve().then(() => fn(job)).then((r) => { job.result = r ?? job.result; if (job.status === "running") job.status = "ok"; })
      .catch((e) => { job.status = "failed"; job.error = e.message; job.log(`ERROR: ${e.message}`); })
      .finally(() => {
        job.finished = new Date().toISOString();
        if (job.dir) writeFileSync(join(job.dir, "job.json"), JSON.stringify(view(job, 0, true), null, 1));
        if (exclusive && busyBuild === id) { busyBuild = null; next(); }
      });
  };
  if (exclusive && (busyBuild || waiting.length)) { waiting.push({ job, go }); job.log(`queued behind job ${busyBuild || waiting[0].job.id}`); }
  else go();
  return job;
}
function next() {
  const w = waiting.shift();
  if (w) w.go();
}
// a queued job taken out of the queue (a running one is not stopped)
export function cancelJob(id) {
  const i = waiting.findIndex((w) => w.job.id === id);
  if (i < 0) return false;
  const [{ job }] = waiting.splice(i, 1);
  job.status = "cancelled"; job.finished = new Date().toISOString();
  return true;
}

export function view(job, since = 0, full = false) {
  return { id: job.id, type: job.type, label: job.label, status: job.status, queued: job.queued, started: job.started, finished: job.finished,
    error: job.error, result: job.result, bundle: job.dir, lineCount: job.lines.length,
    lines: full ? undefined : job.lines.slice(since) };
}
export const getJob = (id) => jobs.get(id);
export const listJobs = () => [...jobs.values()].map((j) => view(j, j.lines.length));
