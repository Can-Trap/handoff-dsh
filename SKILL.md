---
name: handoff-dsh
description: "Use this plugin when you want to hand an Open Design project off to DeepSeek Harness — or to Claude Code, Cursor, Codex or Pi — as something a coding agent can implement from faithfully. It is the open-source counterpart of the proprietary design-to-code handoff: same process, both ends open. Emits a copyable MCP prompt as the primary path, plus an offline-complete <Project>-handoff.zip carrying a verbatim project mirror, the design system materialized with real font binaries, and a generated oxlint adherence config that makes design fidelity machine-checkable. Optionally authors a full per-screen implementation spec. Triggers: handoff-dsh, /handoff-dsh, hand off to DeepSeek Harness, export this design for a coding agent, design-to-code handoff, Open Design to code."
license: MIT
metadata:
  author: Trap
  version: '0.1.0'
---

# Handoff to DeepSeek Harness

Turn an **Open Design** project into something **DeepSeek Harness** can implement from, faithfully.

This is the open-source counterpart of the proprietary design-to-code handoff: the **same process**,
with both ends open. It is also the return leg of the loop `@ross-sec/sync-od` opened, which is what
makes the round trip actually close:

```
sync-od     : codebase      ->  Open Design      (already shipped)
handoff-dsh  : Open Design   ->  DeepSeek Harness         (this plugin)
```

DeepSeek Harness is the default receiving end (`--agent` defaults to `dsh`), but nothing here is
DeepSeek Harness-specific: the bundle is harness-neutral (`AGENTS.md` is the entry point), and any
other `--agent` value emits the upstream `od mcp install <agent>` sentence — the installer Open
Design ships for `claude`, `codex`, `cursor`, `opencode`, `pi`, `copilot`, `cline`, `kiro`, `trae`.
`dsh` is deliberately not one of them: there is no `od mcp install dsh`, so the MCP prompt hands
over the `@deepseek-ai/dsh-mcp-client` row itself instead. Tell the receiving agent it can push its
work back with `sync-od`; that sentence is what turns a one-way export into a loop.

**Bundled scripts do the mechanical work.** Run ONE phase at a time, read its gate, then run the
next. Every phase writes a real artifact to a real path; a phase that has not passed its gate is
not done, no matter how good the plan looked.

## The one idea

A handoff is **not** a zip. A handoff is **an instruction to an agent**, and the zip is one way to
carry it. There are two mechanisms and they are frequently confused:

| | **A — bundle** | **B — spec** |
|---|---|---|
| Made by | scripts, **no model tokens** | you, authoring |
| Root | `<project-slug>/` | `design_handoff_<feature>/` |
| Says | "read the source, here it all is" | "here is exactly what to build" |
| Cost | seconds | a full turn |

`depth=both` (the default) nests B inside A — the same composition real handoff bundles show.

## Golden rules

1. **RUN the scripts.** Never hand-write a bundle tree, a README, an adherence config, or a token
   table. `scripts/` emits all of them. Hand-written output drifts from the gates and fails 03.
2. **The mirror is verbatim.** Never rename, re-suffix, reformat, or "tidy" anything under
   `project/`. If the source ships `Button.jsx`, the bundle ships `Button.jsx` — not `Button.jsx.txt`.
3. **One phase at a time.** Read the gate output before moving on. `BLOCKED` means stop and fix.
4. **Derive, never invent.** Every token, hex, path and prop traces to a file you read this run.
   No hex outside the extracted palette. No route you did not find in the prototype.
5. **`README.md` is the sole instruction carrier.** `AGENTS.md` and `CLAUDE.md` may point at it;
   they never duplicate it, and nothing else lands at bundle root.
6. **Never archive unvalidated bytes** — not merely an unvalidated path. Phase 01 clears the verdict
   before it rebuilds, phase 03 records a per-file digest of what it inspected, phase 04 recomputes
   it before archiving, and then decodes the finished archive and compares the sha256 of every file
   inside it against that record. An archive that fails is deleted rather than left looking
   finished. Touch the bundle by hand after validating and phase 04 will stop you; re-run 03.
7. **Ask before assuming scope.** When `depth` includes `spec`, the feature boundary is the user's
   call, not yours.

## Phases

Scripts live in this plugin's `scripts/`. Run them with `node`, from the directory you want the
bundle written to (`--out` overrides).

Run them in **this order**. The numbering is the phase, not the sequence:

