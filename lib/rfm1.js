// SPDX-License-Identifier: GPL-3.0-only
// Read an .rfm1 (a Wasm module) without running it: its custom sections (rfm1 manifest, rfm1.credits,
// rfm1.license.<n>), docs/RFM1-FORMAT.md section 1 and 4.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

function leb(buf, pos) {
  let r = 0, shift = 0, b;
  do { b = buf[pos++]; r |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  return [r >>> 0, pos];
}

export function readRfm1(pathOrBuf) {
  const buf = Buffer.isBuffer(pathOrBuf) ? pathOrBuf : readFileSync(pathOrBuf);
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x0061736d) throw new Error("not a WebAssembly module");
  let pos = 8;
  const custom = {};
  while (pos < buf.length) {
    const id = buf[pos++];
    let size; [size, pos] = leb(buf, pos);
    const end = pos + size;
    if (id === 0) {
      let n; let p2; [n, p2] = leb(buf, pos);
      const name = buf.slice(p2, p2 + n).toString("utf8");
      custom[name] = buf.slice(p2 + n, end).toString("utf8");
    }
    pos = end;
  }
  if (!custom.rfm1) throw new Error("no rfm1 manifest section");
  const manifest = JSON.parse(custom.rfm1);
  const licenses = Object.keys(custom).filter((k) => k.startsWith("rfm1.license.")).sort()
    .map((k) => ({ section: k, name: custom[k].split("\n")[0], bytes: custom[k].length }));
  return {
    manifest, licenses, credits: custom["rfm1.credits"] || "",
    sha256: createHash("sha256").update(buf).digest("hex"), size: buf.length,
  };
}

// owner rule: every manifest carries licence texts and source_url at the exact commit
export function manifestProblems(info, expectCommit) {
  const m = info.manifest, p = [];
  for (const k of ["rfm1", "abi", "id", "name", "version", "license", "source_url"]) if (m[k] === undefined || m[k] === "") p.push(`manifest: ${k} missing`);
  if (!Array.isArray(m.authors) || !m.authors.length) p.push("manifest: authors empty");
  const c = /@([0-9a-f]{7,40})$/.exec(m.source_url || "");
  if (!c) p.push(`manifest: source_url not at a commit (${m.source_url})`);
  else if (expectCommit && !expectCommit.startsWith(c[1]) && !c[1].startsWith(expectCommit.slice(0, c[1].length))) p.push(`manifest: source_url commit ${c[1]} != pinned ${expectCommit}`);
  if (!info.licenses.length) p.push("no rfm1.license.<n> sections (licence texts)");
  return p;
}
