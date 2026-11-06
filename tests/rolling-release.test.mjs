// SPDX-License-Identifier: GPL-3.0-only
// node tests/rolling-release.test.mjs: the rolling release (`current`, the full set, Latest) + a dated release per
// publish. The plan logic (dated files, uploads / deletions on `current`, SHA256SUMS, step order), then publish and the
// switch-over end to end against a fake `gh` (an in-memory GitHub; git is real, on temp repositories). No network.
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const T = mkdtempSync(join(tmpdir(), "rfm1m-rolling-"));
const fw = join(T, "RemoteFM1FW");
const bare = join(T, "origin.git");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
execFileSync("git", ["init", "-q", "-b", "main", fw]);
const g = (...a) => execFileSync("git", ["-C", fw, ...a], { encoding: "utf8" }).trim();
g("config", "user.email", "t@example.com"); g("config", "user.name", "t");
mkdirSync(join(fw, "catalog"), { recursive: true });
writeFileSync(join(fw, "README.md"), "old\n"); writeFileSync(join(fw, "catalog", "catalog.json"), "{}\n");
g("add", "-A"); g("commit", "-q", "-m", "init"); g("remote", "add", "origin", bare); g("push", "-q", "origin", "main");
writeFileSync(join(T, "config.json"), JSON.stringify({ fwRepo: fw, ghRepo: "test/RemoteFM1FW" }));
process.env.RFM1M_CONFIG = join(T, "config.json");
const P = await import("../lib/publish.js");
const { cfg, run, moveAside } = await import("../lib/util.js");
const { ROLLING, datedFiles, planCurrent, currentSteps, publishSteps, stepText, assetProblems, currentNotes, sumsText } = P;

let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log(`ok   ${name}`); }, (e) => { console.log(`FAIL ${name}\n${e.stack}`); process.exitCode = 1; });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const H = (c) => c.repeat(64);

// a minimal .rfm1: a Wasm module with an rfm1 manifest custom section
function rfm1(id, version, salt = "") {
  const sec = (name, text) => {
    const n = Buffer.from(name), t = Buffer.from(text);
    const body = Buffer.concat([Buffer.from([n.length]), n, t]);
    const len = []; let v = body.length; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; len.push(b); } while (v);
    return Buffer.concat([Buffer.from([0]), Buffer.from(len), body]);
  };
  return Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
    sec("rfm1", JSON.stringify({ rfm1: 1, abi: 1, id, name: id.toUpperCase(), version, license: "MIT", authors: ["a"], source_url: `https://github.com/x/${id}@abcdef1`, salt })),
    sec("rfm1.license.0", "MIT\n")]);
}

// ---------- pure plan logic ----------
await ok("datedFiles: new and changed files only (by name + SHA-256)", () => {
  const prev = new Map([["a-1.rfm1", H("a")], ["b-1.rfm1", H("b")], ["c-1.rfm1", H("c")]]);
  const files = [{ file: "a-1.rfm1", sha256: H("a") }, { file: "b-1.rfm1", sha256: H("d") }, { file: "c-2.rfm1", sha256: H("c") }, { file: "e-1.rfm1", sha256: H("e") }];
  assert.deepEqual(datedFiles(files, prev), ["b-1.rfm1", "c-2.rfm1", "e-1.rfm1"]);
  assert.deepEqual(datedFiles(files.slice(0, 1), prev), []);
});

await ok("planCurrent: uploads new/changed, deletes stale and stray assets, SHA256SUMS by digest", () => {
  const files = [{ file: "a-1.rfm1", sha256: H("a") }, { file: "b-1.rfm1", sha256: H("d") }, { file: "e-1.rfm1", sha256: H("e") }];
  const sums = sumsText(files);
  const assets = [{ name: "a-1.rfm1", digest: `sha256:${H("a")}` }, { name: "b-1.rfm1", digest: `sha256:${H("b")}` },
    { name: "c-1.rfm1", digest: `sha256:${H("c")}` }, { name: "notes.txt", digest: `sha256:${H("f")}` }, { name: "SHA256SUMS", digest: `sha256:${H("0")}` }];
  const p = planCurrent({ files, assets, sums });
  assert.deepEqual(p.upload, ["b-1.rfm1", "e-1.rfm1"]);
  assert.deepEqual(p.remove, ["c-1.rfm1", "notes.txt"]);
  assert.equal(p.sumsChanged, true);
  assert.equal(p.same, false);
  // already there: nothing
  const same = planCurrent({ files, sums, assets: [...files.map((f) => ({ name: f.file, digest: `sha256:${f.sha256}` })), { name: "SHA256SUMS", digest: `sha256:${sha(sums)}` }] });
  assert.deepEqual(same, { upload: [], sumsChanged: false, remove: [], same: true });
  // no digests: current's own SHA256SUMS decides
  const nd = planCurrent({ files, sums, liveSumsText: sums, liveSums: new Map(files.map((f) => [f.file, f.sha256])),
    assets: [...files.map((f) => ({ name: f.file, digest: null })), { name: "SHA256SUMS", digest: null }] });
  assert.equal(nd.same, true);
  // no `current` yet: everything
  const none = planCurrent({ files, sums });
  assert.deepEqual([none.upload.length, none.sumsChanged, none.remove.length], [3, true, 0]);
});

