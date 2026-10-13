#!/usr/bin/env node
// Phase 01 — bundle. Builds `<slug>/` : the generated README plus a verbatim mirror
// of the project. Deterministic; no model tokens are spent here.
//
//   node scripts/hdd-bundle.js [--out <dir>] [--force]
//
// DONE-gate: every README slot filled, project mirrored verbatim, design system and
//            its alias present, adherence config emitted when a DS is bound.
import { existsSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  args, die, readState, readJson, writeJson, writeText, copyTree, walk,
  childDir, isUnder, symlinkScan, describeUnsafe, featureDirName, TODO_MARKER,
  clearVerdict, Gates, posix, NEVER_SHIP, SYNC_BOOKKEEPING,
} from "./_lib.js";
import { buildAdherence, collectComponents } from "./_adherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const a = args();
const outRoot = a.out ?? process.cwd();
const state = readState(outRoot);
if (!state) die("no .handoff/state.json — run hdd-detect.js first");

const { project, entry, designSystem, options } = state;
const depth = a.depth ?? options.depth ?? "both";

if (depth === "spec") {
  die(`depth=spec — phase 01 does not run at this depth. The deliverable is\n` +
    `  ${project.dir}/${options.feature ? featureDirName(options.feature) : "design_handoff_<feature>"}/ alone.\n` +
    `  Re-run phase 00 with --depth both to nest that spec inside a bundle.`);
}

/* ── depth=both nests mechanism B inside mechanism A ────────────────────────
 * The mirror below is a single verbatim snapshot and no later phase refreshes it,
 * so the authored spec has to exist in the SOURCE project before it is taken.
 * Building 01 before 02 yields a bundle that silently lacks the spec: the archive
 * is produced, every gate passes, and the advertised deliverable is simply absent.
 * Enforced here rather than left to the runbook — ordering that is documented but
 * unchecked is exactly how it went wrong. */

if (depth === "both" && options.feature) {
  const specReadme = join(project.dir, featureDirName(options.feature), "README.md");
  const remedy =
    `  Run phase 02 first, author the spec over its TODO markers, then re-run this phase:\n` +
    `    node scripts/hdd-spec.js --feature ${JSON.stringify(options.feature)} --out ${outRoot}\n` +
    `  Or re-run phase 00 with --depth bundle if the spec is not part of this handoff.`;

  if (!existsSync(specReadme)) {
    die(`depth=both requires the authored spec to exist before the mirror is taken.\n` +
      `  Missing: ${specReadme}\n${remedy}`);
  }
  if (TODO_MARKER.test(readFileSync(specReadme, "utf8"))) {
    die(`depth=both requires the spec to be AUTHORED, not scaffolded.\n` +
      `  ${specReadme} still carries TODO markers, and a bundle must not ship a skeleton.\n${remedy}`);
  }
}

// `--force` below is a recursive delete: resolve the target through the guard so a
// slug that is empty, `.`, absolute, or climbs out of outRoot can never name it.
const bundleRoot = childDir(outRoot, project.slug, "project slug");

// I9 — re-checked here rather than trusted from phase 00: the project can change
// between phases, and `state.json` is on disk and hand-editable.
//
// This runs BEFORE the `--force` delete below, not after. Refusing once the old
// bundle is already gone would cost the user a good bundle and hand back nothing.
const links = symlinkScan(project.dir, { exclude: NEVER_SHIP });
if (links.unsafe.length) {
  die(`I9 — refusing to mirror ${links.unsafe.length} symlink(s):\n${describeUnsafe(links.unsafe)}\n` +
    `  Following these would copy files from outside the project into the bundle, or abort the\n` +
    `  mirror on a directory link. Remove them, or replace them with real copies inside the\n` +
    `  project, then re-run phase 01. Nothing has been written or deleted.`);
}

/* Every refusal above this line leaves the workspace untouched. From here on the
 * bundle changes, so the phase-03 verdict describing the old one has to go first —
 * `--force` used to replace the whole tree while validate.json survived, and phase 04
 * accepted it. Clearing is the half of the guarantee that does not depend on anyone
 * recomputing a digest; the digest is the half that survives a stray hand-edit. */
const dropped = clearVerdict(outRoot);

if (existsSync(bundleRoot)) {
  if (!a.force) die(`${project.slug}/ already exists — pass --force to rebuild`);
  rmSync(bundleRoot, { recursive: true, force: true });
}
mkdirSync(bundleRoot, { recursive: true });

/* ── 1. verbatim mirror (I1: never rename, never re-suffix, never reformat) ─ */

const mirrored = copyTree(project.dir, join(bundleRoot, "project"), { exclude: NEVER_SHIP });

/* ── 1b. the conversation transcript ────────────────────────────────────────
 * `includeChats` used to add a `chats/` line to the README and permit `chats` at
 * bundle root — while nothing ever created the directory. The README promised a
 * path the bundle did not contain.
 *
 * Transcripts are not on disk in the project (they live in the daemon) and these
 * scripts never call MCP, so the agent exports them and passes the directory in.
 * That explicit hand-off is also why this is not an I9 violation: the operator
 * named the path, the walker did not discover it. */

