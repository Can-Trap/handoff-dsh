#!/usr/bin/env node
// Emit the handoff PROMPT — the primary transport. The live product defaults to a
// copyable prompt that points the agent at the design MCP and pulls files live;
// the archive is the fallback behind an overflow menu. We mirror that, retargeted
// to Open Design's own MCP.
//
//   node scripts/hdd-prompt.js [--out <dir>] [--transport mcp|zip|both] [--instructions "…"]
//                              [--focus "a.html,b.css"] [--agent dsh|claude|codex|…]
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, normalize, basename } from "node:path";
import { args, die, readState, readJson, writeText, isUnder, posix, archiveBase } from "./_lib.js";

const a = args();
const outRoot = a.out ?? process.cwd();
const state = readState(outRoot);
if (!state) die("no .handoff/state.json — run hdd-detect.js first");

const { project, entry, options } = state;
const transport = a.transport ?? options.transport ?? "zip";
const instructions = typeof a.instructions === "string" ? a.instructions.trim() : "";
// DeepSeek Harness is the default receiving end — this plugin is the return leg of
// @ross-sec/sync-od. Any other `od mcp install` target still works: claude, codex,
// cursor, pi…
const agent = a.agent ?? "dsh";

/* ── focus set ──────────────────────────────────────────────────────────────
 * Selection shapes the PROMPT only. The archive is always the whole project —
 * that asymmetry is deliberate and matches the original. */

const focus = typeof a.focus === "string"
  ? a.focus.split(",").map((s) => s.trim()).filter(Boolean)
  : (entry.file ? [entry.file] : []);

// I9 — the prompt names files for the agent to open. A focus path that leaves the
// project would point it at something the bundle does not contain.
const strayFocus = focus.filter((f) => !isUnder(project.dir, f));
if (strayFocus.length) {
  die(`I9 — --focus must stay inside the project:\n${strayFocus.map((f) => `  ${f}`).join("\n")}\n` +
    `  Paths are relative to ${project.dir}.`);
}

/* ── import discovery ───────────────────────────────────────────────────────
 * Scan the focused HTML for the resources it pulls in, so the receiving agent is
 * told to read them too. Remote URLs are skipped — they are not ours to read. */

