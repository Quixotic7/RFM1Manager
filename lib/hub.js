// SPDX-License-Identifier: GPL-3.0-only
// The FM-1 Firmware Hub (thefirmwarehub.com) as a second update source. Some authors publish only there (no GitHub
// release or tag), e.g. JIANT. The hub's own catalog (https://thefirmwarehub.com/catalog.json, CORS *, max-age 600;
// what RemoteFM1's Pages build and fm1-native.sh read) is the direct source; RemoteFM1's published
// https://remotefm1.com/catalog.json (`hubSource`, `hubUpdated`, the same `firmwares[]` fields) is the fallback.
// Only non-beta entries whose version is a clean number and whose source names a commit (or a tag) of the same
// repository are ever used; the commit is resolved to its full SHA on GitHub.
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cfg, run, PRE_RE } from "./util.js";

export const HUB_URL = "https://thefirmwarehub.com/catalog.json";

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "RFM1Manager", Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j.firmwares)) throw new Error(`${url}: no firmwares[]`);
  return j;
}

// { from, url, updated, firmwares: [raw hub entries] } (cached 10 minutes in cache/hub.json)
export async function hubCatalog(force = false) {
  const cf = join(cfg.cache, "hub.json");
  if (!force && existsSync(cf) && Date.now() - statSync(cf).mtimeMs < 10 * 60e3) return JSON.parse(readFileSync(cf, "utf8"));
  let v = null;
  const errs = [];
  for (const [from, url] of [["hub", cfg.hubUrl || HUB_URL], ["remotefm1", cfg.rfm1Feed]]) {
    try {
      const j = await getJson(url);
      v = { from, url, updated: j.updated || j.hubUpdated || null, hubSource: j.hubSource || null, firmwares: j.firmwares, errors: errs.slice() };
      break;
    } catch (e) { errs.push(String(e.message)); }
  }
  if (!v) {
    // both down: the last good copy, however old
    if (existsSync(cf)) return { ...JSON.parse(readFileSync(cf, "utf8")), stale: true, errors: errs };
    return { from: null, firmwares: [], errors: errs };
  }
  writeFileSync(cf, JSON.stringify(v));
  return v;
}

const slugOf = (s) => {
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(String(s || "").trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
};

// the hub entry for a manifest id + GitHub slug: the same id (and repo, when it names one) first, else the only
// entry of that repository (several entries of one repo, e.g. Felucca forks under other ids, are ambiguous: none)
export function hubEntryFor(hub, id, slug) {
  const s = (slug || "").toLowerCase();
  const fws = hub.firmwares || [];
  const byId = fws.find((f) => f.id === id && (!f.repo || !s || slugOf(f.repo) === s));
  if (byId) return byId;
  const byRepo = fws.filter((f) => s && slugOf(f.repo) === s);
  return byRepo.length === 1 ? byRepo[0] : null;
}

// "V10.9-f46764d" -> "10.9", "1.0.3-365b2e2" -> "1.0.3", "v1.8.0" -> "1.8.0"; anything else (beta words, names,
// dates with a build suffix, a bare SHA) -> null. The author's numbering is kept as is.
export function cleanHubVersion(v) {
  let s = String(v || "").trim();
  s = s.replace(/\+[\w.]+$/, "").replace(/[-_.]g?[0-9a-f]{7,40}$/i, "");
  if (PRE_RE.test(s)) return null;
  s = s.replace(/^[vV](?=\d)/, "");
  return /^\d+(\.\d+){0,3}$/.test(s) ? s : null;
}

// the hub's offer for one firmware, checked: { ok, version, sha, ref, raw, source, slug, date, reason? }
export async function hubOffer(hub, id, slug) {
  const e = hubEntryFor(hub, id, slug);
  if (!e) return { ok: false, reason: "not on the hub" };
  const base = { hubId: e.id, raw: e.version, source: e.source, date: e.published || e.date || null, from: hub.from };
  if (e.beta) return { ...base, ok: false, reason: `beta on the hub (${e.version})` };
  const version = cleanHubVersion(e.version);
  if (!version) return { ...base, ok: false, reason: `version "${e.version}" is not a plain stable number` };
  const m = /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/tree\/([^/?#\s]+)\/?$/i.exec(e.source || "");
  const srcSlug = m ? `${m[1]}/${m[2]}` : null;
  if (!m || srcSlug.toLowerCase() !== String(slug).toLowerCase()) return { ...base, ok: false, reason: `source ${e.source || "(none)"} is not a commit of ${slug}` };
  const ref = /^[0-9a-f]{40}$/i.test(e.srcref || "") ? e.srcref : decodeURIComponent(m[3]);
  const isSha = /^[0-9a-f]{7,40}$/i.test(ref);
  if (!isSha) {
    // a tag only (a branch such as main moves: not a release)
    const t = await run("gh", ["api", `repos/${slug}/git/ref/tags/${encodeURIComponent(ref)}`, "-q", ".ref"]);
    if (t.code !== 0) return { ...base, ok: false, reason: `source ref ${ref} is neither a commit nor a tag of ${slug}` };
    if (PRE_RE.test(ref)) return { ...base, ok: false, reason: `source tag ${ref} is a prerelease name` };
  }
  const c = await run("gh", ["api", `repos/${slug}/commits/${encodeURIComponent(ref)}`, "-q", ".sha"]);
  const sha = c.code === 0 ? c.out.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(sha) || (isSha && !sha.startsWith(ref.toLowerCase())))
    return { ...base, ok: false, reason: `${ref} does not resolve to a commit of ${slug}${c.code ? `: ${(c.err || "").trim().slice(0, 160)}` : ""}` };
  return { ...base, ok: true, version, sha, ref, slug: srcSlug };
}

// which source an update takes (owner rule, README "Firmware hub"): GitHub's stable release/tag when there is one
// newer than the current version; the hub's non-beta release instead when GitHub has none newer, or the hub's version
// is newer than GitHub's latest stable (a hub release naming GitHub's own commit stays a GitHub release).
// Returns the `up` the build pins ({ slug, tag, sha, version, source: "release"|"tag"|"hub", ... }) or null.
export function chooseUpdate(gh, hub, cur, pin, cmpVer) {
  const newer = (u) => u && u.sha && u.sha !== pin && u.version && (!cur || cmpVer(u.version, cur) > 0);
  const g = newer(gh) ? gh : null;
  const h = hub && hub.ok && newer(hub) ? hub : null;
  if (h && (!g || (cmpVer(h.version, g.version) > 0 && h.sha !== g.sha))) {
    return { slug: hub.slug, tag: null, sha: hub.sha, version: hub.version, source: "hub", hubId: hub.hubId, hubVersion: hub.raw,
      hubSource: hub.source, hubFrom: hub.from, date: hub.date, ref: hub.ref };
  }
  return g;
}

// the human label for a pinned update ("v1.8.0 = 9f62297, stable release" / "f46764d, firmware hub non-beta release")
export function updateLabel(up) {
  if (!up) return "";
  return up.source === "hub" ? `${up.sha.slice(0, 7)}, firmware hub non-beta release` : `${up.tag} = ${up.sha.slice(0, 7)}, GitHub ${up.source === "tag" ? "tag" : "release"}`;
}
