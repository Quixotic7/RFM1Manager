// SPDX-License-Identifier: GPL-3.0-only
// The add-firmware scaffold's fm1-base pass and gate strip: node --test tests/addfw-scaffold.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { fm1baseFromToml, readFm1Toml, stripGated } from "../lib/addfw.js";

const glue = `set(_sy1 \${CMAKE_SOURCE_DIR}/cores/fm1-sy1)
set(_sy1_ver 2.1)
set(_sy1_app_ver 2.1.0)
set(_sy1_id FM-1_710020100)
set(_sy1_o2 third_party/a.cc
    dsp/dreams.cpp)
fm1_add_core(sy1 \${CMAKE_CURRENT_LIST_DIR} SOURCE \${_sy1} UNIT core_sy1.c DESC core_sy1_desc.c
             EXTRA_SOURCES \${_sy1_o2_rel}
             FAMILY fm1base LICENSE MIT
             GATED "the template's own material"
             CREDITS "Mutable Dreams by someone."
             VERSION \${_sy1_ver}
             INCLUDES \${_sy1}/app \${_sy1}/app/dsp \${_sy1}/app/compat \${_sy1}/base/include)
`;
const tpl = readFm1Toml(`o2 = ["third_party/a.cc", "dsp/dreams.cpp"]\ninclude = ["dsp", "compat"]\n`);
const neu = readFm1Toml(`name = "SY1"\nid_prefix = "FM-1_51"\ninclude = ["dsp"]\no2 = ["dsp/s1_synth.c", "dsp/s1_fx.c"]   # the engine\nauthor = "fenderberg"\ncredits = "Built on fm1-base."\n`);

test("an fm1-base scaffold takes the new fm1.toml's units, includes, version, identity and credits", () => {
  const { text, notes } = fm1baseFromToml(glue, { tpl, neu, ver: "0.4.0" });
  assert.match(text, /set\(_sy1_o2 dsp\/s1_synth\.c dsp\/s1_fx\.c\)/);
  assert.match(text, /INCLUDES \$\{_sy1\}\/app \$\{_sy1\}\/app\/dsp \$\{_sy1\}\/base\/include\)/);
  assert.match(text, /set\(_sy1_ver 0\.4\.0\)/);
  assert.match(text, /set\(_sy1_id FM-1_51000400\)/);
  assert.match(text, /CREDITS "SY1 by fenderberg\. Built on fm1-base\."/);
  assert.ok(notes.some((n) => n.startsWith("units:")));
});

test("a template's GATED is not copied", () => {
  const g = stripGated(glue);
  assert.equal(g.reason, "the template's own material");
  assert.doesNotMatch(g.text, /GATED/);
  assert.match(g.text, /LICENSE MIT\n\s+CREDITS/);
});

import { pruneCreditsFiles } from "../lib/addfw.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("the template's CREDITS_FILES the new firmware lacks are left out", () => {
  const sub = mkdtempSync(join(tmpdir(), "cf-"));
  mkdirSync(join(sub, "LICENSES"));
  writeFileSync(join(sub, "LICENSES/MIT-Own.txt"), "x");
  const t = `fm1_add_core(x SOURCE \${_x}\n             CREDITS_FILES LICENSES/MIT-Rings.txt LICENSES/MIT-Own.txt\n             GEN a.h)`;
  const r = pruneCreditsFiles(t, sub);
  assert.deepEqual(r.dropped, ["LICENSES/MIT-Rings.txt"]);
  assert.match(r.text, /CREDITS_FILES LICENSES\/MIT-Own\.txt\n\s+GEN a\.h/);
  const none = pruneCreditsFiles(t.replace("LICENSES/MIT-Own.txt", "LICENSES/OFL.txt"), sub);
  assert.doesNotMatch(none.text, /CREDITS_FILES/);
  assert.match(none.text, /SOURCE \$\{_x\}\n\s+GEN a\.h/);
});
