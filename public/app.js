// RFM1Manager UI (vanilla JS)
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const status = (t) => { $("#status").textContent = t; };
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: opts.body && !(opts.body instanceof Blob) ? { "Content-Type": "application/json" } : {}, ...opts,
    body: opts.body && !(opts.body instanceof Blob) && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body });
  const t = r.headers.get("content-type") || "";
  const v = t.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error(v.error || v);
  return v;
}
// "Test in RemoteFM1": the manager's copy of the site with this file loaded (lib/site.js, public/rfm1m/loader.js)
const testUrl = (file, id) => `/rfm1/site/?rfm1=${encodeURIComponent(file)}&rfm1id=${encodeURIComponent(id)}`;
const testLink = (href, text = "Test in RemoteFM1") => `<a class="btn" href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const fmtSize = (n) => n == null ? "" : n > 1e6 ? (n / 1048576).toFixed(2) + " MiB" : (n / 1024).toFixed(0) + " KiB";

// tabs
for (const b of document.querySelectorAll("#tabs button")) b.onclick = () => {
  document.querySelectorAll("#tabs button, .tab").forEach((x) => x.classList.remove("on"));
  b.classList.add("on"); $("#" + b.dataset.tab).classList.add("on");
  ({ jobs: loadJobs, meta: loadMeta, readme: () => !$("#rd-text").value && loadReadme() })[b.dataset.tab]?.();
};

// ---------- catalog ----------
let CAT = null;
async function loadCatalog(upstream = false, force = false) {
  status(upstream ? "checking upstream releases…" : "loading catalog…");
  try {
    CAT = await api(`/api/catalog?upstream=${upstream ? 1 : 0}&force=${force ? 1 : 0}`);
    const hubInfo = CAT.hub ? `, firmware hub ${CAT.hub.from ? `via ${CAT.hub.from === "hub" ? "thefirmwarehub.com" : "remotefm1.com (fallback)"} ${esc(CAT.hub.updated || "")}${CAT.hub.stale ? " (stale copy)" : ""}` : '<span class="warn">unreachable</span>'}` : "";
    $("#cat-info").innerHTML = `release <a href="${esc(CAT.release.url)}" target="_blank" rel="noopener">${esc(CAT.release.tag)}</a> (${CAT.release.assets} assets), glue from branch <code>${esc(CAT.glueRef)}</code>${hubInfo}`;
    renderCatalog(upstream);
    status("");
  } catch (e) { status("error: " + e.message); }
}
function renderCatalog(up) {
  const tb = $("#cat-table tbody");
  tb.innerHTML = CAT.firmwares.map((f) => {
    const u = f.upstream;
    const h = f.hub;
    const ghCell = u?.tag ? `<code>${esc(u.tag)}</code> <span class="mut">${esc((u.sha || "").slice(0, 7))} (GitHub ${esc(u.source)})</span>` : `<span class="warn">${esc(u?.error || "?")}</span>`;
    const hubCell = !h ? "" : h.ok ? `<br><code>${esc(h.raw)}</code> <span class="mut">${esc((h.sha || "").slice(0, 7))} (hub release)</span>`
      : h.raw ? `<br><span class="mut" title="${esc(h.reason || "")}">hub ${esc(h.raw)}${h.reason && !/not newer/.test(h.reason) ? " (not used)" : ""}</span>` : "";
    const upCell = !up ? '<span class="mut">—</span>' : ghCell + hubCell;
    const src = f.update ? (f.update.source === "hub" ? "hub release" : `GitHub ${f.update.source}`) : "";
    const flag = !up ? "" : f.updateAvailable ? `<span class="pill warn" title="${esc(f.update.version)} at ${esc(f.update.sha.slice(0, 7))}">update: ${esc(f.update.version)}</span><br><span class="mut">${esc(src)}</span>` : f.pinMatchesStable ? '<span class="pill ok">at stable</span>' : u?.tag ? '<span class="pill mut">pin ≠ tag</span>' : "";
    const pinOk = f.glue?.pin && f.releaseCommit && f.glue.pin.startsWith(f.releaseCommit) ? "" : f.releaseCommit ? ' <span class="warn" title="the release file was built from another commit">≠ release</span>' : "";
    return `<tr>
      <td><b>${esc(f.id)}</b>${f.hostedDespiteGate ? ' <span class="pill warn" title="' + esc(f.hostedDespiteGate) + '">hosted only</span>' : ""}</td>
      <td>${esc(f.name)} ${esc(f.version || "")}<br><span class="mut">${esc(f.authors.join(", "))} · ${esc(f.license || "")}</span></td>
      <td>${f.releaseFile ? `<code>${esc(f.releaseFile)}</code><br><span class="mut">${fmtSize(f.size)}</span>` : '<span class="warn">not released</span>'}</td>
      <td>${f.repo ? `<a href="https://github.com/${esc(f.repo)}" target="_blank" rel="noopener">${esc(f.repo)}</a>` : ""}<br><span class="mut">${esc(f.glue?.family || "")}</span></td>
      <td>${esc(f.glue?.version || (f.glue?.versionFile ? "file" : ""))}</td>
      <td><code>${esc((f.glue?.pin || "").slice(0, 7))}</code>${pinOk}</td>
      <td>${upCell}</td><td>${flag}</td>
      <td>${f.releaseFile || f.glue?.rfm1 ? testLink(`/rfm1m/open/${f.id}`) + " " : ""}${f.glue?.rfm1 ? `<button data-b="${esc(f.id)}">Rebuild</button> <button data-u="${esc(f.id)}"${up && !f.updateAvailable ? " disabled" : ""}>Update + build</button>` : '<span class="mut">no fm1_add_rfm1</span>'}</td></tr>`;
  }).join("");
  tb.querySelectorAll("button[data-b]").forEach((b) => b.onclick = () => startBuild(b.dataset.b, false));
  tb.querySelectorAll("button[data-u]").forEach((b) => b.onclick = () => startBuild(b.dataset.u, true));
}
async function startBuild(id, update) {
  try { const j = await api("/api/build", { method: "POST", body: { id, update } }); openJobTab(j.id); }
  catch (e) { alert(e.message); }
}
async function loadSite() {
  try {
    const s = await api("/api/site");
    $("#site-info").innerHTML = s.commit ? `site <code>${esc(s.commit.slice(0, 7))}</code> ${esc(s.subject || "")}${s.current ? "" : ` <span class="warn">origin/main is ${esc((s.originMain || "?").slice(0, 7))}: refresh</span>`}` : '<span class="mut">site not exported yet (the first test exports it)</span>';
  } catch (e) { $("#site-info").textContent = e.message; }
}
$("#site-refresh").onclick = async () => {
  $("#site-info").textContent = "fetching RemoteFM1 origin/main…";
  try { await api("/api/site/refresh", { method: "POST" }); } catch (e) { alert(e.message); }
  loadSite();
};
loadSite();
$("#cat-load").onclick = () => loadCatalog(false, true);
$("#cat-up").onclick = () => loadCatalog(true, true);
$("#cat-update-all").onclick = async () => {
  if (!confirm("Update every firmware with a newer stable release (GitHub, or the firmware hub's non-beta release), and build each?")) return;
  try { const j = await api("/api/build-all", { method: "POST", body: { update: true } }); openJobTab(j.id); } catch (e) { alert(e.message); }
};

// ---------- jobs & logs ----------
let follow = null;
function openJobTab(id) { $('#tabs button[data-tab="jobs"]').click(); watchJob(id); }
async function loadJobs() {
  const [jobs, logs] = await Promise.all([api("/api/jobs"), api("/api/logs")]);
  $("#job-list").innerHTML = jobs.reverse().map((j) => `<li data-j="${j.id}"><span class="${j.status === "ok" ? "ok" : j.status === "failed" ? "bad" : "warn"}">●</span> #${j.id} ${esc(j.label)} <span class="mut">${esc(j.status)}</span></li>`).join("") || '<li class="mut">none yet</li>';
  $("#log-list").innerHTML = logs.map((l) => `<li data-l="${esc(l.name)}"><span class="${l.ok ? "ok" : l.ok === false ? "bad" : "mut"}">●</span> ${esc(l.name)}</li>`).join("");
  $("#job-list").querySelectorAll("li[data-j]").forEach((li) => li.onclick = () => watchJob(li.dataset.j));
  $("#log-list").querySelectorAll("li[data-l]").forEach((li) => li.onclick = () => showBundle(li.dataset.l));
}
async function watchJob(id) {
  if (follow) clearTimeout(follow);
  let since = 0;
  $("#view").textContent = "";
  const tick = async () => {
    const j = await api(`/api/jobs/${id}?since=${since}`);
    since += j.lines.length;
    $("#view-title").textContent = `job #${j.id} ${j.label}: ${j.status}`;
    const v = $("#view"), atEnd = v.scrollTop + v.clientHeight >= v.scrollHeight - 30;
    v.textContent += j.lines.map((l) => l + "\n").join("");
    if (atEnd) v.scrollTop = v.scrollHeight;
    if (j.bundle) {
      const name = j.bundle.split("/").pop();
      $("#view-files").innerHTML = ["SUMMARY-FOR-LLM.md", "error-excerpt.txt", "build.log", "commands.txt", "versions.txt", "env.txt", "result.json"]
        .map((f) => `<a href="#" data-bf="${esc(name)}/${f}">${f}</a>`).join(" · ");
      $("#view-files").querySelectorAll("a").forEach((a) => a.onclick = (e) => { e.preventDefault(); if (follow) clearTimeout(follow); showFile(a.dataset.bf); });
    }
    const out = j.result?.out?.split("/").pop();
    if (out && j.result.manifest?.id) $("#view-files").insertAdjacentHTML("beforeend", " " + testLink(testUrl(`/files/out/${out}`, j.result.manifest.id)));
    if (j.status === "running") follow = setTimeout(tick, 1200); else { follow = null; loadJobs(); if (j.type === "build" && CAT) loadCatalog(false); }
  };
  tick();
}
async function showBundle(name) {
  if (follow) clearTimeout(follow);
  const logs = await api("/api/logs");
  const l = logs.find((x) => x.name === name);
  $("#view-files").innerHTML = l.files.map((f) => `<a href="#" data-bf="${esc(name)}/${esc(f)}">${esc(f)}</a>`).join(" · ");
  $("#view-files").querySelectorAll("a").forEach((a) => a.onclick = (e) => { e.preventDefault(); showFile(a.dataset.bf); });
  if (l.files.includes("result.json")) api(`/api/logs/${name}/result.json`).then((r) => {
    const out = r.out?.split("/").pop();
    if (out && r.manifest?.id) $("#view-files").insertAdjacentHTML("beforeend", " " + testLink(testUrl(`/files/out/${out}`, r.manifest.id)));
  }).catch(() => {});
  showFile(`${name}/${l.files.includes("SUMMARY-FOR-LLM.md") ? "SUMMARY-FOR-LLM.md" : "build.log"}`);
}
async function showFile(p) {
  $("#view-title").textContent = p;
  $("#view").textContent = p.endsWith(".wav") ? "(audio file: open /api/logs/" + p + ")" : await api(`/api/logs/${p}`).then((x) => typeof x === "string" ? x : JSON.stringify(x, null, 1));
}
$("#copy-view").onclick = () => navigator.clipboard.writeText($("#view").textContent).then(() => status("copied"));

