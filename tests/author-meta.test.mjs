// SPDX-License-Identifier: GPL-3.0-only
// node tests/author-meta.test.mjs: the RemoteFM1Metadata.json validator (on a real git repository at a commit), the
// card merge with overrides (on a temp catalog), and the release pick (author's target / owner's pin). No network.
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const T = mkdtempSync(join(tmpdir(), "rfm1m-authormeta-"));
const fw = join(T, "RemoteFM1FW"); mkdirSync(join(fw, "catalog", "images"), { recursive: true });
writeFileSync(join(T, "config.json"), JSON.stringify({ fwRepo: fw }));
process.env.RFM1M_CONFIG = join(T, "config.json");
const { readAuthorMeta, validateMetadata, imageInfo } = await import("../lib/authormeta.js");
const { applyAuthorMeta, setMeta, setImage, clearOverride, readMeta } = await import("../lib/meta.js");
const { choosePick } = await import("../lib/target.js");
const { cmpVer } = await import("../lib/util.js");

let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log(`ok   ${name}`); }, (e) => { console.log(`FAIL ${name}\n${e.stack}`); process.exitCode = 1; });

// images: headers only (imageInfo reads the size from the header)
function png(w, h, pad = 0) {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
function jpg(w, h) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
}

// a firmware repository with commits
const repo = join(T, "fw-repo");
mkdirSync(join(repo, "docs"), { recursive: true });
const g = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
execFileSync("git", ["init", "-q", repo]);
g("config", "user.email", "t@example.com"); g("config", "user.name", "t");
function commit(files) {
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(repo, p, ".."), { recursive: true }); writeFileSync(join(repo, p), c); }
  g("add", "-A"); g("commit", "-q", "-m", "c", "--allow-empty"); return g("rev-parse", "HEAD");
}
const good = {
  schema: 1,
  card: { tag: "Granular sampler", what: "A granular sampler.", category: "Synth", site: "https://example.com/", editor: "https://example.com/ed/", port: "My FW", image: "docs/card.png" },
  skin: { background: "art/bg.png", dim: 0.2, theme: { body: "#1B1B22", key: "#2C2C36", knob: "#E8E2D0", led: "#FF7A2F", bezel: "#0E0E12" } },
  labels: { buttons: { FX: "drums", SEL: "TRACK", "oct+": "UP" }, knobs: { K1: "CUTOFF", K2: "RES" } },
};
const sha1 = commit({ "RemoteFM1Metadata.json": JSON.stringify(good), "docs/card.png": png(512, 512), "art/bg.png": png(1200, 2000) });