| Order | # | Command | Emits | Gate |
|---|---|---|---|---|
| 1 | 00 | `hdd-detect.js --project-name <name> --project-dir <cwd> [--entry <file>]` | `.handoff/state.json` | entry mode, design system, token carrier, options satisfiable |
| 2 | 02 | `hdd-spec.js --feature "<scope>"` | `design_handoff_<slug>/` in the **source project** | skeleton + prototypes copied |
| 3 | — | *author the spec over its TODO markers*, then `hdd-validate.js --spec` | — | no TODO markers left |
| 4 | 01 | `hdd-bundle.js [--force]` | `<slug>/` | slots filled, mirror verbatim, DS + alias, adherence, spec nested |
| 5 | 03 | `hdd-validate.js [--strict]` | `.handoff/validate.json` | see below |
| 6 | 04 | `hdd-archive.js [--format zip\|targz\|both]` | `<Project Name>-handoff.zip` + `.tar.gz` | verdict still binds this tree; the archive's own bytes match it |
| — | — | `hdd-prompt.js --transport mcp\|zip\|both [--agent <name>]` | `.handoff/prompt.txt` | — |

**02 runs before 01, and that ordering is load-bearing.** Phase 02 writes the spec into the
*source project*; phase 01 takes a single verbatim snapshot of that project and no later phase
refreshes it. Bundle first and the spec is simply absent from the archive — every gate still passes,
and the `depth=both` deliverable is silently missing. Phase 01 refuses to run at `depth=both` until
the authored, TODO-free spec exists, so the ordering is enforced rather than merely written down.

Skip 02 when `depth=bundle` — the script refuses at that depth. Skip 01/04 when `depth=spec` — same.

### Getting the facts in

Scripts never call MCP. **You** fetch the Open Design facts and pass them as flags:

- `--project-name` — the project's display name. Drives the slug and the archive name.
- `--project-dir` — the project cwd on disk.
- `--entry` — the **active file**, from `get_active_context()`. This is the analogue of the design
  tool reading your open editor tab, and it decides which of the two README forms is written.
  Omit it and the bundle tells the agent to find the primary design file itself.

## Transport — the prompt is the primary path

The product this reproduces defaults to **a copyable prompt**, not a download; the archive sits
behind an overflow menu. Mirror that:

- `transport=mcp` — emit a prompt telling the agent to read the project live over Open Design's own
  MCP. For every client Open Design ships an installer for, that is the upstream sentence
  `od mcp install <agent>` (`claude`, `codex`, `cursor`, `opencode`, `pi`, `copilot`, `cline`, `kiro`,
  `trae`). The default receiving end cannot use it: `od mcp install dsh` does not exist, so the prompt
  hands over the registration row itself — an `@deepseek-ai/dsh-mcp-client` entry carrying
  `serverName: opendesign`, `transport: stdio`, `command: od`, `args: [mcp]`. Nothing to unpack,
  never stale. Best when the agent runs on this machine.
- `transport=zip` — emit the archive plus a prompt that points at it. For `dsh` the prompt opens by
  naming the companion bundle's `handoff_import` tool, which re-verifies the archive and extracts it
  verbatim, instead of telling the agent to unzip it; every other `--agent` keeps the upstream
  "unzip it into your repo" opener. Best when the agent is elsewhere, offline, or has no MCP.
- `transport=both` — do both and let the user pick.

`--agent <name>` belongs to `hdd-prompt.js` alone — phase 00 neither records nor validates it — and
defaults to `dsh`. Name any `od mcp install` target to emit that client's install line instead.

**The receiving end is not left alone with the archive.** The companion DeepSeek Harness bundle at
`dsh/` ships the tools that check a handoff before it is trusted: `handoff_inspect` verifies a
`<Project>-handoff.zip`, a `.tar.gz` or an already-extracted bundle directory against the bundle
contract — root purity, `README.md` as the instruction carrier, no unfilled `{{SLOT}}` markers, no
sync bookkeeping, no re-suffixed sources, the design system and its alias both present, an adherence
config that parses, and no entry escaping the extraction root — and reports the tree digest.
`handoff_import` re-verifies, then extracts every entry verbatim, refusing to overwrite a non-empty
target without `force`. `handoff_brief` surfaces the bundle's generated `README.md` as the brief the
receiving agent must follow.

**File selection shapes the prompt, never the archive.** `hdd-prompt.js --focus a.html,b.html`
narrows what the agent is told to read first; the bundle always carries the whole project. That
asymmetry is deliberate — the agent should be able to look beyond the selection.

`hdd-prompt.js` also walks the focused HTML for `<script src>`, `<link href>`, `<img src>`,
`<iframe src>`, `<x-import from>` and `@import`, and lists the local files it finds under
*"Also read these files the selection imports"*.

## The bundle

```
<project-slug>/
├── README.md         # the instruction carrier — generated, never hand-written
├── AGENTS.md         # pointer (rootPointers=true)
├── CLAUDE.md         # pointer (rootPointers=true)
├── chats/            # only when includeChats=true, from --chats-dir
└── project/          # verbatim mirror
    ├── <Design>.dc.html  support.js  .thumbnail
    ├── _ds/<ds-slug>-<uuid>/   # the design system, whole
    ├── _ds/<short-alias>/      # what the HTML actually <script src>'s — both must exist
    └── design_handoff_*/       # B-folders, when depth=both
```