await ok("publishSteps: order (files, SHA256SUMS, deletions, check, dated not Latest, current edit Latest, check)", () => {
  const plan = { upload: ["b-1.rfm1", "e-1.rfm1"], sumsChanged: true, remove: ["c-1.rfm1"] };
  const s = publishSteps({ tag: "2026-11-07", repo: "o/r", dir: "/s", branch: "main", plan, dated: ["b-1.rfm1", "e-1.rfm1"] });
  const t = s.map(stepText);
  assert.deepEqual(t, [
    "gh release upload current --repo o/r --clobber /s/b-1.rfm1 /s/e-1.rfm1",
    "gh release upload current --repo o/r --clobber /s/SHA256SUMS",
    "gh release delete-asset current c-1.rfm1 --repo o/r --yes",
    "(check) every asset of current matches its SHA256SUMS: the same .rfm1 names, each SHA-256 digest equal",
    "gh release create 2026-11-07 --repo o/r --title 2026-11-07 --notes-file /s/RELEASE-NOTES.md --target main --latest=false /s/b-1.rfm1 /s/e-1.rfm1 /s/dated/SHA256SUMS",
    "gh release edit current --repo o/r --title 2026-11-07 --notes-file /s/CURRENT-NOTES.md --latest",
    "(check) the Latest release is current",
  ]);
  // nothing changed (README only): no uploads, a dated release without files
  const n = publishSteps({ tag: "x", repo: "o/r", dir: "/s", branch: "main", plan: { upload: [], sumsChanged: false, remove: [] }, dated: [] }).map(stepText);
  assert.equal(n[1], "gh release create x --repo o/r --title x --notes-file /s/RELEASE-NOTES.md --target main --latest=false");
  assert.equal(n.length, 4);
  // a re-run after the dated release was made: not created again
  assert.ok(!publishSteps({ tag: "x", repo: "o/r", dir: "/s", branch: "main", plan, dated: [], datedExists: true }).some((x) => x.args?.[1] === "create"));
  assert.deepEqual(currentSteps({ repo: "o/r", dir: "/s", plan: { upload: [], sumsChanged: false, remove: [] } }), [{ check: "assets" }]);
});

await ok("assetProblems: names and digests against SHA256SUMS", () => {
  const files = [{ file: "a-1.rfm1", sha256: H("a") }, { file: "b-1.rfm1", sha256: H("b") }];
  const sums = new Map(files.map((f) => [f.file, f.sha256]));
  const good = [...files.map((f) => ({ name: f.file, digest: `sha256:${f.sha256}` })), { name: "SHA256SUMS", digest: `sha256:${H("9")}` }];
  assert.deepEqual(assetProblems(good, sums, H("9")), []);
  const bad = [{ name: "a-1.rfm1", digest: `sha256:${H("c")}` }, { name: "z-1.rfm1", digest: null }, { name: "SHA256SUMS", digest: `sha256:${H("8")}` }];
  assert.deepEqual(assetProblems(bad, sums, H("9")), [`a-1.rfm1: digest ${H("c")}, SHA256SUMS says ${H("a")}`, "b-1.rfm1: in SHA256SUMS, not in current",
    "z-1.rfm1: in current, not in SHA256SUMS", "SHA256SUMS: not the one uploaded"]);
});

await ok("currentNotes: the dated notes + what current is", () => {
  const n = currentNotes("2026-11-07", "Notes.\n", 78);
  assert.ok(n.startsWith("Notes.\n\n---\n`current` always holds the full set"));
  assert.match(n, /\(78 files\)/); assert.match(n, /the dated release 2026-11-07 holds only the files it added or updated/);
});

