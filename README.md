# RFM1Manager

A local web app that manages the RemoteFM1 `.rfm1` firmware catalog: what is released on
[Quixotic7/RemoteFM1FW](https://github.com/Quixotic7/RemoteFM1FW), what FM1VST's glue pins, what upstream has
released since, and the builds, metadata, README and releases in between. Plain Node (`node:http`), a vanilla
HTML/JS/CSS page, **no npm dependencies**.

```sh
npm start            # or: node server.js
# -> http://127.0.0.1:4717/   (127.0.0.1 only; no browser is opened, open it yourself)
```

Stop it by its PID (written to `.server-<port>.pid`): `kill $(cat .server-4717.pid)`.

## Setup

Needed on the machine (as on the owner's Mac): Node 20+, `git`, `gh` (logged in), CMake ≥ 3.22, Emscripten
`emcc` 6.0.13 (`/opt/homebrew/bin/emcc` by default), Homebrew `libraqm`, and a Python ≥ 3.12 (`/opt/homebrew/bin/python3.12`).
The first build creates `.venv/` from that Python and installs Pillow + fontTools into it (the generators' needs);
it is passed to CMake as `CR_PYTHON`.

Optional `config.json` (or `RFM1M_CONFIG=/path/config.json`; `RFM1M_PORT` overrides the port) overrides any of:

| key | default |
| --- | --- |
| `host`, `port` | `127.0.0.1`, `4717` |
| `fm1vst` | `../FM1VST` (the main checkout: only read, and `git worktree add` run in it) |
| `baseBranch` | `rfm1-melodee` (the newest catalog branch; the manager branch starts from it) |
| `branch`, `worktree` | `rfm1-manager`, `FM1VST/.claude/worktrees/rfm1-manager` |
| `fwRepo`, `ghRepo` | `../RemoteFM1FW`, `Quixotic7/RemoteFM1FW` |
| `remotefm1` | `../RemoteFM1` (the site's source for Test in RemoteFM1: only `git fetch`ed and `git archive`d) |
| `hubUrl`, `rfm1Feed` | `https://thefirmwarehub.com/catalog.json`, `https://remotefm1.com/catalog.json` (the hub's fallback) |
| `emcc`, `basePython`, `venv`, `jobs` | `/opt/homebrew/bin/emcc`, `/opt/homebrew/bin/python3.12`, `.venv`, `8` |

## Where things live

| Path | What |
| --- | --- |
| `server.js`, `lib/*.js`, `public/` | the server, its modules, the page |
| `cache/` | the latest release's metadata and its assets (`cache/release/<tag>/`), GitHub trees for detection |
| `cache/site-<commit>/web/` | the RemoteFM1 site exported from `origin/main` (`cache/site.json` names the one served) |
| `out/` | `.rfm1` files built OK in the manager worktree: release candidates (they replace the release's file of the same id when staging) |
| `logs/<timestamp>-<label>/` | one bundle per build / add / publish job |
| `staging/<tag>/`, `staging/<tag>.preview.json` | a staged release and its preview |
| `scratch/` | clones for add-firmware, `scratch/trash/` (things moved aside: nothing is ever `rm -rf`'d) |
| `FM1VST/.claude/worktrees/rfm1-manager` | the manager's own FM1VST worktree (branch `rfm1-manager`), created on first build |
| `FM1VST/.claude/worktrees/rfm1-manager-scratch` | add-firmware's scratch worktree (recreated per scaffold; the old one is moved to `scratch/trash/`) |
| `RemoteFM1FW/catalog/` | the catalog metadata (below), `RemoteFM1FW/README.md` |

The app never touches other FM1VST worktrees or the main checkout's branch: it refuses a worktree path that is on
another branch.

## Features

### 1. Catalog
`GET /api/catalog[?upstream=1&force=1]`. Merges the latest RemoteFM1FW release (`gh release view`: the rolling
release `current`, section 7; assets downloaded into `cache/release/<tag>/` and fetched again when their SHA-256 is
not the asset's digest, files the release no longer has moved aside; each manifest read from its `rfm1` custom
section), the README table, and FM1VST's glue
(every `fm1_add_core` / `fm1_add_rfm1` in `core-glue/**.cmake` on the manager branch, else the base branch: family,
glue version, licence, `GATED`, `HOSTED_DESPITE_GATE`, `AUTHORS`, the submodule from `.gitmodules` and its pinned
commit from the tree). "Check upstream" asks GitHub for each repository's latest **stable** release
(`releases`, not draft / prerelease, tag `[name-]vX.Y[.Z]` without rc/beta/alpha/pre/dev/...; falling back to tags with
the same rule) and its commit, and the **firmware hub** (below); it flags **update available** (with its source: "GitHub
release" / "GitHub tag" / "hub release") when one is newer than the glue's version and not the pin.
`GET /api/upstream/<id>` does GitHub for one.

#### Firmware hub (second update source)
Some authors publish only through the FM-1 Firmware Hub (e.g. JIANT: no GitHub releases or tags). `lib/hub.js` reads
the hub's own catalog, `https://thefirmwarehub.com/catalog.json` (the file RemoteFM1's Pages build and `fm1-native.sh`
read; config `hubUrl`), falling back to RemoteFM1's `https://remotefm1.com/catalog.json` (`rfm1Feed`, the same
`firmwares[]` fields) and then to the last cached copy (`cache/hub.json`, 10 minutes). An entry is matched by manifest
id (and repo), else by repository slug when exactly one hub entry has that repo. It is used only when:
- `beta` is false and its version is a plain number once a trailing commit (`-f46764d`) / `+build` and a leading `V`
  are dropped (`V10.9-f46764d` -> `10.9`; the author's numbering kept); anything with rc/beta/alpha/pre/dev/test/... or
  another suffix is ignored;
- its `source` is `https://github.com/<the glue's own repo>/tree/<sha or tag>` (`srcref` when it is a full SHA); a
  branch (`tree/main`) is never used; the ref is resolved to the full commit with the GitHub API (a short SHA must
  prefix it), and the build fetches that commit from `.gitmodules`' URL (so it must exist in the repository);
- **and** either GitHub has no stable release/tag newer than the current version, or the hub's version is newer than
  GitHub's latest stable one (a hub release at GitHub's own commit stays a GitHub release).
The bump then pins that exact commit (the manifest's `source_url` is `<repo>@<full sha>`), the header comment's
"`<ver> (<sha7>, https://github.com/<repo>`" is rewritten, and the commit message, the job log and
`SUMMARY-FOR-LLM.md` name the source: `jiant: 0.9.9 -> 10.9 (juanjiant-bit/JIANT f46764d, firmware hub non-beta release)`.

### 2. Update + build
`POST /api/build {id, update}` (one firmware) or `POST /api/build-all {update, ids?}` (with `update`: those with an
update). One build at a time. Steps, all logged: create the worktree if needed; the venv (plus the glue's
`PYTHON_NEEDS` modules, e.g. numpy); the firmware's submodule at HEAD's pin, cloned from `.gitmodules`' URL (FM1VST's
shared `.git/config` points submodule URLs at another worktree's copy, which lacks newer commits and tags), the commit
fetched from that URL (`--tags`, the tag, then the SHA; `--unshallow` when shallow), else from any other worktree's
module copy (read only); with `update` and a newer stable release the old pin is never needed: fetch the tag's commit,
check it out (`-f`), and change every unambiguous spelling of the old version in `core_<id>.cmake/.c/_desc.c`
(`VERSION x`, `set(_x_ver x)`, `"vx"` / `"x"`, `NAME_VERSION=x`, `--release x`, the header's "Name x (https://github.com/<repo>,
tag vx = sha" comment, fm1-base `FM-1_<prefix>MMmmpp` and Felucca-style `FELUCCA_ID "FM-1_<d>XY"` identities); the old
version is the glue's `VERSION`, else its `VERSION_FILE` at the old pin, else the header comment. What still names the
old version, or an identity that may encode it, is listed as **manual steps** in the bundle and the commit. The other
cores the `FM1_ONLY_CORES` selector configures (`choralroot` is also a glue folder) get their submodules too. Configure `-DFM1_RFM1=ON -DFM1_RFM1_ONLY=ON -DFM1_ONLY_CORES=<glue> -DFM1_EMCC=… -DCR_PYTHON=.venv/bin/python`
(`FM1_PUBLIC_BUILD=ON`, or `OFF` for a `HOSTED_DESPITE_GATE` core); build `rfm1_<id>` + `rfm1_run`; verify:
`tools/rfm1_check.py` passes; the manifest has its required fields, authors, **licence texts** (`rfm1.license.<n>`
sections) and **`source_url` at the exact pinned commit**; `rfm1_run` (with the glue's `RUN_ARGS`) boots it, the
chord's RMS is > 0 and the LCD was written (the WAV is kept in the bundle). A gated core without
`HOSTED_DESPITE_GATE` is refused. With an update, only when every check passed is the pin bump **committed in the manager
worktree** (never pushed), then the file is rebuilt so its `built_by` names that commit and checked again; a failed
update restores the glue files and the submodule (nested checkouts the new release added are moved to `scratch/trash/`)
to HEAD's pin, so the tree stays clean. A good file is copied to `out/`.

A glue that reads its version from a file (`VERSION_FILE`) gets only the pin moved. Upstream releases that change the
firmware's build (new sources, generators) fail in the build step with the error in the bundle.

### 3. Log bundles
Each job's folder in `logs/`: `build.log` (everything), `commands.txt` (every command line, with its directory),
`env.txt`, `versions.txt` (emcc, cmake, python, node, git, the FM1VST commit + status), `error-excerpt.txt` (the first
git `fatal:` / CMake Error / compiler `error:` / linker / make "No rule" / Python traceback line, from the command that
printed it, and 25 lines after; the manager's own `ERROR:` line only when nothing else matched), `result.json`, `job.json`, the WAV, and
**`SUMMARY-FOR-LLM.md`**: what was built from what (repo + commit, upstream tag), the steps, the excerpt, the glue
file paths and the commands to reproduce: paste it as is. The "Builds & logs" tab lists jobs (live) and bundles; each
file opens there with a Copy button. API: `GET /api/jobs`, `/api/jobs/<n>?since=<line>`, `/api/logs`,
`/api/logs/<bundle>/<file>`.

### 4. Add firmware
`POST /api/add {url, mode: "detect"|"scaffold", id?, target: "scratch"|"manager", template?, hostedDespiteGate?}`;
`GET /api/existing?url=` (local: is the repository already a core?).
Detection (`GET /api/detect?url=` too): the repository's metadata (fork parent, licence, owner), its latest stable
release, its file tree at that tag; compared with every existing core's tree at its pin (Jaccard similarity of the
path shapes, three levels, file names reduced to extensions), plus markers per family (fm1-base: `app/fm1.toml`, a
`base/` fm1-base submodule; Felucca: `platforms/`, `felucca*`; SLOOP; Dinghy/zvenson: `dinghy`, `*vave*`,
`smk37-port.yaml`; plat: `firmware/src/app`, `host/*_host.c`; ChoralRoot, Melodee, Speak37), in paths, README and
`.gitmodules`, and the fork parent. The family with the best score and its most similar core win. Within the family,
a firmware on a base (`base/`, `felucca-base/`, `firmware/bsp`: a submodule's commit date, or a vendored base's pin
date) takes the core whose base is of the closest date as its template, a day added per extra glue unit
(`<t>_*.c`) the template would bring: FRASIL (fm1-base of 2026-10-30, `plat_fm1.c` needing `chip/ota.c`) gets
Mutable Dreams', not AMB's. A fork's "latest stable release" that is its parent's own tag at the parent's commit
(HYP-1's v1.1 is AMB-1's) is flagged as **not its own** and is refused in the manager worktree. It also clones the
repo (shallow, at the tag) into `scratch/clones/` for its LICENSE.

**Already a core.** When the URL's repository is already a core in FM1VST (the same `.gitmodules` URL), Add never
scaffolds a copy: the page says "already a core in FM1VST: enable as .rfm1 + update" (or "already an .rfm1: update +
build") and the button becomes **Enable as .rfm1 + update**. In the manager worktree it adds
`fm1_add_rfm1(<id> AUTHORS "<the glue's CREDITS 'X by <author>', else the owner's GitHub name>" LICENSE_FILES ...)`
(the root LICENSE, LICENSING.md / NOTICE, every `LICENSES/*` file and the licence files elsewhere in the tree, e.g. a
font's OFL in `assets/fonts/`, each named by its text: `"OFL-1.1 (the Terminus font in {name})=..."`), `MEMORY_MIB`
only when the linker says the 8 MiB default is too small (16 or 32, built again), and, for a GATED core, only with
the request's `hostedDespiteGate` reason (the owner's call; the page asks for it) as `HOSTED_DESPITE_GATE`. Then the
update + build + verify of section 2 (GitHub's latest stable release, else the hub's non-beta one): the glue edit and
the pin bump are **one commit, made only when every check passed**; otherwise the glue files are put back as they
were before the job (uncommitted hand edits kept) and the submodule to HEAD's pin. A glue that needs a hand port to
the new release: port it in the worktree (uncommitted), then Add again.

**Scaffold** (a new core): in the scratch worktree (default; recreated each time) or the manager worktree: `git
submodule add` at `cores/<repo>`, checkout the stable tag, copy the closest core's glue files (`core_<t>.cmake/.c/_desc.c`
and its `<t>_*.c`) renamed. The rename touches only what the glue owns: the submodule path's prefix (the firmware's
own files after it stay), the repository slug, the copied files' names, the glue's identifiers (`fm1core_<t>*`,
`FM1CORE_<T>_*`, `core_<t>*`, `rfm1_<t>`, `gen_<t>`), `FM1CORE_ID="<t>"`-like strings, and in the .cmake the id as a
call's first argument, `<t>_core/_obj/_hostsim` targets and `_<t>_*` variables; never an `#include "grimm.c"` of the
firmware, its macros (`GRIMM_WEB`) or the template's other glue (`grimm_hook/`). Golden checks are dropped; `VERSION`
and `LICENSE` set; `GEN` becomes what the new firmware's own generate step writes (it is run once, as FM1Cores.cmake
runs it, and `build/gen` listed; the template's list only when it fails); `fm1_add_rfm1(<id> AUTHORS .. LICENSE_FILES
..)` from the new tree (as above). Then a check that every `#include "..."` / `"x.c"` define of the new units and
every SOURCE / UNIT / DESC / EXTRA_SOURCES / INCLUDES / CREDITS_FILES path (set() variables expanded) and every
source file named in a set() list resolves (the glue, `core-glue/common`, `core-api`, the INCLUDES, the submodule's
tree): what does not is listed in the summary. In the scratch worktree the scaffold is committed there before the
build; in the **manager worktree it is committed only when every check passed**, else taken out again (the glue
copied to the bundle's `glue-scaffold/`, the files and the submodule's checkout moved to `scratch/trash/`,
`.gitmodules` back to HEAD's): the tree stays clean. The same bundle gets an add-firmware `SUMMARY-FOR-LLM.md`
(detection, scores, base generation, GEN, similar cores, scaffold, unresolved references, first error). Scratch builds
never go to `out/`. A template whose glue is a folder-wide `core.cmake` (Melodee) is refused (scaffold by hand).

### 5. Catalog metadata
`GET /api/meta`, `PUT /api/meta/<id> {description, what, tag, category, author, site, beta}`,
`POST /api/meta/<id>/image` (raw PNG/JPEG/WebP body, ≤ 1 MiB), `GET /api/meta/images/<id>.<ext>`. Stored in the
RemoteFM1FW checkout (not committed by the editor; a publish commits `catalog/`):

```json
{
  "schema": 1,
  "about": "free text",
  "firmwares": {
    "<manifest id>": {
      "description": "card / detail text",
      "image": "images/<id>.png",
      "author": "short name", "category": "Synth", "tag": "subtitle",
      "what": "one-sentence summary", "site": "https://…", "beta": false
    }
  }
}
```

All fields are optional. Identity, version, licence, authors and source are never duplicated here: they are the
file's manifest. `author/category/tag/what/site/beta` are exactly the fields of RemoteFM1's
`web/site/data/fw-catalog.json` (the `fw-catalog` branch's `build_catalog.mjs --fw-catalog`), so the site can read
this file instead, and the iOS app can fetch `catalog/catalog.json` + images from the release's tag on
`raw.githubusercontent.com`. The schema is also written to `RemoteFM1FW/catalog/SCHEMA.md`.

### 6. README editor
`GET/PUT /api/readme`, `POST /api/readme/refresh {md}` (returns, does not save). The refresh regenerates, between
markers, the firmware table (file, name + version, authors, licence, `[owner/repo](…/tree/<commit>)` from each
manifest's `source_url`; a hand-written licence note or name suffix that starts the same way is kept, † for hosted-only
files) and **build provenance**: the files grouped by the FM1VST commit in their `built_by`, linked, with the branch
whose tip it is. Everything outside the markers is the owner's text. The table is built from the files that would be
released (the release's, replaced by `out/`).

### 7. Publish
RemoteFM1FW has two kinds of release (owner, 2026-11-06), so a publish no longer uploads every file again:
- **`current`**, the rolling release: always **Latest**, it holds the full set, every current `.rfm1` + `SHA256SUMS`
  (all files). What the iOS / Android apps (`releases/latest`) and the site (`fetch_fw_catalog.mjs`) read. A publish
  updates it in place; its title names the last dated release, its notes are that release's plus a line saying
  `current` always holds the full set. The tag itself stays at the commit of the switch-over.
- **a dated release per publish** (the tag you give, e.g. `2026-11-06f`), never Latest (`--latest=false`): only the
  files that publish added or updated, a `SHA256SUMS` of just those, and the release notes. The history: the apps'
  "older versions" page reads every release, and a version is in the dated release where it first came out.

`POST /api/stage {tag, notes?, exclude?}` copies every file to release into `staging/<tag>/` and writes
`SHA256SUMS` (the full set), `dated/SHA256SUMS` (the files new or changed against the latest release's `SHA256SUMS`,
by name + SHA-256), `RELEASE-NOTES.md` (generated if empty: added / updated / removed against the latest release),
`CURRENT-NOTES.md` (the same + the `current` line) and `README.preview.md`, and returns the preview (files, sizes,
SHA-256, origin, licence, source, what changed, `dated`, `removed`, problems). The tag `current` is refused.
It **refuses**: anything that is not `<id>-<version>.rfm1` (raw `.syx` / preset sources and every other file type, in
`out/` or staging); a name not matching its manifest; a manifest without licence texts, authors or `source_url` at a
commit; a GATED core without `HOSTED_DESPITE_GATE`; a built file whose FM1VST glue commit is not on FM1VST's remote
(its `glue_url` must be public, GPL); a tag that already exists.
`POST /api/publish {tag, dryRun: true}` (the default) re-checks the staged files against the preview's hashes, reads
`current` as it is now (its assets with their digests, its `SHA256SUMS`; read only) and returns the exact plan without
running it. A real publish needs `dryRun: false` **and** `confirm` equal to the tag (the UI shows the confirm box only
for a preview without problems, enables the button only when the typed text equals the tag, then asks once more), no
problems, RemoteFM1FW on `main`, and `current` as the stage saw it (or already at the staged set: a re-run after a
failure). It then runs, in this order:
1. copy README, `git add README.md catalog docs`, commit, push (big `http.postBuffer`);
2. `gh release upload current <new and changed .rfm1> --clobber`;
3. `gh release upload current SHA256SUMS --clobber` (the full set);
4. `gh release delete-asset current <file> --yes` for every asset not in the set (renamed versions, removed firmwares);
5. check: every asset of `current` against `SHA256SUMS` (the same `.rfm1` names, each SHA-256 digest equal; an asset
   without a digest is downloaded and hashed): the site rejects the whole release on any mismatch;
6. `gh release create <tag> --latest=false --notes-file RELEASE-NOTES.md <dated files> dated/SHA256SUMS` (no files
   when nothing was added or updated; skipped when the tag exists from an earlier try of this publish);
7. `gh release edit current --title <tag> --notes-file CURRENT-NOTES.md --latest`;
8. check: the Latest release is `current`.

Readers see a partial state only between steps 2 and 4 (a new file not yet in `SHA256SUMS`, then a stale file not in
it any more): seconds. Each step is safe to run again: a failed publish is run again as it is.

**The switch-over** (once, before the first publish of this kind; a publish refuses until `current` exists):
`POST /api/release/init-current {from: "<newest dated tag>", dryRun: true}` (the default: reads and lists), then with
`dryRun: false, confirm: "current"`; or `node tools/init-current.mjs --from <tag> [--confirm current]`. It downloads
`from`'s assets into `cache/release/<from>/`, checks every `.rfm1` against its `SHA256SUMS` (anything else refused),
runs `gh release create current --title <from> --target main --latest <every .rfm1> SHA256SUMS` (gh makes it a draft,
uploads, then publishes) and checks it as in steps 5 and 8. Run again it does nothing when `current` already holds
that set and is Latest, finishes a `current` a failed run left (titled `from`, or a draft), and refuses a `current`
that holds another set.

### 8. Test in RemoteFM1 + thumbnail capture
The manager serves its own copy of the RemoteFM1 site (remotefm1.com can't load files from localhost): `origin/main`
of the RemoteFM1 repo (`git fetch origin main`, then `git archive` of `web/site`, `web/engines`, `web/remote` into
`cache/site-<commit>/`; the repo, its working tree and worktrees are never touched). It is served at `/rfm1/` in the
site's dev layout (the page at `/rfm1/site/`, its committed `catalog.json`'s `../engines/…` beside it; no build step,
no COOP/COEP needed: the `.rfm1` engine uses no SharedArrayBuffer). **Refresh site** (Catalog tab, `POST
/api/site/refresh`) re-exports when `origin/main` moved; `GET /api/site` says which commit is served. The first test
exports it if nothing is.

The served `index.html` loads `public/rfm1m/loader.js` in place of `js/main.js` (a rewrite of the response; nothing on
disk is edited): with `?rfm1=<file>&rfm1id=<id>` it fetches the file, checks it with the site's own
`engines/rfm1/engine.js` `inspect()`, adds it to the site's library (`js/library.js`, IndexedDB: "Your firmware"),
makes it the last-opened firmware (the site's prefs) and then starts the site, which opens it. The manager's earlier
file of the same id is removed from that library. Files: `/files/out/<file>`, `/files/release/<tag>/<file>`,
`/files/staging/<tag>/<file>`. Links (new tab): **Test in RemoteFM1** on each Catalog row (`/rfm1m/open/<id>`: the
newest built file in `out/`, else the latest release's), on a finished build's job / bundle view (its `out/` file), and
**Test** per staged file in the publish preview.

The loader also adds a floating **Capture thumbnail** box: it grabs the live 240×240 LCD frame (the site's
`FM1Site.screen()`, RGB565, exactly the LCD like the iOS app's thumbnails), shows it, and **Use as thumbnail** POSTs
the PNG to `/api/meta/<id>/image` (the running firmware's manifest id), asking first when the id already has an image.
Each Metadata card has **Capture from RemoteFM1** (the same page for that id).

## Owner rules the app enforces

- Upstream **stable releases only** (rc/beta/alpha/pre/dev tags, GitHub prereleases and hub entries marked `beta` are
  never offered or pinned); the firmware hub only as described under "Firmware hub".
- `HOSTED_DESPITE_GATE` cores (SLOOP, Clipper, KARMA, X0X) are built with `FM1_PUBLIC_BUILD=OFF`, as their glue says,
  shown "hosted only", and stay † in the README; gated cores without it are refused.
- No raw `.syx` / preset sources in a release (compiled presets inside the wasm are fine).
- Every manifest: licence texts and `source_url` at the exact commit (build check and stage check).
- Headless: the server binds 127.0.0.1 and never opens a window or browser.
- Nothing is deleted: superseded trees go to `scratch/trash/` with `mv`.

## Limits

- One FM1VST worktree, so one build at a time (`409` otherwise).
- The pin bump edits the version where it is unambiguous; anything else (comments describing the old release, derived
  identities, new sources or generators of a new upstream release) needs a hand edit: the bundle's "Manual steps" and
  "What to look at" say where.
- Scaffolds are a starting point: unit and descriptor files copied from another core usually need work (the entry
  points, the firmware's host macros, what its sources take from the hardware layer); the summary's unresolved
  references are the first places to look.

- Test in RemoteFM1: sound starts with a click on the page (Play); there is no LCD frame to capture before it runs.
  The site's hosted managers (`build/managers/index.json`, 404) and the native / emulated engines' wasm (`web/build`)
  are not in the export: the Editor button shows links only, and catalog firmwares other than `.rfm1` files may not run.

## Start from Finder

Double-click `Start RFM1Manager.command` to start the server (if it is not running) and open the site in your browser. `Stop RFM1Manager.command` stops it. The server log is `logs/server.log`.
