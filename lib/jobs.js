// SPDX-License-Identifier: GPL-3.0-only
// Background jobs: each has a log (kept in memory and in its bundle folder), a status and a result. The UI polls.
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, stamp } from "./util.js";

const jobs = new Map();
let seq = 0;
let busyBuild = null; // one FM1VST worktree: one build at a time

export function startJob(type, label, fn, { exclusive = false, bundle = true } = {}) {
  if (exclusive && busyBuild) throw Object.assign(new Error(`a build is running (job ${busyBuild})`), { status: 409 });
  const id = `${++seq}`;
  const dir = bundle ? join(cfg.logs, `${stamp()}-${label.replace(/[^A-Za-z0-9_.-]+/g, "_")}`) : null;
  if (dir) mkdirSync(dir, { recursive: true });
  const job = {
    id, type, label, status: "running", started: new Date().toISOString(), lines: [], commands: [], result: null, dir,
    log(l) { job.lines.push(l); if (dir) appendFileSync(join(dir, "build.log"), l + "\n"); },
  };
  jobs.set(id, job);
  if (exclusive) busyBuild = id;
  Promise.resolve().then(() => fn(job)).then((r) => { job.result = r ?? job.result; if (job.status === "running") job.status = "ok"; })
    .catch((e) => { job.status = "failed"; job.error = e.message; job.log(`ERROR: ${e.message}`); })
    .finally(() => {
      job.finished = new Date().toISOString();
      if (exclusive && busyBuild === id) busyBuild = null;
      if (dir) writeFileSync(join(dir, "job.json"), JSON.stringify(view(job, 0, true), null, 1));
    });
  return job;
}

export function view(job, since = 0, full = false) {
  return { id: job.id, type: job.type, label: job.label, status: job.status, started: job.started, finished: job.finished,
    error: job.error, result: job.result, bundle: job.dir, lineCount: job.lines.length,
    lines: full ? undefined : job.lines.slice(since) };
}
export const getJob = (id) => jobs.get(id);
export const listJobs = () => [...jobs.values()].map((j) => view(j, j.lines.length));