// ---------- end to end against a fake gh ----------
// releases: tag -> { name, draft, notes, assets: Map(name -> Buffer) }; calls: every gh argv
function fakeGh() {
  const st = { releases: new Map(), latest: null, calls: [] };
  const flag = (a, f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
  const VAL = new Set(["--repo", "--json", "--dir", "-p", "--title", "--notes-file", "--target", "--jq"]);
  const pos = (a) => { const o = []; for (let i = 0; i < a.length; i++) { if (VAL.has(a[i])) i++; else if (!a[i].startsWith("-")) o.push(a[i]); } return o; };
  const view = (r, tag) => ({ tagName: tag, name: r.name, isDraft: r.draft, assets: [...r.assets].map(([n, b]) => ({ name: n, size: b.length, digest: `sha256:${sha(b)}` })) });
  const res = (out = "") => ({ code: 0, out, err: "" });
  const exec = async (cmd, args, opts = {}) => {
    if (cmd !== "gh") return run(cmd, args, { ...opts, log: undefined });
    st.calls.push(args.join(" "));
    const [a, b] = args, p = pos(args);
    if (a === "api") return st.latest ? res(st.latest + "\n") : { code: 1, out: "", err: "Not Found" };
    const tag = p[2], r = st.releases.get(tag);
    if (b !== "create" && !r) return { code: 1, out: "", err: "release not found" };
    if (b === "view") return res(JSON.stringify(view(r, tag)));
    if (b === "download") {
      const d = flag(args, "--dir"); mkdirSync(d, { recursive: true });
      const want = args.flatMap((x, i) => (args[i - 1] === "-p" ? [x] : []));
      for (const n of want) writeFileSync(join(d, n), r.assets.get(n));
      return res();
    }
    if (b === "upload") { for (const f of p.slice(3)) r.assets.set(basename(f), readFileSync(f)); return res(); }
    if (b === "delete-asset") { r.assets.delete(p[3]); return res(); }
    if (b === "create") {
      if (r) return { code: 1, out: "", err: "already exists" };
      st.releases.set(tag, { name: flag(args, "--title"), draft: false, notes: readFileSync(flag(args, "--notes-file"), "utf8"), assets: new Map(p.slice(3).map((f) => [basename(f), readFileSync(f)])) });
      if (!args.includes("--latest=false")) st.latest = tag;
      return res();
    }
    if (b === "edit") {
      if (flag(args, "--title")) r.name = flag(args, "--title");
      if (flag(args, "--notes-file")) r.notes = readFileSync(flag(args, "--notes-file"), "utf8");
      if (args.includes("--draft=false")) r.draft = false;
      if (args.includes("--latest")) st.latest = tag;
      return res();
    }
    return { code: 1, out: "", err: `fake gh: ${args.join(" ")}` };
  };
  return { st, exec };
}
const WRITES = /^release (upload|delete-asset|create|edit) /;
const seed = (st, tag, files, latest = true) => {
  st.releases.set(tag, { name: tag, draft: false, notes: "", assets: new Map([...files.map(([n, b]) => [n, b]), ["SHA256SUMS", Buffer.from(files.map(([n, b]) => `${sha(b)}  ${n}\n`).sort((x, y) => x.slice(66).localeCompare(y.slice(66))).join(""))]]) });
  if (latest) st.latest = tag;
};

const A1 = rfm1("aaa", "1.0"), B1 = rfm1("bbb", "1.0"), C1 = rfm1("ccc", "1.0"), B2 = rfm1("bbb", "1.1"), A1b = rfm1("aaa", "1.0", "rebuilt"), D1 = rfm1("ddd", "0.1");
const OLD = [["aaa-1.0.rfm1", A1], ["bbb-1.0.rfm1", B1], ["ccc-1.0.rfm1", C1]];
const stamp = `${process.pid}`;
// (what the tests put in the app's cache/ and staging/ goes to scratch/trash afterwards)
const aside = (p) => moveAside(p);

await ok("init-current: dry run reads only; real run creates current from the dated release, Latest; re-run does nothing", async () => {
  const { st, exec } = fakeGh();
  const from = `t${stamp}-old`;
  seed(st, from, OLD);
  const dry = await P.initCurrent({ from, exec });
  assert.equal(dry.dryRun, true); assert.deepEqual(dry.problems, []); assert.equal(dry.exists, false);
  assert.ok(!st.calls.some((c) => WRITES.test(c)), "a dry run writes nothing");
  assert.match(dry.plan[0], new RegExp(`^gh release create current --repo test/RemoteFM1FW --title ${from} --notes-file \\S+ --target main --latest \\S+aaa-1.0.rfm1 \\S+bbb-1.0.rfm1 \\S+ccc-1.0.rfm1 \\S+/SHA256SUMS$`));
  await assert.rejects(P.initCurrent({ from, exec, dryRun: false, confirm: "yes" }), /type "current"/);
  const r = await P.initCurrent({ from, exec, dryRun: false, confirm: ROLLING });
  assert.equal(r.done, true);
  assert.equal(st.latest, ROLLING);
  const cur = st.releases.get(ROLLING);
  assert.deepEqual([...cur.assets.keys()].sort(), ["SHA256SUMS", "aaa-1.0.rfm1", "bbb-1.0.rfm1", "ccc-1.0.rfm1"]);
  assert.equal(cur.name, from);
  assert.equal(cur.assets.get("SHA256SUMS").toString(), st.releases.get(from).assets.get("SHA256SUMS").toString());
  st.calls.length = 0;
  const again = await P.initCurrent({ from, exec, dryRun: false, confirm: ROLLING });
  assert.equal(again.nothingToDo, true);
  assert.ok(!st.calls.some((c) => WRITES.test(c)));
  // current holding another set (after publishes): refused
  cur.name = "2099-01-01"; cur.assets.delete("ccc-1.0.rfm1");
  await assert.rejects(P.initCurrent({ from, exec }), /switch-over is only for the first time/);
  aside(join(cfg.cache, "release", from)); aside(join(cfg.staging, `${ROLLING}-from-${from}`));
});

// a staged publish as stage() writes it (the full set + the dated part)
function stageFiles(tag, files, prevSumsText) {
  const dir = join(cfg.staging, tag);
  mkdirSync(join(dir, "dated"), { recursive: true });
  const list = files.map(([n, b]) => ({ file: n, sha256: sha(b) }));
  for (const [n, b] of files) writeFileSync(join(dir, n), b);
  writeFileSync(join(dir, "SHA256SUMS"), sumsText(list));
  const prev = new Map(prevSumsText.split("\n").filter(Boolean).map((l) => [l.slice(66), l.slice(0, 64)]));
  const dated = datedFiles(list, prev);
  writeFileSync(join(dir, "dated", "SHA256SUMS"), sumsText(list.filter((f) => dated.includes(f.file))));
  writeFileSync(join(dir, "RELEASE-NOTES.md"), `Release ${tag}.\n`);
  writeFileSync(join(dir, "CURRENT-NOTES.md"), currentNotes(tag, `Release ${tag}.\n`, list.length));
  writeFileSync(join(dir, "README.preview.md"), `readme ${tag}\n`);
  const pv = { tag, repo: cfg.ghRepo, dir, previous: ROLLING, files: list, problems: [], dated, removed: [], previousSumsSha: sha(prevSumsText) };
  writeFileSync(join(cfg.staging, `${tag}.preview.json`), JSON.stringify(pv));
  return { dir, dated };
}

await ok("publish: dry run lists the gh steps and writes nothing; the real one updates current + makes the dated release", async () => {
  const { st, exec } = fakeGh();
  seed(st, ROLLING, OLD);
  const prevSums = st.releases.get(ROLLING).assets.get("SHA256SUMS").toString();
  const tag = `t${stamp}-new`;
  // aaa rebuilt (same name), bbb 1.0 -> 1.1, ccc removed, ddd new
  const NEW = [["aaa-1.0.rfm1", A1b], ["bbb-1.1.rfm1", B2], ["ddd-0.1.rfm1", D1]];
  const { dir, dated } = stageFiles(tag, NEW, prevSums);
  assert.deepEqual(dated, ["aaa-1.0.rfm1", "bbb-1.1.rfm1", "ddd-0.1.rfm1"]);
  const lines = [];
  const dry = await P.publish({ tag, exec, log: (l) => lines.push(l) });
  assert.deepEqual(dry.problems, []);
  assert.ok(!st.calls.some((c) => WRITES.test(c)), "a dry run writes nothing");
  assert.equal(g("log", "--oneline").split("\n").length, 1);
  assert.deepEqual(dry.current, { upload: ["aaa-1.0.rfm1", "bbb-1.1.rfm1", "ddd-0.1.rfm1"], sumsChanged: true, remove: ["bbb-1.0.rfm1", "ccc-1.0.rfm1"] });
  const gh = dry.plan.filter((p) => p.startsWith("gh ") || p.startsWith("(check)"));
  assert.deepEqual(gh.map((p) => p.split(" ").slice(0, 4).join(" ")), ["gh release upload current", "gh release upload current", "gh release delete-asset current",
    "gh release delete-asset current", "(check) every asset of", `gh release create ${tag}`, "gh release edit current", "(check) the Latest release"]);
  assert.ok(lines.every((l) => l.startsWith("(dry run) ")));
  console.log(dry.plan.map((p) => `       ${p.replaceAll(dir, "<staging>/" + tag)}`).join("\n"));

  await assert.rejects(P.publish({ tag, exec, dryRun: false, confirm: "nope" }), /does not match the tag/);
  const r = await P.publish({ tag, exec, dryRun: false, confirm: tag });
  assert.equal(r.published, true);
  // the order of the writes
  const w = st.calls.filter((c) => WRITES.test(c)).map((c) => c.split(" ").slice(0, 3).join(" "));
  assert.deepEqual(w, ["release upload current", "release upload current", "release delete-asset current", "release delete-asset current", `release create ${tag}`, "release edit current"]);
  // current: the full new set, matching its SHA256SUMS; Latest; titled with the dated tag
  const cur = st.releases.get(ROLLING);
  assert.deepEqual([...cur.assets.keys()].sort(), ["SHA256SUMS", "aaa-1.0.rfm1", "bbb-1.1.rfm1", "ddd-0.1.rfm1"]);
  assert.equal(cur.assets.get("SHA256SUMS").toString(), readFileSync(join(dir, "SHA256SUMS"), "utf8"));
  assert.equal(sha(cur.assets.get("aaa-1.0.rfm1")), sha(A1b));
  assert.equal(st.latest, ROLLING); assert.equal(cur.name, tag); assert.match(cur.notes, /always holds the full set/);
  // the dated release: only the added and updated files + their SHA256SUMS, not Latest
  const d = st.releases.get(tag);
  assert.deepEqual([...d.assets.keys()].sort(), ["SHA256SUMS", "aaa-1.0.rfm1", "bbb-1.1.rfm1", "ddd-0.1.rfm1"]);
  assert.equal(d.assets.get("SHA256SUMS").toString(), sumsText(NEW.map(([n, b]) => ({ file: n, sha256: sha(b) }))));
  // RemoteFM1FW committed + pushed
  assert.equal(execFileSync("git", ["-C", bare, "log", "-1", "--format=%s", "main"], { encoding: "utf8" }).trim(), `Release ${tag}`);

  // a second publish with only one change: the dated release holds just that file
  const tag2 = `t${stamp}-two`, D2 = rfm1("ddd", "0.2");
  const NEW2 = [["aaa-1.0.rfm1", A1b], ["bbb-1.1.rfm1", B2], ["ddd-0.2.rfm1", D2]];
  stageFiles(tag2, NEW2, cur.assets.get("SHA256SUMS").toString());
  st.calls.length = 0;
  await P.publish({ tag: tag2, exec, dryRun: false, confirm: tag2 });
  assert.deepEqual([...st.releases.get(tag2).assets.keys()].sort(), ["SHA256SUMS", "ddd-0.2.rfm1"]);
  assert.deepEqual([...cur.assets.keys()].sort(), ["SHA256SUMS", "aaa-1.0.rfm1", "bbb-1.1.rfm1", "ddd-0.2.rfm1"]);
  assert.deepEqual(st.calls.filter((c) => WRITES.test(c)).map((c) => c.split(" ").slice(0, 3).join(" ")),
    ["release upload current", "release upload current", "release delete-asset current", `release create ${tag2}`, "release edit current"]);

  // current changed by someone else since a stage: refused
  const tag3 = `t${stamp}-three`;
  stageFiles(tag3, NEW, prevSums);
  const p3 = await P.publish({ tag: tag3, exec });
  assert.ok(p3.problems.some((p) => /changed since this stage/.test(p)), p3.problems.join("; "));
  // no current yet: refused (switch over first)
  st.releases.delete(ROLLING);
  const p4 = await P.publish({ tag: tag3, exec });
  assert.ok(p4.problems.some((p) => /run the switch-over first/.test(p)));
  for (const t of [tag, tag2, tag3]) { aside(join(cfg.staging, t)); aside(join(cfg.staging, `${t}.preview.json`)); }
});

await ok("syncRelease: a cached file current no longer has is moved aside (it would come back as released)", async () => {
  const { syncRelease } = await import("../lib/catalog.js");
  const tag = `t${stamp}-cache`, dir = join(cfg.cache, "release", tag);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "aaa-1.0.rfm1"), A1); writeFileSync(join(dir, "ccc-1.0.rfm1"), C1);
  await syncRelease({ tag, assets: [{ name: "aaa-1.0.rfm1", size: A1.length, digest: `sha256:${sha(A1)}` }] });
  assert.ok(existsSync(join(dir, "aaa-1.0.rfm1")) && !existsSync(join(dir, "ccc-1.0.rfm1")));
  aside(dir);
});

await ok("stage refuses the rolling tag", async () => {
  await assert.rejects(P.stage({ tag: ROLLING }), /rolling release/);
});

console.log(`\n${pass} passed${process.exitCode ? ", some FAILED" : ""}`);
