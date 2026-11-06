// SPDX-License-Identifier: GPL-3.0-only
// The one-time switch-over to the rolling release (README "7. Publish"), from the command line (the same as
// POST /api/release/init-current): `current` made from the newest full dated release, marked Latest.
//   node tools/init-current.mjs --from 2026-11-06e                      dry run: reads GitHub, prints the gh steps
//   node tools/init-current.mjs --from 2026-11-06e --confirm current     runs them
// Safe to re-run: nothing to do when `current` already holds that set and is Latest. Paths come from config.json
// (or RFM1M_CONFIG), as for the app: run it from the RFM1Manager folder.
import { initCurrent } from "../lib/publish.js";

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const from = arg("--from"), confirm = arg("--confirm");
if (!from) { console.error("usage: node tools/init-current.mjs --from <dated tag> [--confirm current]"); process.exit(2); }
try {
  const r = await initCurrent({ from, confirm, dryRun: confirm === undefined, log: (l) => console.log(l) });
  if (r.problems.length) { console.log("problems:"); for (const p of r.problems) console.log(`  ${p}`); }
  console.log(r.dryRun ? (r.nothingToDo ? "nothing to do" : `dry run: ${r.plan.length} steps; run again with --confirm current`) : "done");
  if (r.problems.length) process.exitCode = 1;
} catch (e) { console.error(`init-current: ${e.message}`); process.exit(1); }
