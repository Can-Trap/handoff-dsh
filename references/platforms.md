# Installing, trust, and the things that will bite you

## What an Open Design plugin is

A **folder**, not an npm package: `SKILL.md` (required, portable — the same folder works in Claude
Code, Cursor and Codex) plus an optional `open-design.json` sidecar that unlocks the product
surface. `open-design.json` alone is metadata and is **not runnable**.

**Plugins ship zero executable code.** No hooks, no lifecycle, no entrypoint. You contribute
declarations and prose; the daemon concatenates them into the agent's system prompt, and the agent
shells out to whatever scripts the folder bundles. That is why this package has no build step.

**Nothing Open Design publishes is on npm.** Every `@open-design/*` name 404s; every workspace
package is `private: true`. There is no plugin SDK and no types package. Do not add an
`@open-design/*` dependency — it will not resolve. Validate against the schema URL instead.

## Verified against a live daemon — five things the docs get wrong

All confirmed on a running 0.15.1 build. Every one of these cost a debugging cycle.

**1. The daemon is not on `127.0.0.1:7456`.** The desktop app binds a **random high port** and a
Windows **named pipe**. `od plugin install` ignores `OD_SIDECAR_IPC_PATH` and hard-fails to 7456
with `ECONNREFUSED`. Find the real port and pass it:

```bash
# Windows — the daemon port is whichever one answers /api/plugins
powershell -Command "Get-NetTCPConnection -State Listen | ForEach-Object { \
  \$p=(Get-Process -Id \$_.OwningProcess -EA SilentlyContinue); \
  if(\$p.ProcessName -like '*Open Design*'){ \$_.LocalPort } }"
export OD_DAEMON_URL="http://127.0.0.1:<port>"      # or --daemon-url
```

**2. `--source` must start with `./`, and it resolves against the daemon's runtime dir** — not your
shell's cwd, and not an absolute path. An absolute path is treated as a *marketplace name* and 404s
with `plugin-not-found`. The runtime dir is
`…\Roaming\Open Design\namespaces\<ns>\runtime\`, so a folder elsewhere needs a `./`-relative walk:

```bash
od plugin install --source "./../../../../../../Desktop/projects/SKILLS_DEV/plugins/handoff-dsh"
```

**3. `od.context.skills[{path: "./SKILL.md"}]` does not resolve.** It emits
`Unknown skill ref: './SKILL.md'` and contributes **no** context item — even for an already-installed
plugin, and even for Open Design's own bundled `od-default`. Only `{ref: "<registered-id>"}`
resolves. Put the portable skill in **`compat.agentSkills`** instead, which is warning-free and is
what the first-party `od-nextjs-export` does. Same trap for `context.craft` slugs.

**4. `{{var}}` interpolation in `useCase.query` does not happen.** Placeholders survive verbatim into
the user's brief field. The first-party plugin with two inputs has **no placeholders at all** — inputs
are delivered separately in `ApplyResult.inputs`. Write the query as plain prose.

**5. A local-folder install lands as `trust=trusted`, not `restricted`,** and the resolver
auto-derives capabilities you never declared (`genui:confirmation`, `pipeline:*`) and auto-injects a
GenUI surface per atom that needs one (`diff-review` adds `__auto_diff_review_verify:choice`). Read
`capabilitiesRequired` from a real `apply` rather than assuming your manifest's list is the whole set.

## Installing this plugin

**This package is not published to npm** — and it would not need to be. An Open Design plugin is a
*folder*, so every install path takes the folder itself:

```bash
# straight from git
od plugin install github:Can-Trap/handoff-dsh
od plugin install github:Can-Trap/handoff-dsh@v0.1.0

# from a checkout you already have
od plugin install --source ./node_modules/handoff-dsh    # if you vendored it there

