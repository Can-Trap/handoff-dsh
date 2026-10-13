# The bundle contract (Mechanism A)

What phase 01 builds and phase 03 enforces. Every rule here is recovered from real handoff
bundles, not from documentation.

## Naming

| Thing | Rule | Example |
|---|---|---|
| archive | `<sanitized Project Display Name>-handoff.zip` | `Nova Reader App-handoff.zip` |
| companion | `<sanitized Project Display Name>-handoff.tar.gz` | — |
| root dir | project name, lower-kebab | `nova-reader-app/` |

The `-handoff` suffix is the discriminator — a plain project export drops it. Slugging is NFKD
normalize, strip diacritics, lowercase, every run of non-`[a-z0-9]` to `-`, collapse repeats, trim.

Verified against four real project names, including `Studio CSS - Base Set` -> `studio-css-base-set`.

**Port fix.** The archive name is the display name with the characters no filesystem wants —
`/ \ : * ? " < > |` and the C0 controls — replaced by spaces, runs of whitespace collapsed, leading
and trailing dots and spaces trimmed, and the slug substituted when nothing survives that. Upstream
derived it twice and the two answers disagreed: phase 04 sanitized the name, the zip prompt's
fallback did not, so a project called `My App: v2` produced an archive named `My App v2-handoff.zip`
and a prompt telling the receiving agent to look for `My App: v2-handoff.zip`. Both sides now call
one exported helper, `archiveBase(name, slug)` in `scripts/_lib.js`, so they cannot disagree again.
This one is a port fix, not upstream behaviour.

## Tree

```
<project-slug>/
├── README.md            # generated
├── AGENTS.md            # ours, pointer only, rootPointers=true
├── CLAUDE.md            # ours, pointer only, rootPointers=true
├── chats/               # includeChats=true
└── project/             # verbatim mirror
```

**Root purity.** Real bundles contain exactly `README.md` + `project/` and nothing else. The two
pointer files are our only divergence and are gated behind `rootPointers` for anyone who wants
strict parity. Everything else at root is a bug and phase 03 fails on it.

## The README

One generated file. Slots: `{{ENTRY_DIRECTIVE}}`, `{{DESIGN_SYSTEM}}`, `{{CONTENTS}}` — plus the
slug and project name interpolated inside them. Phase 01 fails if any `{{SLOT}}` survives.

`{{ENTRY_DIRECTIVE}}` has two forms:

- **Form 1** — an entry file is known. Names it, says the user had it open at trigger time,
  mandates reading it in full then following its imports.
- **Form 2** — none known. Says to find the primary design file, then the same import rule.

The entry file comes from `get_active_context()`. Do not guess one; Form 2 is a valid outcome.

When `includeChats` is on, a chats directive is prepended: the intent lives in the conversation, the
files are only what that intent produced.

### The six decisions

Preserve all six in any rewording. They are the actual product:

1. Mandated reading order — entry file in full, then transitively follow imports.
2. Anti-skim.
3. Anti-screenshot — the source is complete; a screenshot costs a round trip to learn nothing.
4. Prototype != production — match the visual result, not the internal structure.
5. Clarify before building.
6. Framework-agnostic.

## The mirror

`project/` is byte-verbatim. **Never** rename, re-suffix, reformat or prune.

The `.jsx.txt` / `.d.ts.txt` suffix seen inside Open Design is added by **OD's importer** on the way
in. The exporter ships plain `.jsx` / `.d.ts`. Reproducing the `.txt` would be a bug; phase 01 and
phase 03 both check for it.

Excluded: `_ds_sync.json` (inbound-sync bookkeeping, deliberately absent from every real bundle),
`.git/`, `node_modules/`, `.handoff/`.

Copied if the project has them, generated never: `CLAUDE.md`, `DESIGN.md`. A `project/CLAUDE.md` is
a user-authored note that happens to live in the project. Treat its presence as incidental.

## The design system

Copied whole into `project/_ds/<ds-slug>-<uuid>/`, **plus a short alias directory** carrying
duplicate `_ds_bundle.css` / `_ds_bundle.js` / `fonts/`. The alias is the name the HTML actually
references; ship one without the other and the prototypes render unstyled. Gated as I3.

A design-system-kind project **is** the design system: its manifest sits at the project root with no
`_ds/` wrapper and no alias. Both layouts are detected automatically.

