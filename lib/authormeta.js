// SPDX-License-Identifier: GPL-3.0-only
// A firmware author's RemoteFM1Metadata.json (RemoteFM1FW docs/REMOTEFM1-METADATA.md): read from the firmware's own
// repository at the commit we build (git, never a branch tip or a URL), validated field by field. Every problem is a
// warning; the fields that pass are used. The card half fills catalog.json (lib/meta.js applyAuthorMeta); the skin
// half is FM1VST's (embedded in the .rfm1 at packaging): here it is only checked, so the manager can say "skin: yes".
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { posix } from "node:path";

export const META_FILE = "RemoteFM1Metadata.json";
// the categories RemoteFM1's site and apps show (web/site/js/live.js CATEGORIES, without "All")
export const CATEGORIES = ["Synth", "Groovebox", "Chords", "Drums", "Other"];
export const CARD_KEYS = ["tag", "what", "category", "site", "editor", "port", "image"];
const NOT_AUTHOR = ["id", "name", "version", "license", "licence", "licenses", "authors", "author", "credits", "source_url",
  "beta", "virtual", "gated", "hosted", "description"];
const ROLES14 = ["body", "label", "bed", "key", "hi", "lo", "keyText", "knob", "mark", "bezel", "lcd", "ink", "led", "ledOff"];
const ROLES5 = ["body", "key", "knob", "led", "bezel"];
const MiB = 1048576;
export const LABEL_BUTTONS = ["FX", "SEL", "ENV", "LFO", "EDIT", "GLO", "HOME", "SAVE", "ARP", "SEQ", "PLAY", "REC", "OCT-", "OCT+"];
export const LABEL_KNOBS = ["SELECT", "ALGO", "PRESETS", "K1", "K2", "K3", "K4", "MASTER"];