The README encodes six decisions. Preserve every one; they are the product, not decoration:

1. **Mandated reading order** — entry file in full, then transitively follow its imports.
2. **Anti-skim** — top to bottom.
3. **Anti-screenshot** — do not render or screenshot unless asked. The source is complete, and a
   screenshot costs a round trip to learn nothing.
4. **Prototype != production** — reproduce the visual result, not the prototype's internals.
5. **Clarify before building.**
6. **Framework-agnostic** — whatever the target codebase already uses.

### The design system, and why the alias matters

The bound design system is copied **whole**, and a short alias directory sits beside the canonical
UUID one because that is the name the HTML actually references. Ship one without the other and the
prototypes render unstyled. Phase 01 gates this (I3).

Two shapes, detected automatically: a **project-local** design system ships expanded
`components/<group>/<Name>/{jsx,d.ts,html,prompt.md}`; a **published library** collapses into
`_ds_bundle.js`. Do not try to expand a collapsed one.

### `_adherence.oxlintrc.json` — fidelity you can check

The highest-value thing in the bundle, and the easiest to overlook. A generated oxlint config that
polices the **target** codebase: raw hex, raw `px`, fonts the system does not provide, imports that
reach into component internals, props a component does not declare, and inline string-literal
unions constrained to their allowed values.

Generated from `_ds_manifest.json` plus each component's `.d.ts` — **never by hand**; see
`references/adherence.md`. Emitted only when a design system is bound. If the source already has
one, it is mirrored byte-for-byte instead.

## The spec (Mechanism B)

`hdd-spec.js` does the mechanical half — folder, prototypes, `DESIGN.md`, token table, asset
inventory, file tree, and a **route map** pre-filled from the screen states it finds in the
prototype. You author the prose over the `TODO` markers.

Required sections, in order: title `# Handoff: <Project> — <Feature>`, then `Overview`,
`About the Design Files`, `Fidelity`, the scope body, `Interactions & Behavior`,
`State Management`, `Design Tokens`, `Assets`, `Files`. Full guidance and the optional
high-value sections are in `references/spec-sections.md`.

**The route map is the single most valuable thing you will write.** A prototype multiplexes every
screen through one state machine and has no routing; the target needs real routes. Nobody but you
can make that mapping, and no amount of reading the HTML gives it to the receiving agent for free.

Be exact. Specify **algorithms**, not descriptions — a strength meter gets its scoring rule and
per-score color and width, not "shows password strength". Quote copy verbatim. Factor shared chrome
out once. A developer who was not in the conversation must be able to build from the README alone.

**Screenshots: ask, default no.** Real bundles carry none.

## Validation gates

Phase 03 hard-fails on: `_ds_sync.json` present, re-suffixed sources, unfilled README slots, a
missing `CODING AGENTS` heading, anything unexpected at bundle root, root-level screenshots, an
unparseable adherence config, or an adherence config that disagrees with the DS manifest.

It **warns** on offline-completeness and missing font binaries. Those describe the source, not our
work: the mirror is verbatim, so a project whose design system `@import`s a remote font produces a
bundle that needs the network. Report it; do not silently "fix" it by rewriting the mirror. Pass
`--strict` when the user needs a genuinely offline-complete bundle and would rather fail than ship.

`--spec <slug>` validates the authored document instead: required sections present and ordered,
zero `TODO` markers, prototypes present, and the reference-not-artifact statement made up front.

## Reporting back

Close by telling the user, in this order: the **exact archive path** (or the prompt), what the
bundle contains, every `WARN` the run produced and what it means for them, and — when a spec was
authored — which sections still need their judgement. Never claim a handoff is ready while a gate
is `BLOCKED`.

For the default receiving end, also say how the agent gets in: the `mcp` prompt carries the
`@deepseek-ai/dsh-mcp-client` row, and the `zip` prompt points at `handoff_import` in the companion
bundle at `dsh/`, which re-verifies the archive before extracting it.

## References

| File | What it holds |
|---|---|
| `references/RUNBOOK.md` | numbered, copy-paste steps with no judgement calls |
| `references/adherence.md` | the adherence generator's rule-by-rule derivation |
| `references/spec-sections.md` | the authored-README section spine + what earns a section |
| `references/bundle-contract.md` | tree, README slots, DS materialization, invariants |
| `references/mcp-contract.md` | the Open Design surface that actually exists |
| `references/platforms.md` | installing, trust, capabilities, version skew |
| `dsh/` | the receiving end: `handoff_inspect`, `handoff_import`, `handoff_brief` |