// ---------- add firmware ----------
async function add(mode) {
  const url = $("#add-url").value.trim();
  if (!url) return;
  if (mode === "scaffold") await checkExisting();
  try {
    const j = await api("/api/add", { method: "POST", body: { url, id: $("#add-id").value.trim() || undefined, mode, target: $("#add-target").value, hostedDespiteGate: $("#add-hdg").value.trim() || undefined } });
    $("#add-out").textContent = `job #${j.id} started; following in Builds & logs`;
    openJobTab(j.id);
  } catch (e) { $("#add-out").textContent = "error: " + e.message; }
}
// a repository that is already a core in FM1VST is never scaffolded as a copy: Add enables it as .rfm1 + updates it
let addExisting = null, addTimer = null;
async function checkExisting() {
  const url = $("#add-url").value.trim();
  addExisting = null;
  $("#add-scaffold").textContent = "Scaffold + build";
  $("#add-existing").classList.add("hidden");
  $("#add-hdg-l").classList.add("hidden");
  if (!/github\.com\/[^/]+\/[^/\s]+/.test(url)) return null;
  try {
    const r = await api(`/api/existing?url=${encodeURIComponent(url)}`);
    if (r.cores && r.cores.length) {
      const c = r.cores.find((x) => !x.rfm1) || r.cores[0];
      addExisting = c;
      $("#add-scaffold").textContent = c.rfm1 ? "Update + build" : "Enable as .rfm1 + update";
      $("#add-existing").textContent = `already a core in FM1VST (${c.id}, ${c.file}): ${c.action}. No copy is scaffolded; it runs in the manager worktree and commits only when every check passes.`;
      $("#add-existing").classList.remove("hidden");
      $("#add-hdg-l").classList.toggle("hidden", !(c.gated && !c.rfm1));
      if (c.gated && !c.rfm1) $("#add-existing").textContent += ` It is GATED (${c.gated}): enabling it needs your reason for hosting it (HOSTED_DESPITE_GATE, built with FM1_PUBLIC_BUILD=OFF).`;
    }
  } catch { /* the check is a hint only */ }
  return addExisting;
}
$("#add-url").addEventListener("input", () => { clearTimeout(addTimer); addTimer = setTimeout(checkExisting, 400); });
$("#add-detect").onclick = () => add("detect");
$("#add-scaffold").onclick = () => add("scaffold");