let chats = 0;
if (options.includeChats) {
  if (!options.chatsDir) {
    die(`includeChats is on but no transcript directory was given.\n` +
      `  Export the conversation from Open Design, then re-run phase 00 with\n` +
      `    --include-chats true --chats-dir "<dir>"\n` +
      `  or with --include-chats false. A README that names \`${project.slug}/chats/\` must not\n` +
      `  ship over a bundle that has no such directory.`);
  }
  if (!existsSync(options.chatsDir)) die(`--chats-dir no longer exists: ${options.chatsDir}`);
  chats = copyTree(options.chatsDir, join(bundleRoot, "chats"), { exclude: NEVER_SHIP }).length;
  if (!chats) die(`--chats-dir is empty: ${options.chatsDir}`);
}

/* ── 2. adherence config ───────────────────────────────────────────────────
 * Present in the source? Keep it byte-for-byte — the mirror is authoritative.
 * Absent but a design system is bound? Generate it (§3.6). */

let adherence = { action: "none", path: null, rules: 0 };
if (designSystem) {
  // Also from state.json, and it is both read from and written to — so it gets the
  // same treatment as the slug rather than being trusted because detect produced it.
  if (!isUnder(project.dir, designSystem.dir)) {
    die(`I9 — designSystem.dir "${designSystem.dir}" resolves outside the project`);
  }
  const dsIn = join(project.dir, designSystem.dir);
  const dsOut = join(bundleRoot, "project", designSystem.dir === "." ? "" : designSystem.dir);
  const target = join(dsOut, "_adherence.oxlintrc.json");
  const manifest = readJson(join(dsIn, "_ds_manifest.json"));

  if (existsSync(target)) {
    adherence = { action: "mirrored", path: posix(designSystem.dir), rules: 0 };
  } else if (manifest) {
    const components = collectComponents(manifest, dsIn);
    const config = buildAdherence(manifest, dsIn, { components });
    writeJson(target, config);
    adherence = {
      action: "generated",
      path: posix(designSystem.dir),
      rules: config.rules["no-restricted-syntax"].length - 1,
      components: components.length,
    };
  }
}

/* ── 3. README ─────────────────────────────────────────────────────────────── */

const FORM1 = (slug, file) =>
  `**Read \`${slug}/project/${file}\` from top to bottom.** That file was open when the handoff was ` +
  `triggered, so it is almost certainly the design you are being asked to build. Read all of it — ` +
  `skimming will cost you. Then **walk its imports**: open every file it references (shared ` +
  `components, stylesheets, scripts) until you understand how the pieces fit together, and only ` +
  `then start implementing.`;

const FORM2 = (slug) =>
  `**Find the primary design file under \`${slug}/project/\` and read it from top to bottom.** ` +
  `Then **walk its imports**: open every file it references (shared components, stylesheets, ` +
  `scripts) until you understand how the pieces fit together, and only then start implementing.`;

const CHATS = (slug) =>
  `**Read \`${slug}/chats/\` first.** The intent lives in the conversation; the files are only what ` +
  `that intent produced.\n\n`;

const dsBlock = () => {
  if (!designSystem) return "";
  const dir = designSystem.dir === "." ? `${project.slug}/project/` : `${project.slug}/project/${designSystem.dir}/`;
  const lint = adherence.action === "none" ? "" :
    `\n\`_adherence.oxlintrc.json\` is an oxlint config that enforces design-system adherence in **your** ` +
    `codebase. It flags raw hex, raw \`px\`, fonts the system does not provide, imports that reach into ` +
    `component internals, and props a component does not declare. Wire it in and fidelity stops being a ` +
    `matter of opinion.\n`;
  return `\n## Design system\n\n\`${dir}\` carries the complete design system — tokens, component sources` +
    `${designSystem.hasFontBinaries ? ", and real font binaries" : ""}. ` +
    `The bundle is offline-complete: nothing here needs the network to render.\n${lint}`;
};

const contents = [
  `- \`${project.slug}/README.md\` — this file`,
  options.rootPointers && `- \`${project.slug}/AGENTS.md\` — harness-neutral entry point, points here`,
  options.rootPointers && `- \`${project.slug}/CLAUDE.md\` — pointer, for agents that read it`,
  options.includeChats && `- \`${project.slug}/chats/\` — the conversation that produced the design`,
  `- \`${project.slug}/project/\` — the \`${project.name}\` project files (HTML prototypes, assets, components)`,
].filter(Boolean).join("\n");

const template = readFileSync(join(HERE, "..", "references", "readme-template.md"), "utf8");
const readme = template
  .replace("{{ENTRY_DIRECTIVE}}",
    (options.includeChats ? CHATS(project.slug) : "") +
    (entry.mode === "form1" ? FORM1(project.slug, entry.file) : FORM2(project.slug)))
  .replace("{{DESIGN_SYSTEM}}", dsBlock())
  .replace("{{CONTENTS}}", contents);

