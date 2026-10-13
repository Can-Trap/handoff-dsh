# RUNBOOK

Numbered steps, no judgement calls. `SKILL.md` is the map; this is the road.
Substitute `<...>` and run each line exactly. Stop the moment a phase prints `BLOCKED`.

`$PLUGIN` = this plugin's directory. `$OUT` = where the bundle should be written
(default: the current directory).

---

## Step 1 — collect the four facts

You need these before touching a script. Get them from Open Design, not from memory.

| Fact | Where it comes from | Flag |
|---|---|---|
| project display name | `get_project` / `list_projects` | `--project-name` |
| project cwd on disk | `get_project` -> `resolvedDir`, or `od project info <id> --json` | `--project-dir` |
| active file | `get_active_context()` -> the active file, if any | `--entry` |
| feature scope | ask the user; only needed when `depth` includes `spec` | `--feature` |

If `get_active_context()` reports nothing active, **omit `--entry`**. Do not guess a file.

---

## Step 2 — phase 00, detect

```
node $PLUGIN/scripts/hdd-detect.js \
  --project-name "<NAME>" \
  --project-dir "<DIR>" \
  [--entry "<FILE>"] \
  [--depth bundle|spec|both] [--feature "<SCOPE>"] [--transport zip|mcp|both] \
  [--include-chats true --chats-dir "<DIR>"] [--root-pointers false] [--verification true] \
  [--out "$OUT"]
```

Read the gate block. Then:

| Line | Meaning | Do |
|---|---|---|
| `entry mode ... form1` | an entry file was found | nothing |
| `entry mode ... form2` | none — the README will say "find the primary design file" | nothing; this is valid |
| `design system ... none` | project has no bound DS | nothing; skip every DS gate below |
| `... (collapsed, N components, M alias)` | published-library DS | nothing |
| `... (expanded, ...)` | project-local DS | nothing |
| `WARN declared fonts have binaries` | the DS names fonts but ships no `.woff2` | note it for the final report |
| `FAIL a feature scope is set` | `depth` includes `spec` but no `--feature` | ask the user for the scope, re-run 00 |
| `FAIL transcript directory` | `--include-chats true` without a usable `--chats-dir` | export the transcript and pass the directory, or drop the flag |
| `FAIL` anything | **stop** | fix the input and re-run |

---

## Step 3 — phase 02, spec  *(skip when depth=bundle)*

**This runs before the bundle, not after it.** Phase 02 writes into the *source project*; phase 01
takes one verbatim snapshot of that project and nothing refreshes it afterwards. Bundle first and
the spec never reaches the archive — silently, with every gate still green. Phase 01 refuses at
`depth=both` until this step is finished, so the order is enforced, not merely advised.

```
node $PLUGIN/scripts/hdd-spec.js --feature "<SCOPE>" [--files "a.html,b.html"] [--out "$OUT"]
```

Then **author the document**. Open `<project-dir>/design_handoff_<slug>/README.md` and replace
every `TODO`. Read `references/spec-sections.md` first. Rules that fail review if broken:

1. Read the actual prototype files before writing a single measurement. Never estimate.
2. Every hex, px, weight, duration and easing must come from a file you opened this run.
3. Fill the route-map table if the script pre-filled one — that mapping is the deliverable.
4. Quote copy strings exactly, in quotes.
5. Specify algorithms, not adjectives.
6. Do not delete a pre-filled token table, asset list or file tree; extend them.

Confirm it before moving on — phase 01 will refuse a skeleton:

```
node $PLUGIN/scripts/hdd-validate.js --spec [--out "$OUT"]      # --spec alone uses --feature
```

---

## Step 4 — phase 01, bundle  *(skip when depth=spec)*

```
node $PLUGIN/scripts/hdd-bundle.js [--out "$OUT"] [--force]
```

`--force` is required to rebuild over an existing `<slug>/`.

All gates must read `PASS`. In particular:

- `project mirrored verbatim — N/N files` — the two numbers must match.
- `design-system alias present` — appears only when aliases exist; if it fails, the prototypes
  will render unstyled. Do not proceed.
- `adherence config present — generated (N rules, M components)` or `— mirrored`.
  `mirrored` means the source already had one and it was copied byte-for-byte. Both are correct.
- `authored spec nested in the mirror` — appears at `depth=both` with a feature set. If this is
  missing you built out of order; finish step 3 and re-run with `--force`.
- `conversation transcript included` — appears when `includeChats=true`.

---

## Step 5 — phase 03, validate

```
node $PLUGIN/scripts/hdd-validate.js [--out "$OUT"] [--strict]
```

- `FAIL` -> fix and re-run. Never continue.
- `WARN offline-complete` -> the source references remote resources. Keep it, report it.
  Only re-run with `--strict` if the user explicitly needs an offline bundle.
- `WARN font binaries shipped` -> same.

Phase 04 will refuse to run until this writes `ok: true`.

---

## Step 6 — phase 04, archive  *(skip when depth=spec or transport=mcp)*