// ---------- metadata ----------
async function loadMeta() {
  if (!CAT) await loadCatalog(false);
  const m = await api("/api/meta");
  const F = ["tag", "category", "author", "site"];
  const L = { tag: "tag (the line under the name)" };
  $("#meta-list").innerHTML = CAT.firmwares.map((f) => {
    const e = m.firmwares[f.id] || {};
    return `<div class="card" data-id="${esc(f.id)}">
      <div class="row"><img src="${e.image ? "/api/meta/" + esc(e.image) + "?t=" + Date.now() : ""}" alt="">
        <div><b>${esc(f.name)}</b> <span class="mut">${esc(f.id)}</span><br><input type="file" accept="image/png,image/jpeg,image/webp"></div></div>
      <label class="mut">description (shown in RemoteFM1 when selected)<textarea data-k="what" rows="5">${esc(e.what || "")}</textarea></label>
      ${F.map((k) => `<label class="mut">${L[k] || k} <input data-k="${k}" value="${esc(e[k] || "")}"></label>`).join("")}
      <label class="mut"><input type="checkbox" data-k="beta"${e.beta ? " checked" : ""}> beta</label>
      <div class="bar"><button data-save>Save</button>${testLink(`/rfm1m/open/${f.id}`, "Capture from RemoteFM1")}<span class="mut" data-msg></span></div></div>`;
  }).join("");
  $("#meta-list").querySelectorAll(".card").forEach((c) => {
    const id = c.dataset.id, msg = c.querySelector("[data-msg]");
    c.querySelector("[data-save]").onclick = async () => {
      const body = {};
      c.querySelectorAll("[data-k]").forEach((i) => body[i.dataset.k] = i.type === "checkbox" ? i.checked : i.value);
      try { await api(`/api/meta/${id}`, { method: "PUT", body }); msg.textContent = "saved"; } catch (e) { msg.textContent = e.message; }
    };
    c.querySelector('input[type="file"]').onchange = async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      try { const r = await api(`/api/meta/${id}/image`, { method: "POST", body: f }); c.querySelector("img").src = "/api/meta/" + r.image + "?t=" + Date.now(); msg.textContent = "image saved"; }
      catch (e) { msg.textContent = e.message; }
    };
  });
}

