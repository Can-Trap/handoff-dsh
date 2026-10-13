# The Open Design surface that actually exists

Do not hunt for tools that are not here. Scripts in this plugin **never** call MCP — you fetch
facts and pass them in as flags.

## MCP tools

All **22** tools below were verified by handshaking with a running daemon over stdio:
`initialize` answers `{"name":"open-design","version":"0.2.0"}` and `tools/list` returns exactly this
set. Older revisions of this document listed 16 of them; the six marked ★ were added since.

| Tool | Params | Use in this plugin |
|---|---|---|
| `get_active_context` | none | **the entry file.** Returns the active project and file; expires ~5 min after the last interaction. Answers `{active:false, hint}` rather than failing |
| `get_project` | `project?` | display name, `resolvedDir` -> `--project-name`, `--project-dir` |
| `list_projects` | none | when the user names a project you must resolve |
| `list_files` | `project?`, `since?` | name, path, mime, kind, size, mtime |
| `get_file` | `path`, `project?` | up to 2000 lines from `offset`; pages via a `[od:file-window]` marker |
| `get_artifact` | `entry?`, `include?`, `maxBytes?` | entry plus referenced siblings, depth 3, 200-file cap |
| `search_files` | `query` | find a class or copy string without fetching everything |
| `write_file` | `path`, `content`, `encoding?` | unconditional overwrite |
| `create_artifact` | `name`, `content`, `artifactManifest?` | rejects existing targets |
| `delete_file` | `path` | one file |
| `start_run` / `get_run` / `cancel_run` | `plugin`, `inputs`, `project?`, `agent?` | how a plugin workflow is invoked from an agent |
| `list_plugins` / `list_skills` / `list_agents` | none | discovery |
| ★ `collect_brief` | `artifactType`, `projectTitle?`, … | open the interactive brief card; needs a UI, so a headless handoff should pass `skip` or pre-supplied answers |
| ★ `confirm_brief` | brief draft + `answers` | returns the readable brief to reuse; the draft id and nonce are internal widget data, never user-facing copy |
| ★ `create_project` | `name`, `designSystem?`, `skill?` | create an empty project to generate into — the counterpart of `get_project` when a handoff targets somewhere new |
| ★ `delete_project` | explicit `project` **and** `confirm: true` | irreversible, and there is deliberately no active-project fallback |
| ★ `start_vela_login` / `get_vela_login_status` | none | OpenDesign Cloud browser sign-in; exposes no credentials |

**Client resources, not tools.** A connected client also sees the daemon's resource catalogue:
`ui://open-design/artifact-card-v8.html` (the brief card), `od://focus/active` (the same active
context as JSON), `od://skills/<id>/SKILL.md` and `od://design-systems/<id>/DESIGN.md`. The last is
the design-system pull layer this plugin's `--design-system` work reads.

**Does not exist:** `render_preview`, etags / `if_match`, a project ZIP export route, a
`write_files` batch on this surface. That batch write belongs to a *different* optional server
("DesignSync MCP"); do not look for it here.

## CLI

The `od` binary ships with the desktop app and is usually **not on PATH**. Working invocation:

```bash
ELECTRON_RUN_AS_NODE=1 "<install>/Open Design.exe" \
  "<install>/resources/app/prebundled/daemon/daemon-cli.mjs" <args>
```

On macOS and WSL2, `/usr/bin/od` (octal dump) shadows it — the README warns about this three times.

```bash
od project info <id> --json          # -> .cwd, the project directory on disk
od files list|read|write|upload|delete|diff <projectId> [path]
od mcp install <agent>               # claude codex cursor opencode pi copilot cline kiro trae …
```

`od files` is the recommended path for a code agent targeting an OD-managed project, because the
daemon owns artifact bookkeeping.

**`dsh` is not on that `od mcp install` list, and `od mcp install dsh` does not exist.** DeepSeek
Harness — this plugin's default receiving end — accepts any stdio server as a
`@deepseek-ai/dsh-mcp-client` bundle row, so `hdd-prompt.js --agent dsh` hands over the row itself
rather than a command that would fail.

That row is **machine-specific and ships in no bundle**, because two facts about it cannot be made
portable: `od` is not on PATH (the real server is the Open Design desktop app's own binary running
`daemon-cli.mjs` with `ELECTRON_RUN_AS_NODE=1`), and `od mcp` refuses to start without either
`OD_SIDECAR_CLIENT_ENDPOINT` — a named pipe carrying a per-install GUID — or an explicit
`--daemon-url`, since the app binds a fresh port on every launch. It also carries `serverName:
opendesign`, which must be unique across live mcp-client instances. So it lives in the receiving
machine's profile patch; `hdd-prompt.js` emits it ready to paste. Every other `--agent` value still
emits the upstream `od mcp install <agent>` sentence.

## Export

```
/api/projects/:id/export/{pdf,pdf-image,image,pptx,manifest}
od export <file> --project <id> --format pdf|image|pptx [--out <path>]
```

**`zip` is not an accepted format and no `export/zip` route exists.** That is why this plugin
writes the archive into the project cwd itself with `fs:write` + `bash`, and why the confirmation
surface has to name the path — the browser will not hand the user a download. Preview iframes run
`sandbox="allow-scripts"` **without** `allow-downloads`, so a preview page cannot start one either.

## Atoms — a CLOSED catalog

`od.pipeline.stages[].atoms[]` must resolve against these thirteen. Plugin authors cannot register
a new one; ship new capability as an MCP tool attached to the nearest generic atom.

```
build-test  code-import  critique-theater  design-extract  diff-review
direction-picker  discovery-question-form  figma-extract  handoff
patch-edit  rewrite-plan  todo-write  token-map
```

This plugin uses `design-extract`, `token-map`, `todo-write`, `diff-review`, `handoff`.
`hdd-validate.js --self` checks every atom reference against this list, because a typo fails at
install time rather than at author time.

Note the shipped `export-nextjs-handoff` example uses `file-read` / `file-write`, which are **not**
in the catalog. Treat that example as stale; `od plugin doctor` arbitrates.

`until` signals are closed too: `critique.score`, `iterations`, `user.confirmed`, `preview.ok`,
`build.passing`, `tests.passing`.

## GenUI — a closed vocabulary

Surface kinds are `form`, `choice`, `confirmation`, `oauth-prompt`. Nothing else.

> The product rule: **agent/plugin output is data; OD owns the renderer.**

A plugin cannot add a button to the toolbar, project header or file menu. What it gets is a card in
the **inline plugins rail** under the composer — on Home and inside every project — whose **Use**
action applies the plugin in place. That card is the button.

## The handoff atom

First-party, `mode: handoff`, and its surface table already names ours:

| surface | follow-on |
|---|---|
| `code-agent` | hand off to Cursor / Claude Code / Codex sitting on top of the project cwd |

`ArtifactManifest.exportTargets[].surface` accepts `cli`, `desktop`, `web`, `docker`, `github`,
`figma`, `code-agent`. Exports append — the distribution trail is additive, never replaced.