await ok("imageInfo png / jpeg", () => {
  assert.deepEqual(imageInfo(png(512, 512)), { type: "png", w: 512, h: 512 });
  assert.deepEqual(imageInfo(jpg(300, 200)), { type: "jpg", w: 300, h: 200 });
  assert.equal(imageInfo(Buffer.from("hello world, not an image")), null);
});
await ok("good file: every field used, no warnings", async () => {
  const r = await readAuthorMeta(repo, sha1);
  assert.equal(r.found, true);
  assert.deepEqual(r.warnings, ["labels.knobs.K1: \"CUTOFF\" is 6 characters: hosts may shrink it (5 or fewer draw best): used"]);
  assert.deepEqual(r.card, { tag: "Granular sampler", what: "A granular sampler.", port: "My FW", category: "Synth", site: "https://example.com/", editor: "https://example.com/ed/" });
  assert.equal(r.image.path, "docs/card.png"); assert.equal(r.image.w, 512);
  assert.ok(r.skin.background && r.skin.theme);
  assert.deepEqual(r.labels, { buttons: { FX: "DRUMS", SEL: "TRACK", "OCT+": "UP" }, knobs: { K1: "CUTOFF", K2: "RES" } });
});
await ok("no file at a commit -> found: false", async () => {
  const r = await readAuthorMeta(repo, commit({ "x.txt": "x" }) && g("rev-list", "--max-parents=0", "HEAD"));
  // the root commit has the file; an empty repository commit without it:
  const bare = join(T, "empty-repo"); execFileSync("git", ["init", "-q", bare]);
  execFileSync("git", ["-C", bare, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "e"]);
  const r2 = await readAuthorMeta(bare, execFileSync("git", ["-C", bare, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  assert.equal(r.found, true); assert.equal(r2.found, false);
});
await ok("bad JSON -> one warning, ignored", async () => {
  const r = await readAuthorMeta(repo, commit({ "RemoteFM1Metadata.json": "{ nope" }));
  assert.equal(r.invalid, true); assert.equal(r.warnings.length, 1); assert.match(r.warnings[0], /not valid JSON/);
});
const bad = async (card, extra = {}, files = {}) => {
  const sha = commit({ "RemoteFM1Metadata.json": JSON.stringify({ schema: 1, card: { tag: "Kept", ...card }, ...extra }), ...files });
  const r = await readAuthorMeta(repo, sha);
  assert.equal(r.card.tag, "Kept", "the good field is still used");
  return r;
};
await ok("unknown category -> warning, rest applied", async () => { const r = await bad({ category: "Sequencer" }); assert.ok(!("category" in r.card)); assert.match(r.warnings.join(), /card.category/); });
await ok("non-https editor -> warning", async () => { const r = await bad({ editor: "http://example.com/" }); assert.ok(!r.card.editor); assert.match(r.warnings.join(), /card.editor: not an https/); });
await ok("too-long what -> warning", async () => { const r = await bad({ what: "x".repeat(601) }); assert.ok(!r.card.what); assert.match(r.warnings.join(), /601 characters, at most 600/); });
await ok("'..' path -> warning", async () => { const r = await bad({ image: "../outside.png" }); assert.equal(r.image, null); assert.match(r.warnings.join(), /card.image: has a '\.\.'/); });
await ok("absolute path -> warning", async () => { const r = await bad({ image: "/etc/x.png" }); assert.match(r.warnings.join(), /absolute path/); });
await ok("missing image -> warning", async () => { const r = await bad({ image: "docs/none.png" }); assert.match(r.warnings.join(), /not found at that commit/); });
await ok("non-square image -> warning", async () => { const r = await bad({ image: "docs/wide.png" }, {}, { "docs/wide.png": png(640, 480) }); assert.match(r.warnings.join(), /640 x 480, not square/); });
await ok("image > 1 MiB -> warning", async () => { const r = await bad({ image: "docs/big.png" }, {}, { "docs/big.png": png(512, 512, 1048576) }); assert.match(r.warnings.join(), /larger than 1 MiB/); });
await ok("symlinked image -> warning", async () => {
  symlinkSync("/etc/hosts", join(repo, "docs", "link.png"));
  const r = await bad({ image: "docs/link.png" }); assert.match(r.warnings.join(), /symlink/);
});
await ok("not-settable + unknown fields -> warnings", async () => { const r = await bad({ name: "X", version: "9", colour: "red" }); assert.match(r.warnings.join(), /card.name: not set by the author/); assert.match(r.warnings.join(), /card.colour: unknown/); });
await ok("bad labels -> warnings, good labels kept", async () => {
  const r = await bad({}, { labels: { buttons: { FX: "OK", NOPE: "X", SEL: "ÄÖ", ENV: "TOO LONG LABEL", LFO: 3, ARP: "" }, knobs: { K9: "X" } } });
  assert.deepEqual(r.labels, { buttons: { FX: "OK", ARP: "" } });
  for (const re of [/labels.buttons.NOPE/, /labels.buttons.SEL: not printable/, /labels.buttons.ENV: 14 characters/, /labels.buttons.LFO: not a string/, /labels.knobs.K9/]) assert.match(r.warnings.join("\n"), re);
});
await ok("target: a tag name is known (no warning); a bad one warns", async () => {
  const r = await bad({}, { target: "v1.4.2" }); assert.ok(!r.warnings.some((w) => /target/.test(w))); assert.equal(r.target, "v1.4.2");
  const q = await bad({}, { target: "../x y" }); assert.match(q.warnings.join(), /target .* not a tag name/);
});
await ok("bad skin -> warnings, no skin", async () => {
  const r = await bad({}, { skin: { dim: 2, theme: { body: "red" } } });
  assert.equal(r.skin, null); assert.match(r.warnings.join(), /skin.dim/); assert.match(r.warnings.join(), /skin.theme/);
});

// ---------- the merge ----------
const catFile = join(fw, "catalog", "catalog.json");
const seed = { schema: 1, about: "test", firmwares: {
  old: { category: "Synth", image: "images/old.png", tag: "Owner tag", what: "Owner text" },
  newfw: { tag: "Owner tag" },
} };
writeFileSync(catFile, JSON.stringify(seed, null, 1) + "\n");
writeFileSync(join(fw, "catalog", "images", "old.png"), png(64, 64));
const before = readFileSync(catFile);
const r1 = await readAuthorMeta(repo, sha1);
await ok("no file -> an existing card is unchanged byte for byte", () => {
  const a = applyAuthorMeta("old", { found: false, commit: sha1 });
  assert.equal(a.changed, false); assert.ok(readFileSync(catFile).equals(before));
});
await ok("first read: author fills empty fields, the owner's differing value becomes an override", () => {
  applyAuthorMeta("newfw", r1);
  const e = readMeta().firmwares.newfw;
  assert.equal(e.tag, "Owner tag"); assert.deepEqual(e.overrides, ["tag"]);
  assert.equal(e.what, "A granular sampler."); assert.equal(e.category, "Synth"); assert.equal(e.image, "images/newfw.png");
  assert.ok(existsSync(join(fw, "catalog", "images", "newfw.png")));
  assert.equal(e.author_meta.commit, sha1); assert.equal(e.author_meta.skin, true); assert.deepEqual(e.author_meta.labels, { buttons: 3, knobs: 2 });
  assert.equal(e.author_meta.fields.image, "docs/card.png");
});
await ok("other cards untouched by that", () => assert.deepEqual(readMeta().firmwares.old, seed.firmwares.old));
await ok("owner edit -> override; back to the author's value -> not an override", () => {
  setMeta("newfw", { what: "Owner's own words" });
  assert.deepEqual(readMeta().firmwares.newfw.overrides, ["tag", "what"]);
  setMeta("newfw", { what: "A granular sampler." });
  assert.deepEqual(readMeta().firmwares.newfw.overrides, ["tag"]);
});
await ok("a new release's file: author fields follow it, overrides win", async () => {
  setMeta("newfw", { port: "Owner Port" });
  const sha2 = commit({ "RemoteFM1Metadata.json": JSON.stringify({ ...good, card: { ...good.card, what: "Version two.", tag: "New tag", port: "FW2" } }) });
  applyAuthorMeta("newfw", await readAuthorMeta(repo, sha2));
  const e = readMeta().firmwares.newfw;
  assert.equal(e.what, "Version two."); assert.equal(e.tag, "Owner tag"); assert.equal(e.port, "Owner Port");
  assert.deepEqual(e.overrides, ["port", "tag"]); assert.equal(e.author_meta.fields.port, "FW2");
});
await ok("clear an override -> the author's value", async () => {
  await clearOverride("newfw", "tag", async () => null);
  const e = readMeta().firmwares.newfw;
  assert.equal(e.tag, "New tag"); assert.deepEqual(e.overrides, ["port"]);
});
await ok("owner image -> override; clear -> the author's image again", async () => {
  setImage("newfw", png(128, 128));
  assert.ok(readMeta().firmwares.newfw.overrides.includes("image"));
  await clearOverride("newfw", "image", async (c, p) => execFileSync("git", ["-C", repo, "show", `${c}:${p}`]));
  const e = readMeta().firmwares.newfw;
  assert.ok(!e.overrides.includes("image")); assert.equal(imageInfo(readFileSync(join(fw, "catalog", e.image))).w, 512);
});
await ok("a field the author drops is removed (when it was the author's)", async () => {
  const sha3 = commit({ "RemoteFM1Metadata.json": JSON.stringify({ schema: 1, card: { tag: "New tag", what: "Version two.", category: "Synth", port: "FW2", image: "docs/card.png" } }) });
  applyAuthorMeta("newfw", await readAuthorMeta(repo, sha3));
  const e = readMeta().firmwares.newfw;
  assert.ok(!("site" in e) && !("editor" in e)); assert.equal(e.author_meta.skin, false); assert.ok(!e.author_meta.labels);
});
await ok("the old card is still byte for byte its seed", () => {
  const cur = JSON.parse(readFileSync(catFile, "utf8")).firmwares.old;
  assert.equal(JSON.stringify(cur), JSON.stringify(seed.firmwares.old));
});

// ---------- the release pick ----------
const normal = { tag: "v2.0", sha: "b".repeat(40), version: "2.0", source: "release" };
const P = (o) => choosePick({ normal, cur: "1.5", pin: "a".repeat(40), slug: "o/r", cmpVer, ...o });
await ok("pick: no author file -> the manager's own pick, unchanged", () => { const p = P({ author: { found: false } }); assert.equal(p.up, normal); assert.equal(p.authorTarget, null); assert.deepEqual(p.warnings, []); });
await ok("pick: author's target present and valid -> used (holds back v2.0)", () => {
  const p = P({ author: { found: true, target: "1.8", tag: "v1.8", sha: "c".repeat(40), version: "1.8" } });
  assert.equal(p.up.source, "target"); assert.equal(p.up.tag, "v1.8"); assert.equal(p.authorTarget, "1.8");
});
await ok("pick: author's beta tag -> allowed (the author chose it)", () => {
  const p = P({ author: { found: true, target: "v2.1-beta.1", tag: "v2.1-beta.1", sha: "d".repeat(40), version: "2.1-beta.1" } });
  assert.equal(p.up.tag, "v2.1-beta.1");
});
await ok("pick: author's target is the pin -> nothing to bump (not the newer v2.0)", () => {
  const p = P({ author: { found: true, target: "v1.5", tag: "v1.5", sha: "a".repeat(40), version: "1.5" } });
  assert.equal(p.up, null);
});
await ok("pick: missing tag -> warning, the manager's pick", () => {
  const p = P({ author: { found: true, target: "v9", error: "target v9: no such tag in o/r: ignored" } });
  assert.equal(p.up, normal); assert.match(p.warnings.join(), /no such tag/); assert.equal(p.authorTarget, "v9");
});
await ok("pick: downgrade -> warning, the manager's pick; allowed with the owner's allowDowngrade", () => {
  const author = { found: true, target: "v1.2", tag: "v1.2", sha: "e".repeat(40), version: "1.2" };
  const p = P({ author }); assert.equal(p.up, normal); assert.match(p.warnings.join(), /downgrade/);
  const q = P({ author, owner: { allowDowngrade: true } }); assert.equal(q.up.tag, "v1.2");
});
await ok("pick: the owner's pin wins over the author's target", () => {
  const p = P({ author: { found: true, target: "v1.8", tag: "v1.8", sha: "c".repeat(40), version: "1.8" }, owner: { tag: "v1.6", resolved: { tag: "v1.6", sha: "f".repeat(40) } } });
  assert.equal(p.up.source, "owner"); assert.equal(p.up.tag, "v1.6"); assert.match(p.warnings.join(), /wins over the author's target/);
});
await ok("pick: the owner's ignoreTarget -> the manager's pick", () => {
  const p = P({ author: { found: true, target: "v1.8", tag: "v1.8", sha: "c".repeat(40), version: "1.8" }, owner: { ignoreTarget: true } });
  assert.equal(p.up, normal);
});

console.log(`\n${pass} passed${process.exitCode ? ", some FAILED" : ""} (scratch: ${T})`);
