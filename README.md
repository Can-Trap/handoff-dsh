# Handoff to DeepSeek Harness

Hand an [Open Design](https://open-design.ai) project off to
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — faithfully.

An implementation of the design-to-code handoff pattern, **plus the half that pattern usually leaves
implicit**: the receiving end, as a DeepSeek Harness plugin bundle that verifies what it is handed
instead of trusting it.

```
sync-od        : codebase       ->  Open Design        (the other leg, already shipped)
handoff-dsh    : Open Design    ->  DeepSeek Harness   (this repo)

  handoff-dsh/          the Open Design plugin — builds the deliverable
  handoff-dsh/dsh/      the DeepSeek Harness bundle — receives it
```

## What it does

Two mechanisms, composable — the default runs both:

| Mode | What you get | Cost |
|------|--------------|------|
| **bundle** | `<Project>-handoff.zip` — a verbatim project mirror, the design system materialized with real `.woff2` binaries, and a generated adherence config | seconds, no model tokens |
| **spec** | `design_handoff_<feature>/` — an authored per-screen implementation document | one agent turn |
| **both** (default) | the spec nested inside the bundle | |

Then one of two transports:

| Transport | How it lands | Trade-off |
|---|---|---|
| **mcp** | the receiving agent reads the Open Design project live over MCP | never stale, needs Open Design running |
| **zip** | an offline-complete archive, verified on arrival by the companion bundle | works anywhere, forever; the file arrives from somewhere else, so it is checked |

## Install

### The sender — an Open Design plugin

Not published to npm. An Open Design plugin *is* a folder, so install the folder:

```bash
od plugin install github:Can-Trap/handoff-dsh
od plugin trust handoff-dsh --capabilities fs:read,fs:write,bash
od plugin doctor handoff-dsh
```

Or vendor it at `<yourRepo>/.open-design/plugins/handoff-dsh/` to version-control it with your code.

### The receiver — a DeepSeek Harness bundle

`dsh/` is a zero-dependency bundle. Install it through the harness's own plugin manager, which does
the package installation and bundle selection:

```
plugin_manager install_bundle <path-to>/handoff-dsh/dsh
```

It registers three tools and needs no `od`, no daemon, and no capability grant:

| Tool | What it does |
|---|---|
| `handoff_inspect` | Verify an archive or extracted bundle against the bundle contract. Writes nothing. |
| `handoff_import` | Verify, then extract every entry **verbatim** into a target directory. |
| `handoff_brief` | Surface the bundle's `README.md` — the instruction carrier — and the entry file it names. |

See [`dsh/README.md`](dsh/README.md) for the gates, the limits, and why the reader is a separate
implementation rather than a shared one.

## Use

In Open Design the plugin appears as a card in the inline rail under the composer. Click **Use**.

| Input | Options | Default |
|---|---|---|
| `depth` | `bundle` · `spec` · `both` | `both` |
| `feature` | free text — the scope for the authored spec | — |
| `transport` | `zip` · `mcp` · `both` | `zip` |
| `includeChats` | boolean | `false` |
| `rootPointers` | emit `AGENTS.md` / `CLAUDE.md` pointers | `true` |
| `verification` | add a visual-verification section to the spec | `false` |

Or drive the scripts directly — the order is load-bearing and enforced:

```bash
node scripts/hdd-detect.js --project-name "My App" --project-dir <cwd> --entry "Landing.dc.html"
node scripts/hdd-spec.js --feature "<scope>"     # scaffold, then AUTHOR over the TODOs
node scripts/hdd-validate.js --spec              # refuses a spec that is still a skeleton
node scripts/hdd-bundle.js
node scripts/hdd-validate.js
node scripts/hdd-archive.js
node scripts/hdd-prompt.js --transport mcp
```

## The bundle

```
my-app/
├── README.md            # the instruction carrier — generated
├── AGENTS.md CLAUDE.md  # pointers (rootPointers)
└── project/             # verbatim mirror
    ├── <Design>.dc.html  support.js
    ├── _ds/<ds-slug>-<uuid>/   # the design system, whole
    └── _ds/<short-alias>/      # what the HTML actually loads — both must ship
```

No manifest, no screenshots. **The tree shape is the schema.** Nothing is renamed, re-suffixed or
reformatted: `Button.jsx` stays `Button.jsx`.

Ten invariants (I1–I10) are enforced by gates rather than documented as intentions, the archive is
written in-process with `node:zlib` and then read back and checked byte-for-byte, and phase 04
refuses to archive a tree that phase 03 did not validate *as that tree* — the verdict carries a
content digest, so editing a file after validation invalidates it.

## Notes on this implementation

The Open Design side of this project derives from an earlier MIT-licensed design-to-code handoff
plugin. Four things about it are worth calling out:

1. **The receiving agent.** `hdd-prompt.js` defaults to `dsh`. `--agent <name>` still emits the
   original `od mcp install <name>` sentence for every agent Open Design actually ships an installer
   for. There is no `od mcp install dsh` and there will not be one, so for `dsh` the prompt hands
   over the `@deepseek-ai/dsh-mcp-client` row itself.
2. **A receiving end.** `dsh/` — three DeepSeek Harness tools, an independent ZIP/gzip reader that
   verifies every entry's CRC32, a path-traversal policy that refuses rather than sanitizes, and
   digest binding against the sender's `.handoff/validate.json`.
3. **A filename bug fixed.** The zip prompt's fallback filename used the *unsanitized* display name
   while phase 04 wrote the sanitized one, so a project called `Design: v2` produced an archive named
   `Design v2-handoff.zip` and a prompt naming `Design: v2-handoff.zip`. Both now derive through one
   helper, `archiveBase()` in `scripts/_lib.js`.
4. **Version.** `0.1.0`.

The Open Design side is otherwise unchanged, including its reference documentation: the `od` CLI
traps, the trust and capability model, the atom catalog, the zip/ustar traps. Those are facts about
*Open Design*, not about the receiving agent, and they did not change.

## Test

```bash
node --test              # 101 tests: sender pipeline, gates, archive, receiver
npm run validate         # manifest / SKILL.md / atom-catalog self-check, no daemon needed
```

The receiver tests drive the sender's real pipeline and hand it the archive it produced. The
interesting assertion is the cross-implementation one: the sender hashes a tree with
`scripts/_lib.js`, the receiver recomputes that digest from the archive's own decoded bytes with a
separate reader, and the two values must agree. If they agreed because they shared code, the digest
would mean nothing.

## License

MIT © Trap. See [`LICENSE`](LICENSE).

Parts of the sender pipeline derive from an earlier MIT-licensed design-to-code handoff plugin. Its
notice is reproduced in [`NOTICE`](NOTICE) — that reproduction is what the MIT License requires of
any work carrying that code, and it is the only thing that file is for.