Payload: `README.md`, `styles.css`, `_ds_bundle.css`, `_ds_bundle.js`, `_ds_manifest.json`,
`_adherence.oxlintrc.json`, `tokens/tokens.json`, `fonts/`, and conditionally `components/`.

**Two shapes:**

| Source | `components/` | Detect by |
|---|---|---|
| project-local | expanded — `<group>/<Name>/{jsx,d.ts,html,prompt.md}` | `components/` exists |
| published npm library | collapsed into `_ds_bundle.js` | it does not |

### `_ds_manifest.json`

```
namespace  components[{name,sourcePath}]  startingPoints  cards[{path,group,viewport}]
templates  hasThumbnailHtml  globalCssPaths[]  tokens[{name,value,kind,definedIn}]
themes  fonts  brandFonts  source
```

`tokens[].kind` is one of `color`, `glass`, `radius`, `elevation`, `type`, `motion`.

### Tokens

There is **no single canonical token format**, and normalizing would be wrong. Observed carriers:
`tokens/tokens.json` (W3C-ish, `$name` + `$description` + kind groups), `styles.css` +
`_ds_bundle.css` custom properties, a standalone `tokens.css`. Phase 00 records which one the
project uses; the mirror copies it as-is.

## Offline-completeness

A bundle should render with no network. Real bundles ship actual `.woff2` binaries plus
`fonts/fonts.css` rather than font-CDN links.

**But this is a property of the source, not an invariant we can enforce.** The mirror is verbatim,
so a project whose stylesheet `@import`s a remote font, or whose HTML loads React from a CDN,
produces a bundle that needs the network. Both occur in real bundles.

Phase 03 therefore **warns** rather than fails, and `--strict` escalates. Never "fix" it by
rewriting the mirror — that breaks a hard invariant to satisfy a soft one.

## No manifest

Real bundles carry no `manifest.json`, no `handoff.json`, no `bundle.json`. **The tree shape is the
schema.** Adding one would be diverging, not improving. Our own bookkeeping lives outside the
bundle, in `.handoff/`.

Likewise: never `HANDOFF.md`, never `IMPLEMENTATION.md`. The instruction file is `README.md`.

## Invariants

| Id | Rule |
|---|---|
| I1 | `project/` is verbatim — never rename, re-suffix, reformat |
| I2 | Offline-completeness is reported, never manufactured |
| I3 | Canonical design-system dir and its alias both ship |
| I4 | `_ds_sync.json` never ships |
| I5 | No manifest, no screenshots — convention over schema |
| I6 | `README.md` is the sole instruction carrier; pointers point, never duplicate |
| I7 | Adherence config only when a design system is bound; derived, never hand-written |
| I8 | Archive only after phase 03 writes `ok: true` **for the tree being archived** |
| I9 | Nothing outside the project directory is ever mirrored, named or read |
| I10 | An advertised option is a promise: every declared input is wired to behaviour and checked by a gate |

### I8 in practice

"Unvalidated" has to mean *this tree*, not a tree that once lived at this path. A
verdict carrying only `ok` is a claim about a path, and a path can be rebuilt or
edited underneath it — so phase 04 would archive a tree phase 03 never inspected
while I8 still claimed otherwise. The omitted checks are not cosmetic: root purity,
symlink rejection, spec completeness and adherence consistency all live in phase 03.

Two independent mechanisms, because either alone leaves a hole:

1. **Cleared on mutation.** Phase 01 deletes `.handoff/validate.json` and
   `archive.json` before it touches the bundle — after its own refusals, so a
   *rejected* build never costs you a good verdict. A `--force` rebuild therefore
   leaves nothing for phase 04 to accept.
2. **Bound to a digest.** Phase 03 records a `treeHash` over every path and its
   content, and phase 04 recomputes it and refuses on any difference. That covers the
   edit phase 01 never saw. Content only — no mtimes, no build timestamps — so an
   identical rebuild stays valid and a changed one does not.

Neither mechanism proves the *archiver* read the tree they vouch for. Between
`hashTree` and the archiver's `open()` the directory is still writable — by another
agent working in the output tree, by a racing build, by a substituted tool — so a
file can be swapped under the same name and land in the archive. Comparing entry
names cannot see that, and comparing counts is weaker still: it accepts an archive
that dropped one file and gained another.

So phase 03 records a **per-file** digest, and phase 04 decodes the finished archive
and compares the sha256 of every regular file it actually contains against that
record. Three failure modes are reported separately — missing, unexpected, and
"contents that are not what phase 03 validated". An archive that fails is **deleted**,
along with `archive.json`: a non-zero exit is not enough when the file would still be
sitting there looking finished.