const REFS = [
  /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
  /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi,
  /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
  /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
  /<x-import\b[^>]*\bfrom\s*=\s*["']([^"']+)["']/gi,
  /@import\s+(?:url\(\s*)?["']([^"')]+)["']/gi,
];

function discoverImports(files) {
  const found = new Set();
  for (const rel of files) {
    if (!/\.(html?|css)$/i.test(rel)) continue;
    const abs = join(project.dir, rel);
    if (!existsSync(abs)) continue;
    let src = "";
    try { src = readFileSync(abs, "utf8"); } catch { continue; }
    for (const rx of REFS) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(src))) {
        const raw = m[1].trim();
        if (!raw || /^(?:https?:)?\/\//i.test(raw) || /^(data|mailto|tel|#)/i.test(raw)) continue;
        const resolved = posix(normalize(join(dirname(rel), raw.split(/[?#]/)[0])));
        if (resolved.startsWith("..") || files.includes(resolved)) continue;
        // The lexical check above misses a reference that leaves the project
        // through a symlink — I9 applies to what the agent is TOLD to read, too.
        if (existsSync(join(project.dir, resolved)) && isUnder(project.dir, resolved)) found.add(resolved);
      }
    }
  }
  return [...found].sort();
}

const imports = focus.length ? discoverImports(focus) : [];
const bullets = (xs) => xs.map((f) => `- \`${f}\``).join("\n");
const target = instructions || (focus.length === 1 ? `\`${focus[0]}\`` : "the selected files");

/* ── how the receiving agent gets the Open Design MCP server ──────────────────
 * Upstream this was one substring: `od mcp install <agent>`. That covers every
 * agent Open Design ships an installer for, and DeepSeek Harness is not one of
 * them — `od mcp install dsh` does not exist. So for `dsh` the prompt hands over
 * the client row itself.
 *
 * The row is machine-specific and therefore lives in the receiving machine's own
 * profile patch, not in any bundle: `od` is NOT on PATH (the real server is the
 * desktop app's binary with ELECTRON_RUN_AS_NODE=1), and `od mcp` refuses to start
 * without either the sidecar pipe or an explicit --daemon-url, because the app
 * binds a fresh port on every launch. */

const DSH_REGISTRATION =
  "`od mcp` speaks MCP over stdio, and DeepSeek Harness accepts any stdio server as one\n" +
  "`@deepseek-ai/dsh-mcp-client` row — there is no `od mcp install dsh`. Add the row to the\n" +
  "receiving machine's profile patch; it carries a per-install endpoint, so no bundle ships it:\n" +
  "\n" +
  "    - id: opendesign-mcp\n" +
  "      name: '@deepseek-ai/dsh-mcp-client'\n" +
  "      config:\n" +
  "        serverName: opendesign\n" +
  "        transport: stdio\n" +
  "        command: '<LOCALAPPDATA>\\Programs\\Open Design\\Open Design.exe'\n" +
  "        args:\n" +
  "          - '<LOCALAPPDATA>\\Programs\\Open Design\\resources\\app\\prebundled\\daemon\\daemon-cli.mjs'\n" +
  "          - 'mcp'\n" +
  "        env:\n" +
  "          ELECTRON_RUN_AS_NODE: '1'\n" +
  "          OD_DATA_DIR: '<APPDATA>\\Open Design\\namespaces\\<namespace>\\data'\n" +
  "          OD_SIDECAR_CLIENT_ENDPOINT: '\\\\.\\pipe\\open-design-sidecar-<guid>'\n" +
  "          OD_MCP_BOOTSTRAP_COMMAND: '<LOCALAPPDATA>\\Programs\\Open Design\\Open Design.exe'\n" +
  "          OD_MCP_BOOTSTRAP_ARGS: '[\"--headless\"]'\n" +
  "        failOnStartupError: true\n" +
  "\n" +
  "`od` is not on PATH — that binary is the desktop app's. Take `<namespace>` and `<guid>` from\n" +
  "the registration Open Design writes for VS Code.\n";

/* ── prompt forms ───────────────────────────────────────────────────────────── */

const ROUND_TRIP =
  `\nWhen the implementation is running, changes can be synced back to Open Design with ` +
  `\`@ross-sec/sync-od\` — the return leg of this handoff.\n`;

if (!["mcp", "zip", "both"].includes(transport)) {
  die(`unknown --transport "${transport}" — expected mcp, zip or both`);
}

const mcpPrompt = () =>
  `Use the Open Design MCP server to read this project live:\n` +
  `${project.name}\n\n` +
  (agent === "dsh"
    ? DSH_REGISTRATION + "\n"
    : `Install the server into ${agent} with \`od mcp install ${agent}\`.\n\n`) +
  (focus.length ? `Focus on these files (the whole project is readable):\n${bullets(focus)}\n\n` : "") +
  (imports.length ? `Also read these files the selection imports:\n${bullets(imports)}\n\n` : "") +
  `Implement: ${target}\n` + ROUND_TRIP;

const zipPrompt = () => {
  // Bare filename, not the absolute path it happens to sit at here — the prompt is
  // pasted into an agent that may be on another machine entirely. Derived through
  // the same helper phase 04 names the file with, so the two cannot disagree.
  const archiveMeta = readJson(join(outRoot, ".handoff", "archive.json"));
  const zip = basename(
    archiveMeta?.written?.find((w) => w.format === "zip")?.path ??
    `${archiveBase(project.name, project.slug)}-handoff.zip`,
  );
  // For `dsh` the opener names the receiving tool, because the archive is the one
  // transport where the receiving side can be made to verify before it trusts.
  const opener = agent === "dsh"
    ? `Import \`${zip}\` with the \`handoff_import\` tool (companion bundle, \`dsh/\`) — it ` +
      `re-verifies the archive and extracts it verbatim — or unzip it yourself.\n` +
      `Then read \`${project.slug}/README.md\` in full and follow it.\n\n`
    : `Unzip \`${zip}\` into your repo, then read \`${project.slug}/README.md\` in full and follow it.\n\n`;
  return opener +
    (focus.length ? `Focus on these files (the whole project is in the bundle):\n${bullets(focus)}\n\n` : "") +
    (imports.length ? `Also read these files the selection imports:\n${bullets(imports)}\n\n` : "") +
    `Implement: ${target}\n` + ROUND_TRIP;
};

// `both` is a declared transport, and it used to fall through to the zip branch —
// emitting one prompt while the manifest advertised a choice of two. It now emits
// both, labelled, so the user can pick the one their agent can actually use.
const prompt =
  transport === "mcp" ? mcpPrompt() :
  transport === "zip" ? zipPrompt() :
  `## Option A — read it live over MCP (nothing to unpack, never stale)\n\n${mcpPrompt()}\n` +
  `\n## Option B — from the archive (for an agent elsewhere or offline)\n\n${zipPrompt()}`;

writeText(join(outRoot, ".handoff", "prompt.txt"), prompt);
console.log(prompt);
console.error(`[prompt] transport=${transport} agent=${agent} focus=${focus.length} imports=${imports.length} -> .handoff/prompt.txt`);
