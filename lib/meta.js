// SPDX-License-Identifier: GPL-3.0-only
// Catalog metadata kept in the RemoteFM1FW checkout: catalog/catalog.json + catalog/images/<id>.<ext>.
// Schema (also written to catalog/SCHEMA.md): a superset of RemoteFM1's web/site/data/fw-catalog.json card fields.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "./util.js";

export const CAT_DIR = () => join(cfg.fwRepo, "catalog");
const FILE = () => join(CAT_DIR(), "catalog.json");
export const FIELDS = ["description", "image", "author", "category", "tag", "what", "site", "editor", "port", "beta", "virtual"];
const ID_RE = /^[a-z0-9_]{1,31}$/;

export const SCHEMA_MD = `# RemoteFM1FW catalog metadata (schema 1)

\`catalog/catalog.json\` adds card text and a thumbnail to the \`.rfm1\` files of this repository's releases. Everything
else about a firmware (id, name, version, licence, authors, source_url at its commit, built_by) is the file's own
manifest (the \`rfm1\` custom section, RemoteFM1IOS docs/RFM1-FORMAT.md section 4); this file never repeats it.

\`\`\`json
{
  "schema": 1,
  "about": "free text",
  "firmwares": {
    "<id>": {
      "description": "(not read by RemoteFM1 yet; \`what\` is the description it shows)",
      "image": "images/<id>.png",
      "author": "short author name for a card (optional; the manifest's authors are the credit)",
      "category": "Synth | Groovebox | Drums | Sampler | Other ...",
      "tag": "a short subtitle",
      "what": "the description RemoteFM1 (site and iOS app) shows for the firmware: one paragraph",
      "site": "https://... (optional: the firmware's own page)",
      "editor": "https://... (optional: the author's own web editor / manager page)",
      "port": "Felucca (optional: the firmware's USB MIDI port name)",
      "beta": false,
      "virtual": true
    }
  }
}
\`\`\`

- \`virtual\` (only when true) marks a Fantasy CFW: the file's manifest says \`"virtual": true\` (FM1VST docs/VIRTUAL-CARTS.md).
  It runs in RemoteFM1's apps only, never on an FM-1, and has no device package. RFM1Manager copies it from the manifest
  when it stages a release; don't set it by hand.
- \`editor\` is the https URL of the firmware author's own web editor or manager (never a copy hosted elsewhere). The
  RemoteFM1 apps open it with Web MIDI injected, wired to the firmware running in the app.
- \`port\` is the firmware's USB MIDI port name as its USB descriptor gives it (e.g. \`Felucca\`,
  \`ChoralRoot FM-1\`): editors look for an output whose name contains it, so the apps name their in-app port so.
- Keys of \`firmwares\` are manifest ids (\`[a-z0-9_]{1,31}\`). Every field is optional; unknown fields are ignored.
- \`image\` is relative to \`catalog/\`; PNG, JPEG or WebP, square, 512 px recommended, at most 1 MiB.
- Readers fetch \`https://raw.githubusercontent.com/Quixotic7/RemoteFM1FW/<tag or main>/catalog/catalog.json\` and images
  beside it. The fields \`author\`, \`category\`, \`tag\`, \`what\`, \`site\`, \`beta\` are the ones RemoteFM1's
  \`web/site/data/fw-catalog.json\` uses, so the site's build_catalog.mjs can read this file in its place.
`;

