# `@local/dsh-handoff` — the receiving end

The companion bundle for [`handoff-dsh`](../README.md). Open Design produces the
bundle; this is the half that lands it in **DeepSeek Harness**.

It exists because the two transports fail differently. The MCP transport cannot go
stale — the agent reads the project live — but it needs Open Design running. The
archive transport works anywhere, offline, on another machine, forever; the catch
is that an archive is an opaque file that arrives from somewhere else. This bundle
makes the archive transport trustworthy rather than merely convenient.

## Tools

| Tool | What it does |
|---|---|
| `handoff_inspect` | Verify an archive or an extracted bundle against the bundle contract. Writes nothing. |
| `handoff_import` | Verify, then extract every entry **verbatim** into a target directory. |
| `handoff_brief` | Surface the bundle's generated `README.md` — the instruction carrier — plus the entry file it names. |

### `handoff_inspect`

```
path     (required)  <Project>-handoff.zip · .tar.gz · or an extracted bundle directory
verdict  (optional)  the sender's .handoff/validate.json
```

Reports `ok`, `kind`, `root`, `fileCount`, `bytes`, `treeHash`, the gate list, and
the entry names. Gates:

| Gate | Invariant |
|---|---|
| no entry escapes the extraction root | — |
| no symlinks in the bundle | I9 |
| README is the instruction carrier | I6 |
| no unfilled README slots | — |
| root purity | I6 |
| `project/` is present and non-empty | I1 |
| no sync bookkeeping | I4 |
| no re-suffixed sources | I1 |
| design-system alias present | I3 |
| adherence config parses | I7 |
| sender verdict describes this bundle | *(only with `verdict`)* |
| tree digest matches the sender's verdict | I8 *(only with `verdict`)* |
| every file is byte-identical to the verdict | I8 *(only with `verdict`)* |

Passing `verdict` is what turns the last three on. The sender writes
`.handoff/validate.json` next to the archive, containing the digest of the exact
tree it validated; handing that file over proves the archive still holds those
bytes and not merely files with those names. Without it you still get `treeHash`,
which is the same digest, and you can compare it by hand.

### `handoff_import`

```
archive  (required)  the .zip or .tar.gz
into     (required)  target directory; the bundle root is created inside it
force    (optional)  extract even when the target is not empty
```

Refuses on any failed gate. Refuses an entry whose name is absolute, carries a
drive letter, contains a backslash, or walks out with `..`. Refuses to write into a
non-empty target unless `force` is true — and `force` replaces the bundle
directory it names, never the directory around it.

Nothing is renamed, re-suffixed or reformatted. `Button.jsx` stays `Button.jsx`.

### `handoff_brief`

```
path  (required)  the bundle directory or archive
```

Returns the README verbatim. That is the whole point: the bundle's reading order,
its "do not open these in a browser or take screenshots" rule and its "ask before
you build if anything is unclear" rule are the handoff, and a tool that hands them
over intact is worth more than one that summarises them.

## Why it does not reuse the sender's reader

The sender hashes a tree, writes an archive, and hands it over. If this side
verified that archive with the sender's own `scripts/_lib.js`, one implementation
would be vouching for itself — a bug in the ZIP writer and a matching bug in the
ZIP reader would agree, and the disagreement that should have caught it would never
happen.

So this reader is independent: it walks the ZIP end-of-central-directory record and
central directory itself, checks every local header, inflates and **verifies each
entry's CRC32**, and reads ustar/pax headers for the `.tar.gz` form. It also refuses
zip64 sentinels rather than verifying the wrong bytes, and refuses a `.zip` that is
not a ZIP at all — which is a real trap, because GNU `tar -a -c -f out.zip`
silently writes a tar with a `.zip` name.

Zero dependencies. No `node_modules`, no build step, no SDK.

## Install

Managed by the DeepSeek Harness plugin manager, which performs the package
installation and bundle selection:

```
plugin_manager install_bundle <this directory>
```

That is the whole install. To remove it, `plugin_manager remove_bundle
@local/dsh-handoff`.

## The second transport

`cordis.patch.yml` also ships the Open Design MCP server as a stdio client row,
under the id `od-mcp`. It is **disabled by default**: `od` is installed
with the Open Design desktop app and is usually not on PATH, and a row whose
command cannot be spawned fails activation. Once `od mcp` runs on this machine:

```
plugin_manager set_plugin od-mcp enabled:true
```

The server's tools then appear as `mcp__opendesign__*` (`get_project`,
`get_active_context`, `get_file`, `list_files`, `search_files`, …), which is the
same surface `scripts/hdd-prompt.js` names when it emits the MCP form of the
handoff prompt.

## Limits

- 20 000 entries and 512 MiB uncompressed, so a crafted archive cannot turn
  inspection into memory exhaustion. A real design bundle is far below both.
- `handoff_inspect` reports at most 400 entry names; `fileCount` is the true count.
- A directory bundle is walked, not hashed from a container, so it has no CRC to
  check — its `treeHash` is still comparable with the sender's verdict.

MIT, like the rest of the project.