The archive is decoded in-process (zip central directory + `inflateRaw`, tar via
`gunzip` and 512-byte headers, including GNU `L` and pax `x` long names) rather than
by shelling out to an extractor. Partly portability — GNU tar cannot read a zip — but
mostly independence: running the check through the same external tool family that
wrote the archive would let one lying tool vouch for another.

Because the digest walk refuses unsafe symlinks, a link planted after validation
would not change the hash — so phase 04 checks the bundle for links directly before
the archiver can follow one.

A verdict written by a release that predates the digest is refused rather than
trusted.

### I9 in practice

A symlink is not a design file, and `Dirent.isDirectory()` describes the *link*, not
its target — so an unclassified walk hands every link to `copyFileSync`, which either
copies an external target's bytes into the bundle or throws (`EISDIR` on POSIX,
`EPERM` on Windows) and aborts the mirror.

The policy is applied to the **resolved** target:

| Link resolves | Outcome |
|---|---|
| under the project root | followed, and materialized as its target's content — the bundle must stay self-contained, and zip/tar would flatten the link anyway |
| under the root but excluded (`node_modules`, `.git`, sync bookkeeping) | skipped exactly as the target would be, so a link is not a way around `NEVER_SHIP` |
| outside the root | **refused** — phase 00 fails its gate, phase 01 exits 2 before writing or deleting anything |
| nowhere (dangling) | **refused** — a mirror that silently omits a file is not verbatim |

The same rule covers raw path input, which bypasses the walker entirely: `--entry`,
`--files` and `--focus` are each rejected when they resolve outside the project, and
`designSystem.dir` is re-checked when read back from `state.json`. Phase 03 then
asserts the finished bundle contains no symlinks at all — any survivor is a hole the
archive would flatten or drop.

An explicitly supplied `--chats-dir` is the one path allowed to sit outside the
project. I9 governs what the tool *discovers*; that directory is named by the
operator, and the transcript it holds does not live in the project on disk.

### I10 in practice

`depth` shipped for three releases as a declared input that phase 00 wrote into
`state.json` and **nothing ever read**. The documented order ran phase 01 before
phase 02, so the mirror was snapshotted before the spec existed and no phase
refreshed it: `depth=both` produced an archive with no spec in it, and every gate
still reported `PASS`. `includeChats` was worse in kind — it was read, but only to
add a `chats/` line to the README and permit `chats` at bundle root, while nothing
ever created the directory. The README named a path the bundle did not contain.

Two mechanisms keep that from recurring:

1. **Structural.** `hdd-validate.js --self` and the test suite both assert that every
   input in `open-design.json` is read back somewhere as `options.<name>`. Declaring
   an input without wiring it fails the packaging check.
2. **Behavioural.** Each option is asserted in the *built tree*, not inferred from the
   fact that a phase ran: phase 01 gates `authored spec nested in the mirror` and
   `conversation transcript included`, and phase 03 re-checks both against the
   directory the archive is made from.

The structural check is necessary, not sufficient — `includeChats` would have passed
it. The behavioural gates are what caught that one.

### Re-checked at the receiving end

Everything above is enforced twice, and the second time is not by this pipeline. The companion
DeepSeek Harness bundle at `dsh/` receives a handoff with three Host tools, and what they check is
this contract:

- `handoff_inspect` — verify a `<Project>-handoff.zip`, a `.tar.gz`, or an already-extracted bundle
  directory against the bundle contract: root purity, `README.md` as the instruction carrier, no
  unfilled `{{SLOT}}` markers, no sync bookkeeping, no re-suffixed sources, the design system and its
  alias both present, an adherence config that parses, and no entry escaping the extraction root.
  Reports the tree digest; writes nothing.
- `handoff_import` — re-verify, then extract every entry verbatim into a target directory, refusing
  to overwrite a non-empty target without `force`. I1 is the reason it may not rename, re-suffix or
  reformat anything on the way out either.
- `handoff_brief` — surface the bundle's generated `README.md` as the brief the receiving agent must
  follow.

That is why I6 is load-bearing rather than tidy: the receiving side has no second instruction file
to fall back on, and why the `zip` prompt for `dsh` opens by naming `handoff_import` instead of
telling the agent to unzip the archive itself.