writeText(join(bundleRoot, "README.md"), readme);

/* ── 4. root pointers (our only divergence from strict root purity) ───────── */

if (options.rootPointers) {
  writeText(join(bundleRoot, "AGENTS.md"),
    `# Agent instructions\n\nRead [\`README.md\`](./README.md) in this directory and follow it exactly. ` +
    `It is the single source of truth for this handoff.\n\nThe design files live in \`project/\`.\n\n` +
    `This bundle came out of Open Design. Once the implementation runs, the codebase can be synced ` +
    `back with \`@ross-sec/sync-od\`, closing the round trip.\n`);
  writeText(join(bundleRoot, "CLAUDE.md"),
    `See [\`AGENTS.md\`](./AGENTS.md).\n`);
}

/* ── 5. state ──────────────────────────────────────────────────────────────── */

const bundleFiles = walk(bundleRoot);
writeJson(join(outRoot, ".handoff", "bundle.json"), {
  builtAt: new Date().toISOString(),
  root: project.slug,
  mirrored: mirrored.length,
  total: bundleFiles.length,
  adherence,
  readmeForm: entry.mode,
});

/* ── gates ─────────────────────────────────────────────────────────────────── */

const g = new Gates("01 bundle");
g.check("no unfilled README slots", !/\{\{[A-Z_]+\}\}/.test(readme),
  (readme.match(/\{\{[A-Z_]+\}\}/g) ?? []).join(" "));
/* Counted against the source AS IT IS NOW, not against the detect-time snapshot.
 * "Verbatim" means the mirror equals the source at the moment it was taken, and at
 * depth=both the source legitimately grows between phases — phase 02 writes the spec
 * folder into it. Comparing to the stale number failed a correct bundle. A genuine
 * copy failure still fails, because both numbers come from the same walk policy. */
const sourceNow = walk(project.dir, { exclude: NEVER_SHIP }).length;
g.check("project mirrored verbatim", mirrored.length === sourceNow,
  `${mirrored.length}/${sourceNow} files` +
  (sourceNow === project.fileCount ? "" : ` (${project.fileCount} at detect; source grew by ${sourceNow - project.fileCount})`));
g.check("no re-suffixed sources", !bundleFiles.some((f) => /\.(jsx|d\.ts)\.txt$/i.test(f)), "I1");
g.check("no sync bookkeeping", !bundleFiles.some((f) => SYNC_BOOKKEEPING.test(f)), "I4 — _ds_sync.json / _ods_sync.json / _ods_needs_recompile");
g.check("no symlink escapes the project — I9", true,
  links.followed.length
    ? `${links.followed.length} internal link(s) materialized as their target's content`
    : "no symlinks");

// The advertised deliverable of depth=both, asserted in the built tree rather than
// assumed from the fact that phase 02 was run at some point.
if (depth === "both" && options.feature) {
  const specPrefix = `project/${featureDirName(options.feature)}/`;
  const specFiles = bundleFiles.filter((f) => f.startsWith(specPrefix));
  g.check("authored spec nested in the mirror", specFiles.some((f) => f.endsWith("/README.md")),
    specFiles.length ? `${specPrefix} — ${specFiles.length} file(s)` : `${specPrefix} missing`);
}
if (options.includeChats) {
  g.check("conversation transcript included", chats > 0, `chats/ — ${chats} file(s)`);
}
g.check("stale phase-03 verdict cleared — I8", !existsSync(join(outRoot, ".handoff", "validate.json")),
  dropped.length ? `dropped ${dropped.join(", ")} — run phase 03 again` : "none to clear");

if (designSystem) {
  const dsPrefix = designSystem.dir === "." ? "project/" : `project/${designSystem.dir}/`;
  g.check("design system materialized", bundleFiles.some((f) => f.startsWith(dsPrefix)), dsPrefix);
  if (designSystem.aliases.length) {
    g.check("design-system alias present",
      designSystem.aliases.every((al) => bundleFiles.some((f) => f.startsWith(`project/${al}/`))),
      `I3 — ${designSystem.aliases.join(", ")}`);
  }
  g.check("adherence config present", adherence.action !== "none",
    `${adherence.action}${adherence.rules ? ` (${adherence.rules} rules, ${adherence.components} components)` : ""}`);
}

const rootEntries = new Set(bundleFiles.map((f) => f.split("/")[0]));
const permitted = new Set(["README.md", "project", ...(options.rootPointers ? ["AGENTS.md", "CLAUDE.md"] : []), ...(options.includeChats ? ["chats"] : [])]);
g.check("root purity", [...rootEntries].every((e) => permitted.has(e)),
  [...rootEntries].filter((e) => !permitted.has(e)).join(", ") || [...rootEntries].sort().join(" + "));

g.finish();