```
node $PLUGIN/scripts/hdd-archive.js [--out "$OUT"] [--format zip|targz|both]
```

Both gates must read `PASS`.

- `zip carries exactly the validated bytes — N/N files, every one byte-identical to the verdict`.
  Phase 04 decodes the finished archive and compares the sha256 of every file inside it against
  the per-file digests phase 03 recorded. A `FAIL` naming *altered* contents means something wrote
  to the bundle while the archiver was reading it — check nothing else is working in `$OUT`, then
  re-run 03 and 04. A failed archive is deleted, so there is nothing half-finished to pick up.
- No host archiver is needed: both formats are written in-process using Node's `zlib`. There is no
  `zip` / `bsdtar` to install and nothing to fall back to.

The receiving end can check the result before it trusts it. The companion DeepSeek Harness bundle at
`dsh/` ships `handoff_inspect`, which verifies a `<Project>-handoff.zip`, a `.tar.gz` or an
already-extracted bundle directory against the bundle contract and reports the tree digest, and
`handoff_import`, which re-verifies and then extracts every entry verbatim, refusing to overwrite a
non-empty target without `force`. Neither is invoked by these scripts — they are what the receiving
agent runs.

---

## Step 7 — the prompt

```
node $PLUGIN/scripts/hdd-prompt.js --transport mcp                    [--focus "a.html"] [--instructions "..."]
node $PLUGIN/scripts/hdd-prompt.js --transport mcp --agent claude     [--focus "a.html"] [--instructions "..."]
node $PLUGIN/scripts/hdd-prompt.js --transport zip                    [--focus "a.html"] [--instructions "..."]
```

`--agent` exists on this phase only, and defaults to `dsh`. Leave it alone unless the receiving agent
is a different `od mcp install` client.

What the default (`dsh`) forms emit, and why they differ from the generic ones:

- **mcp** — there is no `od mcp install dsh`, and there never will be, so the prompt hands the reader
  the client row itself: an `@deepseek-ai/dsh-mcp-client` entry with `serverName: opendesign`,
  `transport: stdio`, `command: od`, `args: [mcp]`. Any other `--agent` still gets the upstream
  `od mcp install <agent>` sentence.
- **zip** — the prompt opens by naming `handoff_import` in the companion bundle at `dsh/`, which
  re-verifies the archive and extracts it verbatim, and only then says to read `<slug>/README.md` in
  full. Any other `--agent` gets the plain "unzip it into your repo" opener.

Print the result for the user to copy. Written to `.handoff/prompt.txt`.

---

## Step 8 — report

State, in this order:

1. The exact path of the archive, or the prompt to paste.
2. What the bundle contains — file count, whether a design system is included, whether an
   adherence config was generated or mirrored.
3. Every `WARN`, in plain terms. "The design system loads its fonts from Google, so the bundle
   needs a network connection to render exactly." Do not bury this.
4. When a spec was authored: which sections still need the user's judgement.

With the default `--agent dsh`, also say which door the prompt opened: the `mcp` form carries the
`@deepseek-ai/dsh-mcp-client` row, the `zip` form names `handoff_import` in the companion bundle at
`dsh/`, which re-verifies the archive before extracting it.

Never report success while any phase printed `BLOCKED`.

---

## Recovery

| Symptom | Cause | Fix |
|---|---|---|
| `no .handoff/state.json` | phase 00 not run, or wrong `--out` | re-run 00 with the same `--out` |
| `<slug>/ already exists` | rebuilding | add `--force` |
| `phase 03 has not passed` | archiving before validating, or after a rebuild cleared the verdict | run 03; fix any `FAIL` |
| `the bundle changed after it was validated` | the tree was edited after 03 | run 03 again — it re-checks root purity, symlinks, spec and adherence |
| `the verdict predates tree binding` | the verdict carries no per-file digest — written by a release from before tree binding existed (≤ 0.1.6) | run 03 again |
| `carries exactly the validated bytes` fails | the archiver dropped, added or altered a file — including something else writing in the output tree during phase 04 | make sure nothing else is touching the bundle, run 03, then 04 again |
| `mirrored N/M files` mismatch | a file could not be copied — permissions, or it vanished mid-copy | fix the source, re-run 01 `--force` |
| adherence disagrees with manifest | hand-edited config | delete it and re-run 01 `--force` |
| `prop rule for unknown component` | manifest and `components/` out of sync | re-export the DS from Open Design |
| `depth=both requires the authored spec` | built in the old order — 01 before 02 | finish step 3, then re-run 01 `--force` |
| `still carries TODO markers` | the spec is a skeleton | author it, confirm with `--spec`, re-run 01 `--force` |
| `depth=spec — phase 01 does not run` | wrong depth for what you want | re-run 00 with `--depth both` |
| `includeChats is on but no transcript directory` | `--include-chats` without `--chats-dir` | pass the directory, or `--include-chats false` |
| I9 `refusing to mirror … symlink(s)` | the project links outside itself | remove the links, or replace them with real copies |