// ---------- images ----------
export function imageInfo(b) {
  if (b.length >= 24 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return { type: "png", w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: "jpg", h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
    return { type: "jpg", w: 0, h: 0 };
  }
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const c = b.toString("latin1", 12, 16);
    if (c === "VP8 ") return { type: "webp", w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (c === "VP8L") { const v = b.readUInt32LE(21); return { type: "webp", w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1 }; }
    if (c === "VP8X") return { type: "webp", w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    return { type: "webp", w: 0, h: 0 };
  }
  return null;
}
export const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// ---------- a repository at a commit (git) ----------
const gitBuf = (dir, args, max = 16 * MiB) => new Promise((ok) => execFile("git", ["-C", dir, ...args],
  { encoding: "buffer", maxBuffer: max, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  (e, out) => ok(e ? null : out)));
// src(path) -> { buf } | { error } for a file of the repository at `sha`: a regular file only (never a symlink, a
// submodule or a folder); git does not follow symlinks in a path, so one out of the repository is "not found"
export function gitSource(dir, sha) {
  return async (path, maxBytes) => {
    const ls = await gitBuf(dir, ["ls-tree", "-z", sha, "--", path]);
    const line = ls ? ls.toString("utf8").split("\0")[0] : "";
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(line);
    if (!m) return { error: "not found at that commit" };
    if (m[1] === "120000") return { error: "a symlink (not allowed)" };
    if (m[2] !== "blob") return { error: `a ${m[2] === "tree" ? "folder" : m[2]}, not a file` };
    const size = Number(String(await gitBuf(dir, ["cat-file", "-s", m[3]]) || "").trim());
    if (maxBytes && size > maxBytes) return { error: `${size} bytes, more than ${maxBytes}`, size };
    const buf = await gitBuf(dir, ["cat-file", "blob", m[3]]);
    return buf ? { buf } : { error: "unreadable" };
  };
}

// ---------- the validator ----------
// a repository-relative path: no absolute path, no backslash, no "." / ".." segments, no empty segment
function badPath(p) {
  if (typeof p !== "string" || !p) return "not a path string";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "an absolute path (give one relative to the repository root)";
  if (p.includes("\\")) return "has a backslash (use /)";
  if (p.split("/").some((s) => s === ".." || s === "." || s === "")) return "has a '..', '.' or empty part (paths stay inside the repository)";
  if (posix.normalize(p) !== p) return "not a plain path";
  return null;
}
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const oneLine = (v) => typeof v === "string" && !/[\u0000-\u001f\u007f]/.test(v);

// text: the file's contents (string or Buffer); src(path, maxBytes) as gitSource gives it.
// -> { card: { tag, what, category, site, editor, port }, image: { path, type, w, h, size, sha256, buf } | null,
//      skin: { background, landscape, dim, theme } | null, labels: { buttons, knobs } | null, warnings: [] }
export async function validateMetadata(text, src) {
  const warnings = [], card = {};
  const out = { card, image: null, skin: null, labels: null, warnings };
  let j;
  try { j = JSON.parse(Buffer.isBuffer(text) ? text.toString("utf8") : String(text)); }
  catch (e) { warnings.push(`${META_FILE} is not valid JSON (${e.message}): ignored`); out.invalid = true; return out; }
  if (!j || typeof j !== "object" || Array.isArray(j)) { warnings.push(`${META_FILE} is not a JSON object: ignored`); out.invalid = true; return out; }
  for (const k of Object.keys(j)) if (!["schema", "target", "card", "skin", "labels", "$schema"].includes(k)) warnings.push(`unknown top-level field "${k}": ignored`);
  if (j.schema === undefined) warnings.push(`no "schema": read as schema 1`);
  else if (j.schema !== 1) warnings.push(`schema ${JSON.stringify(j.schema)} is not 1: read as schema 1 (the fields it knows)`);

  // target: read from the default branch's copy (lib/target.js); here only checked
  if ("target" in j && (typeof j.target !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+\-/]{0,99}$/.test(j.target))) warnings.push(`target ${JSON.stringify(j.target)} is not a tag name: ignored`);
  else if ("target" in j) out.target = j.target;
  const c = j.card;
  if (c !== undefined && (typeof c !== "object" || c === null || Array.isArray(c))) warnings.push(`"card" is not an object: ignored`);
  else if (c) {
    for (const k of Object.keys(c)) {
      if (NOT_AUTHOR.includes(k)) warnings.push(`card.${k}: not set by the author file (it comes from the build or from the catalog's owner): ignored`);
      else if (!CARD_KEYS.includes(k)) warnings.push(`card.${k}: unknown field: ignored`);
    }
    const str = (k, max, line) => {
      if (!(k in c)) return;
      const v = c[k];
      if (typeof v !== "string") return warnings.push(`card.${k}: not a string: ignored`);
      const t = v.trim();
      if (!t) return warnings.push(`card.${k}: empty: ignored`);
      if (line ? !oneLine(t) : CTRL.test(t)) return warnings.push(`card.${k}: has control characters${line ? " or line breaks" : ""}: ignored`);
      if ([...t].length > max) return warnings.push(`card.${k}: ${[...t].length} characters, at most ${max}: ignored`);
      card[k] = t;
    };
    str("tag", 40, true);
    str("what", 600, false);
    str("port", 31, true);
    if ("category" in c) {
      if (CATEGORIES.includes(c.category)) card.category = c.category;
      else warnings.push(`card.category: ${JSON.stringify(c.category)} is not one of ${CATEGORIES.join(", ")}: ignored (the current one is kept)`);
    }
    for (const k of ["site", "editor"]) if (k in c) {
      if (typeof c[k] === "string" && /^https:\/\/[^\s"<>]+$/.test(c[k].trim()) && c[k].trim().length <= 300) card[k] = c[k].trim();
      else warnings.push(`card.${k}: not an https:// URL: ignored`);
    }
    if ("image" in c) {
      const bp = badPath(c.image);
      if (bp) warnings.push(`card.image: ${bp}: ignored`);
      else {
        const f = await src(c.image, MiB);
        if (f.error) warnings.push(`card.image ${c.image}: ${f.size > MiB ? "larger than 1 MiB" : f.error}: ignored`);
        else {
          const info = imageInfo(f.buf);
          if (!info) warnings.push(`card.image ${c.image}: not a PNG, JPEG or WebP image: ignored`);
          else if (!info.w || !info.h) warnings.push(`card.image ${c.image}: could not read its size: ignored`);
          else if (info.w !== info.h) warnings.push(`card.image ${c.image}: ${info.w} x ${info.h}, not square: ignored`);
          else {
            out.image = { path: c.image, ...info, size: f.buf.length, sha256: sha256(f.buf), buf: f.buf };
            if (info.w < 256) warnings.push(`card.image ${c.image}: ${info.w} px is small (512 px is recommended): used`);
          }
        }
      }
    }
  }

  const s = j.skin;
  if (s !== undefined && (typeof s !== "object" || s === null || Array.isArray(s))) warnings.push(`"skin" is not an object: ignored`);
  else if (s) {
    const skin = {};
    for (const k of Object.keys(s)) if (!["background", "landscape", "dim", "theme"].includes(k)) warnings.push(`skin.${k}: unknown field: ignored`);
    for (const k of ["background", "landscape"]) if (k in s) {
      const bp = badPath(s[k]);
      if (bp) { warnings.push(`skin.${k}: ${bp}: ignored`); continue; }
      const f = await src(s[k], 4 * MiB);
      if (f.error) { warnings.push(`skin.${k} ${s[k]}: ${f.size > 4 * MiB ? "larger than 4 MiB" : f.error}: ignored`); continue; }
      const info = imageInfo(f.buf);
      if (!info || info.type === "webp") warnings.push(`skin.${k} ${s[k]}: not a PNG or JPEG image: ignored`);
      else if (!info.w || !info.h) warnings.push(`skin.${k} ${s[k]}: could not read its size: ignored`);
      else if (Math.max(info.w, info.h) > 4096) warnings.push(`skin.${k} ${s[k]}: ${info.w} x ${info.h}, longer side over 4096 px: ignored`);
      else skin[k] = s[k];
    }
    if (skin.landscape && !skin.background) warnings.push("skin.landscape without a usable skin.background: the landscape image is used alone");
    if ("dim" in s) {
      if (typeof s.dim === "number" && s.dim >= 0 && s.dim <= 0.8) skin.dim = s.dim;
      else warnings.push("skin.dim: not a number from 0 to 0.8: ignored (0)");
    }
    if ("theme" in s) {
      const t = s.theme;
      if (!t || typeof t !== "object" || Array.isArray(t)) warnings.push("skin.theme: not an object: ignored");
      else {
        const keys = Object.keys(t), bad = keys.filter((k) => !/^#[0-9A-Fa-f]{6}$/.test(String(t[k])));
        const is14 = keys.length === 14 && ROLES14.every((k) => k in t), is5 = keys.length === 5 && ROLES5.every((k) => k in t);
        if (bad.length) warnings.push(`skin.theme: ${bad.join(", ")} not "#RRGGBB": theme ignored`);
        else if (!is14 && !is5) warnings.push(`skin.theme: give all fourteen roles (${ROLES14.join(", ")}) or the five (${ROLES5.join(", ")}): theme ignored`);
        else skin.theme = t;
      }
    }
    if (skin.background || skin.landscape || skin.theme) out.skin = skin;
    else warnings.push("skin: no usable image or theme: no skin");
  }

  // labels: static panel names (FM1VST embeds them); keys case-insensitive, values upper-cased, 0..10 printable ASCII
  const L = j.labels;
  if (L !== undefined && (typeof L !== "object" || L === null || Array.isArray(L))) warnings.push(`"labels" is not an object: ignored`);
  else if (L) {
    const labels = {};
    for (const k of Object.keys(L)) if (!["buttons", "knobs"].includes(k)) warnings.push(`labels.${k}: unknown field: ignored`);
    for (const [part, names] of [["buttons", LABEL_BUTTONS], ["knobs", LABEL_KNOBS]]) {
      const g = L[part];
      if (g === undefined) continue;
      if (typeof g !== "object" || g === null || Array.isArray(g)) { warnings.push(`labels.${part}: not an object: ignored`); continue; }
      const got = {};
      for (const [k, v] of Object.entries(g)) {
        const key = k.toUpperCase();
        if (!names.includes(key)) { warnings.push(`labels.${part}.${k}: not one of ${names.join(" ")}: ignored`); continue; }
        if (key in got) { warnings.push(`labels.${part}.${k}: given twice: the first is used`); continue; }
        if (typeof v !== "string") { warnings.push(`labels.${part}.${k}: not a string: ignored`); continue; }
        if (!/^[\x20-\x7e]*$/.test(v)) { warnings.push(`labels.${part}.${k}: not printable ASCII: ignored`); continue; }
        if (v.length > 10) { warnings.push(`labels.${part}.${k}: ${v.length} characters, at most 10: ignored`); continue; }
        got[key] = v.toUpperCase();
        if (v.length > 5) warnings.push(`labels.${part}.${k}: "${v}" is ${v.length} characters: hosts may shrink it (5 or fewer draw best): used`);
      }
      if (Object.keys(got).length) labels[part] = got;
    }
    if (labels.buttons || labels.knobs) out.labels = labels;
    else warnings.push("labels: no usable label: none");
  }
  return out;
}

// read + validate the file of the repository checked out at `dir`, at commit `sha`
// -> { found: false } | { found: true, commit, ...validateMetadata }
export async function readAuthorMeta(dir, sha) {
  const src = gitSource(dir, sha);
  const f = await src(META_FILE, 256 * 1024);
  if (f.error === "not found at that commit") return { found: false, commit: sha };
  if (f.error) return { found: true, commit: sha, invalid: true, card: {}, image: null, skin: null, labels: null, warnings: [`${META_FILE}: ${f.error}: ignored`] };
  return { found: true, commit: sha, ...(await validateMetadata(f.buf, src)) };
}
// for logs and result.json (no image bytes)
export const summary = (r) => r && ({ found: r.found, commit: r.commit, invalid: !!r.invalid, card: r.card,
  image: r.image ? { path: r.image.path, type: r.image.type, size: r.image.size, px: r.image.w } : null,
  skin: !!r.skin, labels: labelCounts(r.labels), warnings: r.warnings || [] });
export const labelCounts = (l) => l ? { buttons: Object.keys(l.buttons || {}).length, knobs: Object.keys(l.knobs || {}).length } : null;
