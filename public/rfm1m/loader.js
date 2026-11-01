// RFM1Manager's loader for its copy of the RemoteFM1 site (lib/site.js serves index.html with this in place of
// js/main.js). ?rfm1=<manager path of an .rfm1>&rfm1id=<manifest id>: the file goes into the site's own library
// (js/library.js, IndexedDB, as "Add firmware…" does), is made the last-opened firmware, and the site starts with it.
// Then a small "Capture thumbnail" control: the live 240x240 LCD (the site's FM1Site.screen(), RGB565) as a PNG, to
// the manager's POST /api/meta/<id>/image.
const q = new URLSearchParams(location.search);
const src = q.get("rfm1"), wantId = q.get("rfm1id");
const PREF_KEY = "remotefm1-player", MINE = "rfm1manager-added";   // (the site's prefs key: js/prefs.js)
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const store = (() => { try { return localStorage; } catch (_) { return null; } })();
const readJson = (k) => { try { return JSON.parse(store.getItem(k)) || {}; } catch (_) { return {}; } };
const writeJson = (k, v) => { try { store.setItem(k, JSON.stringify(v)); } catch (_) {} };

function banner(text, bad = false) {
  const d = document.createElement("div");
  d.textContent = text;
  d.style.cssText = `position:fixed;left:12px;bottom:12px;z-index:9999;padding:8px 12px;border-radius:8px;font:13px system-ui;max-width:60vw;background:${bad ? "#a22" : "#222"};color:#fff`;
  document.body.append(d);
  if (!bad) setTimeout(() => d.remove(), 6000);
}

let loadedId = wantId;
if (src) {
  try {
    const r = await fetch(src, { cache: "no-store" });
    if (!r.ok) throw new Error(`${src}: HTTP ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const fileName = decodeURIComponent(src.split("/").pop());
    const engine = await import(new URL("../engines/rfm1/engine.js", document.baseURI).href);
    const library = await import(new URL("js/library.js", document.baseURI).href);
    const file = engine.inspect(bytes);
    loadedId = file.manifest.id;
    const sha = hex(await crypto.subtle.digest("SHA-256", bytes));
    const recs = await library.list();
    if (!recs.some((x) => x.sha256 === sha)) await library.add({ sha256: sha, fileName, manifest: file.manifest, credits: file.credits, bytes });
    // the manager's earlier file of this id leaves Your firmware (only the ones it added itself)
    const mine = readJson(MINE);
    if (mine[loadedId] && mine[loadedId] !== sha && recs.some((x) => x.sha256 === mine[loadedId])) await library.remove(mine[loadedId]).catch(() => {});
    mine[loadedId] = sha; writeJson(MINE, mine);
    const prefs = readJson(PREF_KEY); prefs.last = "rfm1:" + sha; writeJson(PREF_KEY, prefs);
    document.title = `${file.manifest.name} ${file.manifest.version} · RFM1Manager test`;
  } catch (e) {
    console.error(e);
    setTimeout(() => banner(`RFM1Manager: could not load ${src}: ${e.message || e}`, true), 0);
  }
}
await import(new URL("js/main.js", document.baseURI).href);
if (loadedId) mountCapture();

// ---------------------------------------------------------------- capture ---
function lcdPng() {
  const site = window.FM1Site;
  if (!site) throw new Error("the site is still starting");
  const s = site.screen();
  if (!s.seq) throw new Error("no LCD frame yet: press Play first");
  const c = Object.assign(document.createElement("canvas"), { width: 240, height: 240 });
  const ctx = c.getContext("2d"), img = ctx.createImageData(240, 240), d = img.data;
  for (let i = 0, o = 0; i < 240 * 240; i++, o += 4) {
    const p = s.pixels[i], r = (p >> 11) & 31, g = (p >> 5) & 63, b = p & 31;
    d[o] = (r << 3) | (r >> 2); d[o + 1] = (g << 2) | (g >> 4); d[o + 2] = (b << 3) | (b >> 2); d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
function currentId() {
  const e = window.FM1Site?.current()?.entry;
  return e && e.local && e.rfm1 ? e.id : null;
}
function mountCapture() {
  const box = document.createElement("div");
  box.id = "rfm1m-capture";
  box.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:9999;background:#1d1f24;color:#eee;border:1px solid #444;border-radius:10px;padding:8px;font:13px system-ui;box-shadow:0 4px 16px #0008;display:flex;flex-direction:column;gap:6px;align-items:stretch";
  const btn = (t) => Object.assign(document.createElement("button"), { textContent: t, style: "font:13px system-ui;padding:4px 10px;border-radius:6px;border:1px solid #666;background:#2c2f36;color:#eee;cursor:pointer" });
  const take = btn("Capture thumbnail"), use = btn("Use as thumbnail"), retake = btn("Retake"), cancel = btn("Cancel");
  const msg = document.createElement("div"), prev = document.createElement("div"), row = document.createElement("div");
  msg.style.cssText = "max-width:240px;color:#bbb";
  row.style.cssText = "gap:6px"; row.append(use, retake, cancel);
  const showRow = (on) => { row.style.display = on ? "flex" : "none"; };
  prev.hidden = true; showRow(false);
  box.append(take, prev, row, msg);
  document.body.append(box);
  let shot = null, shotId = null;
  const snap = () => {
    try {
      shotId = currentId() || loadedId;
      shot = lcdPng(); shot.style.cssText = "width:240px;height:240px;image-rendering:pixelated;border-radius:4px;display:block";
      prev.replaceChildren(shot); prev.hidden = false; showRow(true); take.hidden = true;
      msg.textContent = `thumbnail for ${shotId}`;
    } catch (e) { msg.textContent = e.message; }
  };
  const close = () => { prev.hidden = true; showRow(false); take.hidden = false; shot = null; };
  take.onclick = snap; retake.onclick = snap; cancel.onclick = () => { close(); msg.textContent = ""; };
  use.onclick = async () => {
    if (!shot) return;
    try {
      const meta = await (await fetch("/api/meta", { cache: "no-store" })).json();
      const had = meta.firmwares?.[shotId]?.image;
      if (had && !confirm(`${shotId} already has a thumbnail (${had}). Replace it?`)) return;
      const png = await new Promise((ok) => shot.toBlob(ok, "image/png"));
      const r = await fetch(`/api/meta/${shotId}/image`, { method: "POST", headers: { "Content-Type": "image/png" }, body: png });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error || `HTTP ${r.status}`);
      close(); msg.textContent = `saved ${v.image} for ${shotId}`;
    } catch (e) { msg.textContent = `not saved: ${e.message || e}`; }
  };
}
