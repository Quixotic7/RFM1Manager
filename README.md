# RFM1Manager

A local web app that manages the RemoteFM1 `.rfm1` firmware catalog: what is released on
[Quixotic7/RemoteFM1FW](https://github.com/Quixotic7/RemoteFM1FW), what FM1VST's glue pins, what upstream has
released since, and the builds, metadata, README and releases in between. Plain Node (`node:http`), a vanilla
HTML/JS/CSS page, **no npm dependencies**.

```sh
npm start            # or: node server.js
# -> http://127.0.0.1:4717/   (127.0.0.1 only; no browser is opened, open it yourself)
```

Stop it by its PID (written to `.server.pid`): `kill $(cat .server.pid)`.

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
| `emcc`, `basePython`, `venv`, `jobs` | `/opt/homebrew/bin/emcc`, `/opt/homebrew/bin/python3.12`, `.venv`, `8` |

## Where things live

| Path | What |
| --- | --- |
| `server.js`, `lib/*.js`, `public/` | the server, its modules, the page |
| `cache/` | the latest release's metadata and its assets (`cache/release/<tag>/`), GitHub trees for detection |
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
`GET /api/catalog[?upstream=1&force=1]`. Merges the latest RemoteFM1FW release (`gh release view`; assets downloaded
once into `cache/` and each manifest read from its `rfm1` custom section), the README table, and FM1VST's glue
(every `fm1_add_core` / `fm1_add_rfm1` in `core-glue/**.cmake` on the manager branch, else the base branch: family,
glue version, licence, `GATED`, `HOSTED_DESPITE_GATE`, `AUTHORS`, the submodule from `.gitmodules` and its pinned
commit from the tree). "Check upstream" asks GitHub for each repository's latest **stable** release
(`releases`, not draft / prerelease, tag `[name-]vX.Y[.Z]` without rc/beta/alpha/pre/dev/...; falling back to tags with
the same rule) and its commit, and flags **update available** when it is newer than the glue's version and not the pin.
`GET /api/upstream/<id>` does one.

### 2. Update + build
`POST /api/build {id, update}` (one firmware) or `POST /api/build-all {update, ids?}` (with `update`: those with an
update). One build at a time. Steps, all logged: create the worktree if needed; the venv; `git submodule update --init
[--recursive]` of the firmware's submodule; with `update` and a newer stable release: fetch, check out the tag's commit,
change the glue's `VERSION x` (and its "tag vX" comment), **commit the pin bump in the manager worktree only** (never
pushed); configure `-DFM1_RFM1=ON -DFM1_RFM1_ONLY=ON -DFM1_ONLY_CORES=<glue> -DFM1_EMCC=… -DCR_PYTHON=.venv/bin/python`
(`FM1_PUBLIC_BUILD=ON`, or `OFF` for a `HOSTED_DESPITE_GATE` core); build `rfm1_<id>` + `rfm1_run`; verify:
`tools/rfm1_check.py` passes; the manifest has its required fields, authors, **licence texts** (`rfm1.license.<n>`
sections) and **`source_url` at the exact pinned commit**; `rfm1_run` (with the glue's `RUN_ARGS`) boots it, the
chord's RMS is > 0 and the LCD was written (the WAV is kept in the bundle). A gated core without
`HOSTED_DESPITE_GATE` is refused. A good file is copied to `out/`.

A glue that reads its version from a file (`VERSION_FILE`) gets only the pin moved. Upstream releases that change the
firmware's build (new sources, generators) fail in the build step with the error in the bundle.

### 3. Log bundles
Each job's folder in `logs/`: `build.log` (everything), `commands.txt` (every command line, with its directory),
`env.txt`, `versions.txt` (emcc, cmake, python, node, git, the FM1VST commit + status), `error-excerpt.txt` (the first
compiler / linker / CMake / Python error with 10 lines before and 25 after), `result.json`, `job.json`, the WAV, and
**`SUMMARY-FOR-LLM.md`**: what was built from what (repo + commit, upstream tag), the steps, the excerpt, the glue
file paths and the commands to reproduce: paste it as is. The "Builds & logs" tab lists jobs (live) and bundles; each
file opens there with a Copy button. API: `GET /api/jobs`, `/api/jobs/<n>?since=<line>`, `/api/logs`,
`/api/logs/<bundle>/<file>`.

### 4. Add firmware
`POST /api/add {url, mode: "detect"|"scaffold", id?, target: "scratch"|"manager", template?}`.
Detection (`GET /api/detect?url=` too): the repository's metadata (fork parent, licence, owner), its latest stable
release, its file tree at that tag; compared with every existing core's tree at its pin (Jaccard similarity of the
path shapes, three levels, file names reduced to extensions), plus markers per family (fm1-base: `app/fm1.toml`, a
`base/` fm1-base submodule; Felucca: `platforms/`, `felucca*`; SLOOP; Dinghy/zvenson: `dinghy`, `*vave*`,
`smk37-port.yaml`; plat: `firmware/src/app`, `host/*_host.c`; ChoralRoot, Melodee, Speak37), in paths, README and
`.gitmodules`, and the fork parent. The family with the best score and its most similar core win. It also clones the
repo (shallow, at the tag) into `scratch/clones/` for its LICENSE.
Scaffold: in the scratch worktree (default; recreated each time) or the manager worktree: `git submodule add` at
`cores/<repo>`, checkout the stable tag, copy the closest core's glue files (`core_<t>.cmake/.c/_desc.c` and its
`<t>_*.c`) renamed, with the template's id / submodule path / repo slug swapped, golden checks dropped, `VERSION`,
`LICENSE` and `fm1_add_rfm1(<id> AUTHORS "<owner's name>")` set; commit it there; then the build + verify above, in
the same bundle, with an add-firmware `SUMMARY-FOR-LLM.md` (detection, scores, similar cores, scaffold, first error).
Scratch builds never go to `out/`. A template whose glue is a folder-wide `core.cmake` (Melodee) is refused (scaffold
by hand).

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
`POST /api/stage {tag, notes?, exclude?}` copies every file to release into `staging/<tag>/` and writes
`SHA256SUMS`, `RELEASE-NOTES.md` (generated if empty: added / updated / removed against the latest release) and
`README.preview.md`, and returns the preview (files, sizes, SHA-256, origin, licence, source, what changed, problems).
It **refuses**: anything that is not `<id>-<version>.rfm1` (raw `.syx` / preset sources and every other file type, in
`out/` or staging); a name not matching its manifest; a manifest without licence texts, authors or `source_url` at a
commit; a GATED core without `HOSTED_DESPITE_GATE`; a built file whose FM1VST glue commit is not on FM1VST's remote
(its `glue_url` must be public, GPL); a tag that already exists.
`POST /api/publish {tag, dryRun: true}` (the default) re-checks the staged files against the preview's hashes and
returns the exact plan (copy README, `git add README.md catalog`, commit, push, `gh release create … --notes-file …`)
without running it. A real publish needs `dryRun: false` **and** `confirm` equal to the tag (the UI shows the confirm
box only for a preview without problems, enables the button only when the typed text equals the tag, then asks once
more), no problems, RemoteFM1FW on `main`; it then commits README + catalog, pushes (big `http.postBuffer`), and runs
`gh release create`.

## Owner rules the app enforces

- Upstream **stable releases only** (rc/beta/alpha/pre/dev tags and GitHub prereleases are never offered or pinned).
- `HOSTED_DESPITE_GATE` cores (SLOOP, Clipper, KARMA, X0X) are built with `FM1_PUBLIC_BUILD=OFF`, as their glue says,
  shown "hosted only", and stay † in the README; gated cores without it are refused.
- No raw `.syx` / preset sources in a release (compiled presets inside the wasm are fine).
- Every manifest: licence texts and `source_url` at the exact commit (build check and stage check).
- Headless: the server binds 127.0.0.1 and never opens a window or browser.
- Nothing is deleted: superseded trees go to `scratch/trash/` with `mv`.

## Limits

- One FM1VST worktree, so one build at a time (`409` otherwise).
- The pin bump edits a literal `VERSION`; glue that encodes the version elsewhere (or needs new sources for a new
  upstream release) needs a hand edit: the bundle says where.
- Scaffolds are a starting point: unit and descriptor files copied from another core usually need work.