$("#meta-import").onclick = async () => {
  const overwrite = confirm("Fills empty fields and images. Also REPLACE the ones you already set? (Cancel keeps them)");
  const msg = $("#meta-import-msg"); msg.textContent = "importing...";
  try {
    const r = await api("/api/meta-import", { method: "POST", body: { overwrite } });
    msg.textContent = Object.entries(r).map(([id, x]) => `${id}: ${x.filled.length ? "filled " + x.filled.join(",") : "nothing filled"}${x.skipped.length ? "; kept " + x.skipped.join(",") : ""}${x.missing.length ? "; no " + x.missing.join(",") : ""}`).join(" | ");
    loadMeta();
  } catch (e) { msg.textContent = e.message; }
};

// ---------- README ----------
function mdLite(md) {
  return md.split("\n").map((l) => {
    let h = esc(l).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    if (/^#+ /.test(l)) return `<h3>${h.replace(/^#+ /, "")}</h3>`;
    if (/^\|/.test(l)) return /^\| ---/.test(l) ? "" : `<div style="font-size:12px;border-bottom:1px solid var(--line)">${h.split("|").slice(1, -1).join(" │ ")}</div>`;
    return l.trim() ? `<p style="margin:4px 0">${h}</p>` : "";
  }).join("");
}
async function loadReadme() { const r = await api("/api/readme"); $("#rd-text").value = r.md; $("#rd-prev").innerHTML = mdLite(r.md); $("#rd-info").textContent = "loaded"; }
$("#rd-load").onclick = loadReadme;
$("#rd-text").oninput = () => { $("#rd-prev").innerHTML = mdLite($("#rd-text").value); $("#rd-info").textContent = "unsaved"; };
$("#rd-refresh").onclick = async () => {
  $("#rd-info").textContent = "generating…";
  try { const r = await api("/api/readme/refresh", { method: "POST", body: { md: $("#rd-text").value } }); $("#rd-text").value = r.md; $("#rd-prev").innerHTML = mdLite(r.md); $("#rd-info").textContent = "generated (unsaved)"; }
  catch (e) { $("#rd-info").textContent = e.message; }
};
$("#rd-save").onclick = async () => { try { await api("/api/readme", { method: "PUT", body: { md: $("#rd-text").value } }); $("#rd-info").textContent = "saved to RemoteFM1FW/README.md (not committed)"; } catch (e) { $("#rd-info").textContent = e.message; } };

// ---------- publish ----------
let PV = null;
$("#pb-tag").value = new Date().toISOString().slice(0, 10);
$("#pb-stage").onclick = async () => {
  const tag = $("#pb-tag").value.trim();
  $("#pb-out").textContent = "staging…"; $("#pb-confirm").classList.add("hidden");
  try {
    PV = await api("/api/stage", { method: "POST", body: { tag, notes: $("#pb-notes").value, exclude: $("#pb-exclude").value.split(",").map((s) => s.trim()).filter(Boolean) } });
    const total = PV.files.reduce((a, f) => a + f.size, 0);
    $("#pb-prev").innerHTML = `<h2>Preview: ${esc(PV.tag)} on ${esc(PV.repo)} (previous ${esc(PV.previous)}) — ${PV.files.length} files, ${fmtSize(total)}</h2>
      ${PV.problems.length ? `<div class="danger"><b class="bad">Problems (publish is blocked):</b><ul>${PV.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : '<p class="ok">No problems found.</p>'}
      <table><thead><tr><th>File</th><th>Size</th><th>SHA-256</th><th>From</th><th>Licence</th><th>Source</th><th></th></tr></thead><tbody>
      ${PV.files.map((f) => `<tr><td><code>${esc(f.file)}</code>${f.hosted ? ' <span class="pill warn">hosted only</span>' : ""}</td><td>${fmtSize(f.size)}</td><td><code>${esc(f.sha256)}</code></td><td>${esc(f.origin)}</td><td>${esc(f.license)} (${f.licenses} texts)</td><td><code>${esc(f.source_url)}</code></td><td>${f.changed ? '<span class="pill warn">new/changed</span>' : ""} ${testLink(testUrl(`/files/staging/${PV.tag}/${f.file}`, f.id), "Test")}</td></tr>`).join("")}
      </tbody></table><h2>SHA256SUMS</h2><pre>${esc(PV.sums)}</pre><h2>Release notes</h2><pre>${esc(PV.notes)}</pre>
      <p class="mut">README ${PV.readmeChanged ? "will change (staging/" + esc(PV.tag) + "/README.preview.md)" : "unchanged"}. Staged in <code>${esc(PV.dir)}</code>.</p>`;
    $("#pb-out").textContent = "";
    if (!PV.problems.length) { $("#pb-confirm").classList.remove("hidden"); $("#pb-confirm-tag").value = ""; $("#pb-go").disabled = true; }
  } catch (e) { $("#pb-out").textContent = "error: " + e.message; }
};
$("#pb-confirm-tag").oninput = () => { $("#pb-go").disabled = !PV || $("#pb-confirm-tag").value !== PV.tag; };
async function runPublish(dryRun) {
  const tag = $("#pb-tag").value.trim();
  try {
    const j = await api("/api/publish", { method: "POST", body: { tag, dryRun, confirm: dryRun ? undefined : $("#pb-confirm-tag").value } });
    const poll = async () => { const v = await api(`/api/jobs/${j.id}`); $("#pb-out").textContent = `${v.status}\n` + JSON.stringify(v.result || v.error, null, 1); if (v.status === "running") setTimeout(poll, 1000); };
    poll();
  } catch (e) { $("#pb-out").textContent = "error: " + e.message; }
}
$("#pb-dry").onclick = () => runPublish(true);
$("#pb-go").onclick = () => { if (confirm(`Publish ${PV.tag} to ${PV.repo} now? This pushes and creates a public release.`)) runPublish(false); };

loadCatalog(false);