# then grant what it needs
od plugin trust handoff-dsh --capabilities fs:read,fs:write,bash
od plugin doctor handoff-dsh
```

Also available: drag-and-drop a zip of the folder (`POST /api/plugins/upload-zip`), or vendor it at
`<projectCwd>/.open-design/plugins/handoff-dsh/` — discovery tier 1, so it lives version-controlled
inside the user's own repo with no CLI step at all.

The **receiving end** is the other half, and it is not an Open Design plugin: `dsh/` is a DeepSeek
Harness bundle, installed through that harness's own plugin manager. It needs no `od`, no daemon and
no capability grant. See [`../dsh/README.md`](../dsh/README.md).

## Trust and capabilities

Third-party plugins install **`restricted`**: `prompt:inject` only, until the user explicitly
grants more. Restricted means no `.mcp.json`, no subprocesses, no connectors.

| Capability | Why this plugin needs it |
|---|---|
| `prompt:inject` | always allowed; how `SKILL.md` reaches the agent |
| `fs:read` | read the project cwd to mirror it |
| `fs:write` | write `<slug>/` and the archive |
| `bash` | run the bundled Node scripts (nothing else is executed — no archiver, no host tool) |

Trust binds to provenance — plugin id, `specVersion`, version/digest, marketplace id, granted caps.
**Elevated capabilities must be re-confirmed on upgrade.** A headless capability-gate failure exits
**66** with structured stderr; retry with `--grant-caps`.

Every capability costs a prompt. Do not add one speculatively.

## Verifying a change

```bash
od plugin validate ./handoff-dsh --json
od plugin install  --source ./handoff-dsh
od plugin doctor   handoff-dsh
od plugin simulate handoff-dsh -s user.confirmed=true
od plugin apply    handoff-dsh --project <projectId> --json
```

Plus the package's own checks, which need no daemon:

```bash
npm test              # unit + golden tests
npm run validate      # manifest / SKILL / atom-catalog self-check
```

**The daemon must be running** for anything `od plugin` does — default
`http://127.0.0.1:7456`, overridable with `--daemon-url` or `OD_DAEMON_URL`.

## Version skew — read this before debugging

The repo and your installed app will not agree. At the time of writing: repo `0.19.2`, a common
installed build `0.15.1`. The shipped CLI has **more** plugin verbs than the spec documents, and the
spec lists verbs (`od plugin export`, `run`, `scaffold`) that do **not** exist in the build.

**Trust `od plugin --help` over the spec document.**

`docs/plugins-spec.md` self-describes as *"draft, awaiting review"*. The manifest v1 shape is safe
to build on — `specVersion` exists to absorb change, `additionalProperties: true` everywhere,
snapshots freeze the version for replay, and a published JSON Schema validates it. The volatile
parts are the atom catalog, the `until` vocabulary, GenUI `component`, and connectors.

## Archive writing — no host tool, at either end

**Both formats are written in-process. No external archiver is required, or used.**

That is a deliberate change from earlier releases, which picked whichever of bsdtar, Info-ZIP `zip`,
macOS `tar -a` or PowerShell `Compress-Archive` happened to exist. On a plain Linux host with only
GNU tar that list is **empty**, and since `transport` defaults to `zip`, the default workflow failed
at the promised deliverable — on a host package the plugin never declared. Node's `zlib` is always
there, so the writer uses it: DEFLATE plus a hand-built central directory for zip, ustar plus gzip
for tar.gz.

Dropping the shell-out also removed two platform bugs that were pure accident of tooling:

- **GNU tar accepts `-a -c -f out.zip` and silently writes a TAR.** Where Git Bash's GNU tar shadowed
  the system one you got a plausible-looking `.zip` no unzip tool could open — 368 KB of tar against
  a 122 KB real zip, verified on Windows with GNU tar 1.35.
- **GNU tar reads the `C:` of an absolute Windows output path as a remote host spec** and refuses.

Two encoding details the writer has to get right, because nothing else will now:

- The zip sets **general-purpose bit 11** on any entry whose name is not pure ASCII, marking it
  UTF-8. Without it a reader falls back to CP437.
- The tar emits a **pax `x` header** carrying `path=` for any name that is non-ASCII or longer than
  ustar's 100-byte field. ustar declares no encoding, so bsdtar on Windows decoded raw UTF-8 bytes
  with the ANSI codepage and extracted `файл-ünïcode.txt` as mojibake — the bytes were intact, the
  name was not. pax is defined as UTF-8, and it covers long paths at the same time.

Output is verified against external readers, not just our own: bsdtar, PowerShell `Compress-Archive`
and Python's `zipfile` (CRC check) all extract it byte-identically to the source.

## Portability

`SKILL.md` carries standard agent-skill frontmatter, so this folder also drops into
`~/.claude/skills/`, `.claude/skills/`, or any harness that reads agent skills. Outside Open Design
you lose the manifest's inputs and the confirmation surface; the scripts and the runbook work
unchanged.