export function readMeta() {
  if (!existsSync(FILE())) return { schema: 1, about: "Card text and thumbnails for the .rfm1 files of Quixotic7/RemoteFM1FW, by manifest id (catalog/SCHEMA.md).", firmwares: {} };
  return JSON.parse(readFileSync(FILE(), "utf8"));
}
function save(m) {
  mkdirSync(join(CAT_DIR(), "images"), { recursive: true });
  const sorted = { ...m, firmwares: Object.fromEntries(Object.entries(m.firmwares).sort(([a], [b]) => a.localeCompare(b))) };
  writeFileSync(FILE(), JSON.stringify(sorted, null, 1) + "\n");
  writeFileSync(join(CAT_DIR(), "SCHEMA.md"), SCHEMA_MD);
}
export function setMeta(id, fields) {
  if (!ID_RE.test(id)) throw new Error(`bad id ${id}`);
  const m = readMeta();
  const cur = m.firmwares[id] || {};
  for (const k of FIELDS) if (k in fields) {
    const v = fields[k];
    if (v === "" || v === null) delete cur[k];
    else if (k === "editor" && !/^https:\/\/\S+$/.test(String(v))) throw new Error("editor must be an https URL");
    else cur[k] = k === "beta" || k === "virtual" ? !!v : String(v);
  }
  m.firmwares[id] = cur;
  save(m);
  return cur;
}
const SIG = [["png", (b) => b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG"], ["jpg", (b) => b[0] === 0xff && b[1] === 0xd8],
  ["webp", (b) => b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP"]];
export function setImage(id, buf) {
  if (!ID_RE.test(id)) throw new Error(`bad id ${id}`);
  if (buf.length > 1048576) throw new Error("image larger than 1 MiB");
  const t = SIG.find(([, f]) => f(buf));
  if (!t) throw new Error("not a PNG, JPEG or WebP image");
  mkdirSync(join(CAT_DIR(), "images"), { recursive: true });
  const rel = `images/${id}.${t[0]}`;
  writeFileSync(join(CAT_DIR(), rel), buf);
  return setMeta(id, { image: rel });
}
export function imagePath(rel) {
  if (!/^images\/[a-z0-9_]+\.(png|jpg|webp)$/.test(rel)) return null;
  return join(CAT_DIR(), rel);
}

// Fill text from RemoteFM1's feed (the one RemoteFM1IOS reads) and thumbnails from RemoteFM1IOS's bundled Thumbs.
// Fields and images already set are kept unless overwrite is true.
const FEED_FIELDS = ["tag", "what", "category", "author", "site", "beta"];
export async function importRemoteFM1(ids, overwrite = false) {
  const r = await fetch(cfg.rfm1Feed);
  if (!r.ok) throw new Error(`${cfg.rfm1Feed}: HTTP ${r.status}`);
  const feed = new Map(((await r.json()).firmwares || []).map((f) => [f.id, f]));
  const m = readMeta(), report = {};
  for (const id of ids) {
    if (!ID_RE.test(id)) continue;
    const cur = m.firmwares[id] || {}, rep = { filled: [], skipped: [], missing: [] };
    const f = feed.get(id);
    if (!f) rep.missing.push("text");
    else for (const k of FEED_FIELDS) {
      const v = f[k];
      if (v === undefined || v === null || v === "") continue;
      if (k in cur && !overwrite) { rep.skipped.push(k); continue; }
      cur[k] = k === "beta" ? !!v : String(v); rep.filled.push(k);
    }
    const src = join(cfg.rfm1Thumbs, `${id}.png`);
    if (!existsSync(src)) rep.missing.push("image");
    else if (cur.image && !overwrite) rep.skipped.push("image");
    else {
      mkdirSync(join(CAT_DIR(), "images"), { recursive: true });
      copyFileSync(src, join(CAT_DIR(), `images/${id}.png`));
      cur.image = `images/${id}.png`; rep.filled.push("image");
    }
    if (Object.keys(cur).length) m.firmwares[id] = cur;
    report[id] = rep;
  }
  save(m);
  return report;
}

// A Fantasy CFW's flag comes from its manifest ("virtual": true), never by hand: set on those, removed from the rest.
export function syncVirtual(files) {
  const m = readMeta();
  let changed = false;
  for (const f of files) {
    const id = f.manifest?.id, v = f.manifest?.virtual === true;
    if (!id || !ID_RE.test(id)) continue;
    const cur = m.firmwares[id];
    if (v && cur?.virtual !== true) { m.firmwares[id] = { ...(cur || {}), virtual: true }; changed = true; }
    else if (!v && cur && "virtual" in cur) { delete cur.virtual; changed = true; }
  }
  if (changed) save(m);
  return changed;
}
