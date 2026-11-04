// SPDX-License-Identifier: GPL-3.0-only
// Catalog metadata kept in the RemoteFM1FW checkout: catalog/catalog.json + catalog/images/<id>.<ext>.
// Schema (also written to catalog/SCHEMA.md): a superset of RemoteFM1's web/site/data/fw-catalog.json card fields.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, moveAside } from "./util.js";
import { CARD_KEYS, imageInfo, sha256, labelCounts } from "./authormeta.js";
import { HUB_CARD_KEYS } from "./hub.js";

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
      "virtual": true,
      "author_meta": { "commit": "<sha>", "fields": { "tag": "...", "image": "docs/card.png" }, "image": { "file": "images/<id>.png", "sha256": "..." }, "skin": true, "labels": { "buttons": 4, "knobs": 4 }, "warnings": [] },
      "overrides": ["what"]
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
- \`author_meta\` and \`overrides\` are RFM1Manager's bookkeeping; readers ignore them and read the card fields above,
  which always hold the values to show. \`author_meta\` is what the firmware's own \`RemoteFM1Metadata.json\` said
  (docs/REMOTEFM1-METADATA.md), read from its repository at \`commit\` (the commit built): \`fields\` are the
  card fields it set (\`image\` as the path in that repository; \`image\` beside it is the copy here and its SHA-256),
  \`skin\` whether it has a usable skin and \`labels\` how many panel labels it gives (both embedded in the .rfm1 by
  FM1VST, not here), \`warnings\` what was wrong with it.
  \`overrides\` lists the card fields the catalog's owner set by hand: those win over the author's values (a field
  listed but absent is one the owner removed). A field neither in \`author_meta.fields\` nor in \`overrides\` is the
  owner's own (every card made before author files existed). An entry without \`author_meta\` has no author file.
  \`hub_meta\` is the fallback from the FM-1 Firmware Hub: the author's \`fmhub.json\` as the Hub's catalog carries it
  (\`sha\`: the Hub's short commit of that file). \`fields\` are the card fields it filled (\`what\`, \`category\`,
  \`editor\`, \`author\`), \`image\` the Hub's copy of the author's picture (its \`url\`, the copy here, its SHA-256). It fills
  only fields that \`author_meta\` does not set and \`overrides\` does not list.
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
// an owner edit: on a firmware with an author file, every card field it changes becomes an override (one set back to the
// author's value stops being one)
export function setMeta(id, fields) {
  if (!ID_RE.test(id)) throw new Error(`bad id ${id}`);
  const m = readMeta();
  const cur = m.firmwares[id] || {};
  const am = cur.author_meta, ov = new Set(cur.overrides || []);
  for (const k of FIELDS) if (k in fields) {
    const v = fields[k], before = cur[k];
    if (v === "" || v === null) delete cur[k];
    else if (k === "editor" && !/^https:\/\/\S+$/.test(String(v))) throw new Error("editor must be an https URL");
    else cur[k] = k === "beta" || k === "virtual" ? !!v : String(v);
    if (am && CARD_KEYS.includes(k) && cur[k] !== before) {
      if (k !== "image" && cur[k] === am.fields?.[k]) ov.delete(k); else ov.add(k);
    } else if (cur.hub_meta && (k in (cur.hub_meta.fields || {}) || (k === "image" && cur.hub_meta.image)) && cur[k] !== before) {
      // a Hub-filled field changed by hand: the owner's from now on
      if (k !== "image" && cur[k] === cur.hub_meta.fields?.[k]) ov.delete(k); else ov.add(k);
    }
  }
  setOverrides(cur, ov);
  m.firmwares[id] = cur;
  save(m);
  return cur;
}
function setOverrides(cur, ov) {
  if (ov.size) cur.overrides = [...ov].sort(); else delete cur.overrides;
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
  setMeta(id, { image: rel });
  // an owner-set image is an override (also when its path is the one it replaces)
  const m = readMeta(), cur = m.firmwares[id];
  if ((cur.author_meta || cur.hub_meta?.image) && !(cur.overrides || []).includes("image")) { setOverrides(cur, new Set([...(cur.overrides || []), "image"])); save(m); }
  return cur;
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
    // a field the firmware's author file sets (and the owner did not override) stays the author's
    const authors = (k) => cur.author_meta?.fields && k in cur.author_meta.fields && !(cur.overrides || []).includes(k);
    const f = feed.get(id);
    if (!f) rep.missing.push("text");
    else for (const k of FEED_FIELDS) {
      const v = f[k];
      if (v === undefined || v === null || v === "") continue;
      if (authors(k) || (k in cur && !overwrite)) { rep.skipped.push(k); continue; }
      cur[k] = k === "beta" ? !!v : String(v); rep.filled.push(k);
    }
    const src = join(cfg.rfm1Thumbs, `${id}.png`);
    if (!existsSync(src)) rep.missing.push("image");
    else if (authors("image") || (cur.image && !overwrite)) rep.skipped.push("image");
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

// ---------- the firmware author's RemoteFM1Metadata.json (lib/authormeta.js) ----------
const fileSha = (rel) => { const p = rel && imagePath(rel); return p && existsSync(p) ? sha256(readFileSync(p)) : null; };
function putImage(id, cur, img, oldSha, log) {
  const rel = `images/${id}.${img.type}`;
  mkdirSync(join(CAT_DIR(), "images"), { recursive: true });
  writeFileSync(join(CAT_DIR(), rel), img.buf);
  // the old author image under another extension: aside (an owner image is never replaced here)
  if (cur.image && cur.image !== rel && oldSha && fileSha(cur.image) === oldSha) moveAside(join(CAT_DIR(), cur.image));
  cur.image = rel;
  return rel;
}
// r: readAuthorMeta's result for the commit built. The author's values fill the card fields they set; an override
// wins; a value already in the card that is neither the author's (now or at the last read) nor the new one is the
// owner's (every card from before author files): it is kept, as an override. Returns { changed, notes }.
export function applyAuthorMeta(id, r, log = () => {}) {
  if (!ID_RE.test(id) || !r) return { changed: false, notes: [] };
  const m = readMeta(), had = m.firmwares[id];
  const before = JSON.stringify(had || null);
  const cur = had ? structuredClone(had) : {}, prev = cur.author_meta, notes = [];
  const ov = new Set(cur.overrides || []);
  if (!r.found) {
    if (!prev) return { changed: false, notes };
    // the file is gone: the values stay, as the owner's
    delete cur.author_meta; delete cur.overrides;
    notes.push("no RemoteFM1Metadata.json at this commit any more: the card keeps its values (now the catalog's own)");
  } else if (r.invalid) {
    cur.author_meta = { ...(prev || { fields: {}, skin: false }), commit: r.commit, warnings: r.warnings };
    notes.push("the author file was ignored: the card is unchanged");
  } else {
    const pf = prev?.fields || {}, hf = cur.hub_meta?.fields || {};
    for (const k of CARD_KEYS) {
      if (k === "image" || ov.has(k)) continue;
      const nv = r.card[k];
      if (nv !== undefined) {
        // a value the Hub's fmhub.json filled is not the owner's: the author's file replaces it
        if (k in cur && cur[k] !== pf[k] && cur[k] !== nv && cur[k] !== hf[k]) { ov.add(k); notes.push(`${k}: the card's own value is kept (an override of the author's)`); }
        else if (cur[k] !== nv) { cur[k] = nv; notes.push(`${k}: from the author file`); }
      } else if (k in pf && cur[k] === pf[k]) { delete cur[k]; notes.push(`${k}: removed (the author file no longer sets it)`); }
    }
    const prevSha = prev?.image?.sha256 || (r.image ? cur.hub_meta?.image?.sha256 : undefined), curSha = fileSha(cur.image);
    let img = null;
    if (r.image) img = { file: `images/${id}.${r.image.type}`, sha256: r.image.sha256 };   // (file: set below)
    if (!ov.has("image")) {
      if (r.image) {
        if (curSha && curSha !== prevSha && curSha !== r.image.sha256 && curSha !== cur.hub_meta?.image?.sha256) { ov.add("image"); notes.push("image: the card's own image is kept (an override of the author's)"); }
        else if (curSha !== r.image.sha256 || cur.image !== img.file) { putImage(id, cur, r.image, prevSha, log); notes.push(`image: ${r.image.path} from the author file`); }
      } else if (prevSha && curSha === prevSha) {
        moveAside(join(CAT_DIR(), cur.image)); delete cur.image; notes.push("image: removed (the author file no longer sets one)");
      }
    }
    // the copy here: only when the card shows the author's image (else just its SHA-256)
    if (img && fileSha(cur.image) === img.sha256) img.file = cur.image; else if (img) delete img.file;
    cur.author_meta = { commit: r.commit, fields: { ...r.card, ...(r.image ? { image: r.image.path } : {}) },
      ...(img ? { image: img } : {}), skin: !!r.skin, ...(r.labels ? { labels: labelCounts(r.labels) } : {}), warnings: r.warnings };
    setOverrides(cur, ov);
    if (cur.hub_meta) {
      for (const k of Object.keys(cur.hub_meta.fields || {})) if (k in r.card) delete cur.hub_meta.fields[k];
      if (r.image) delete cur.hub_meta.image;
      if (!Object.keys(cur.hub_meta.fields || {}).length && !cur.hub_meta.image) delete cur.hub_meta;
    }
  }
  for (const n of notes) log(`RemoteFM1Metadata.json: ${n}`);
  if (JSON.stringify(cur) === before) return { changed: false, notes };
  m.firmwares[id] = cur;
  save(m);
  return { changed: true, notes };
}
// The Hub's copy of the author's fmhub.json (lib/hub.js hubCard) as a fallback: it fills only card fields that the
// author's RemoteFM1Metadata.json does not set and the owner did not override. A field still holding the Hub's last
// value follows the Hub; one changed by hand is kept. fetchImage(url) -> Buffer. Returns { changed, notes }.
export async function applyHubMeta(id, hc, log = () => {}, fetchImage = defaultFetch) {
  if (!ID_RE.test(id)) return { changed: false, notes: [] };
  const m = readMeta(), had = m.firmwares[id];
  const before = JSON.stringify(had || null);
  const cur = had ? structuredClone(had) : {}, prev = cur.hub_meta, notes = [];
  const ov = new Set(cur.overrides || []), am = cur.author_meta?.fields || {};
  const pf = prev?.fields || {}, used = {};
  const free = (k) => !ov.has(k) && !(k in am);
  for (const k of HUB_CARD_KEYS) {
    if (!free(k)) continue;
    const nv = hc?.fields?.[k];
    if (nv !== undefined) {
      if (!(k in cur) || cur[k] === pf[k]) { used[k] = nv; if (cur[k] !== nv) { cur[k] = nv; notes.push(`${k}: from the Hub's fmhub.json`); } }
    } else if (k in pf && cur[k] === pf[k]) { delete cur[k]; notes.push(`${k}: removed (fmhub.json no longer sets it)`); }
  }
  let img = null;
  const prevSha = prev?.image?.sha256, curSha = fileSha(cur.image);
  if (free("image") && !cur.author_meta?.image) {
    if (hc?.imageUrl && (!cur.image || !curSha || curSha === prevSha)) {
      try {
        const buf = await fetchImage(hc.imageUrl), info = buf && imageInfo(buf);
        if (!info || info.w !== info.h || buf.length > 1048576) notes.push(`image: ${hc.imageUrl} skipped (not a square image up to 1 MiB)`);
        else {
          const sha = sha256(buf);
          if (sha !== curSha) { putImage(id, cur, { ...info, buf }, prevSha, log); notes.push("image: from the Hub's fmhub.json"); }
          img = { url: hc.imageUrl, file: cur.image, sha256: sha };
        }
      } catch (e) { notes.push(`image: ${hc.imageUrl} could not be fetched (${e.message})`); if (prev?.image) img = prev.image; }
    } else if (!hc?.imageUrl && prevSha && curSha === prevSha) {
      moveAside(join(CAT_DIR(), cur.image)); delete cur.image; notes.push("image: removed (fmhub.json no longer sets one)");
    }
  }
  if (hc && (Object.keys(used).length || img)) cur.hub_meta = { sha: hc.sha, fields: used, ...(img ? { image: img } : {}) };
  else delete cur.hub_meta;
  for (const n of notes) log(`fmhub.json (Hub): ${n}`);
  if (JSON.stringify(cur) === before) return { changed: false, notes };
  if (Object.keys(cur).length) m.firmwares[id] = cur; else delete m.firmwares[id];
  save(m);
  return { changed: true, notes };
}
async function defaultFetch(url) {
  const r = await fetch(url, { headers: { "User-Agent": "RFM1Manager" }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
// the owner's override of `field` cleared: the author's value comes back (a field the author does not set keeps its
// value, now the owner's own). loadImage(commit, path) -> Buffer, for the image.
export async function clearOverride(id, field, loadImage) {
  if (!ID_RE.test(id)) throw new Error(`bad id ${id}`);
  const m = readMeta(), cur = m.firmwares[id];
  if (!cur || !(cur.overrides || []).includes(field)) throw Object.assign(new Error(`${id}: ${field} is not an override`), { status: 400 });
  const am = cur.author_meta || { fields: {} };
  if (field === "image" && am.fields.image) {
    const buf = await loadImage(am.commit, am.fields.image);
    const info = buf && imageInfo(buf);
    if (!info || info.w !== info.h || buf.length > 1048576) throw new Error(`the author's image ${am.fields.image} at ${am.commit.slice(0, 12)} could not be read`);
    putImage(id, cur, { ...info, buf }, null);
    am.image = { file: cur.image, sha256: sha256(buf) };
  } else if (field !== "image" && field in am.fields) cur[field] = am.fields[field];
  setOverrides(cur, new Set(cur.overrides.filter((k) => k !== field)));
  save(m);
  return cur;
}
