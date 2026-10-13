# Changelog

All notable changes to `handoff-dsh` are documented here.

The pipeline, the gate design, the in-process archive layer, the adherence generator and most of
`references/` derive from an earlier MIT-licensed handoff plugin, whose notice is reproduced in
[`NOTICE`](NOTICE). Entries below record what this implementation changed; everything it inherited
came across essentially intact.

## 0.1.0

A new package rather than a continuation, so the version does not pretend to extend the original's
lineage.

### Added

- **The receiving end** — `dsh/`, a zero-dependency DeepSeek Harness bundle with three Host tools:
  - `handoff_inspect` verifies a `<Project>-handoff.zip`, a `.tar.gz` or an already-extracted bundle
    against the bundle contract, and reports the tree digest. It reads the container itself — ZIP
    end-of-central-directory, central directory, local headers, and **every entry's CRC32** — rather
    than shelling out, and it reads ustar and pax headers for the gzipped form.
  - `handoff_import` re-verifies, then extracts every entry verbatim into a target directory.
  - `handoff_brief` surfaces the bundle's generated `README.md`, which is its sole instruction
    carrier, plus the entry file it names.
- **Receiver-side gates** for the invariants I1, I3, I4, I6, I7 and I9, plus three of its own: no
  entry escapes the extraction root, no symlinks, and no zip64 sentinel accepted in place of a real
  size. An entry name that is absolute, carries a drive letter, contains a backslash or climbs out
  with `..` is **refused and reported**, never sanitized — a receiver that quietly strips `../`
  reports a clean archive that tried to escape.
- **Digest binding in both directions.** Given the sender's `.handoff/validate.json`, the receiver
  recomputes the tree digest from the archive's own decoded bytes and requires it to match, file by
  file. The reader is a separate implementation on purpose: a verifier that shared the writer's code
  would agree with its bugs.
- The MCP form of the handoff prompt emits a ready-to-paste `@deepseek-ai/dsh-mcp-client` row, so a
  handoff can also be read live. The row is **not** shipped in a bundle: its endpoint is
  per-install (`OD_SIDECAR_CLIENT_ENDPOINT` is a named pipe carrying a GUID, and the app binds a
  fresh port every launch) and `serverName` must be unique across live mcp-client instances, so two
  bundles shipping one collide.
- `references/dsh-transport.md` is not needed: `SKILL.md`, `RUNBOOK.md`, `bundle-contract.md`,
  `mcp-contract.md` and `dsh/README.md` each cover the receiving side where it belongs.

### Changed

- `scripts/hdd-prompt.js` defaults to `--agent dsh`. Upstream, `--agent` was substituted into the
  single token `` `od mcp install ${agent}` ``. There is no `od mcp install dsh`, so for `dsh` the
  MCP form hands over the client row itself. Every other `--agent` value still emits the original
  sentence, which remains correct for the agents Open Design ships installers for.
- The zip prompt form, for `dsh` only, opens by naming `handoff_import` instead of telling the agent
  to unzip the archive itself.
- `package.json`, `open-design.json`, `SKILL.md`, `preview/index.html` and `icon.svg` retargeted;
  version `0.1.0`.
- `LICENSE` is the project's MIT license; the derived work's required notice lives in `NOTICE`.

### Fixed

- **The zip prompt named a file that did not exist.** Upstream derived the archive's basename twice:
  `hod-archive.js` sanitized the project's display name, while `hod-prompt.js`'s fallback used it
  raw. A project called `Design: v2` therefore produced an archive named `Design v2-handoff.zip` and
  a prompt naming `` `Design: v2-handoff.zip` ``. Both now derive through one exported helper,
  `archiveBase(name, slug)` in `scripts/_lib.js`, and `test/pipeline.test.js` asserts the prompt
  names the file phase 04 actually wrote.
- Three defects found by the new receiver tests, in the receiver: a top-level directory name failed
  its own root-purity gate (`project` was only accepted as `project/`); an entry whose name was
  rejected was dropped from the inspected tree, leaving the escape gate with nothing to report; and
  the brief's entry-file regex matched the `-project/` inside a slug like `fixture-project`, so it
  captured `project/Landing.dc.html` instead of `Landing.dc.html`.
