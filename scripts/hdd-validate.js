#!/usr/bin/env node
// Phase 03 — validate. The gate between a built bundle and an archive. Nothing
// ships until this exits 0.
//
//   node scripts/hdd-validate.js [--out <dir>] [--spec <feature-slug>] [--self]
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  args, die, readState, readJson, writeJson, walk, childDir, symlinkScan, describeUnsafe,
  featureDirName, TODO_MARKER, hashTree, Gates, TEXTUAL, SYNC_BOOKKEEPING,
} from "./_lib.js";
import { verifyAdherence } from "./_adherence.js";

const a = args();
const outRoot = a.out ?? process.cwd();

/* `--self` is the packaging smoke test: the plugin's own files are coherent. */
if (a.self) {
  const here = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const g = new Gates("self-check");
  const manifest = readJson(join(here, "open-design.json"));
  const pkg = readJson(join(here, "package.json"));
  g.check("open-design.json parses", !!manifest);
  g.check("specVersion is 1.0.0", manifest?.specVersion === "1.0.0", manifest?.specVersion);
  g.check("name matches ^[a-z0-9][a-z0-9._-]*$", /^[a-z0-9][a-z0-9._-]*$/.test(manifest?.name ?? ""), manifest?.name);
  g.check("manifest and package versions agree", manifest?.version === pkg?.version,
    `${manifest?.version} vs ${pkg?.version}`);
  const skill = existsSync(join(here, "SKILL.md")) ? readFileSync(join(here, "SKILL.md"), "utf8") : "";
  g.check("SKILL.md has frontmatter name+description", /^---[\s\S]*?\bname:\s*\S/.test(skill) && /\bdescription:\s*\S/.test(skill));
  g.check("SKILL.md name matches manifest", new RegExp(`^name:\\s*${manifest?.name}\\s*$`, "m").test(skill));
  // The atom catalog is CLOSED — a typo here fails at install, not at author time.
  const ATOMS = new Set(["build-test", "code-import", "critique-theater", "design-extract", "diff-review",
    "direction-picker", "discovery-question-form", "figma-extract", "handoff", "patch-edit",
    "rewrite-plan", "todo-write", "token-map"]);
  const used = [
    ...(manifest?.od?.context?.atoms ?? []),
    ...(manifest?.od?.pipeline?.stages ?? []).flatMap((s) => s.atoms ?? []),
  ];
  g.check("every atom is in the closed catalog", used.every((x) => ATOMS.has(x)),
    used.filter((x) => !ATOMS.has(x)).join(", ") || `${used.length} refs ok`);
  const KINDS = new Set(["form", "choice", "confirmation", "oauth-prompt"]);
  g.check("genui kinds are in the closed vocabulary",
    (manifest?.od?.genui?.surfaces ?? []).every((s) => KINDS.has(s.kind)));
  g.check("no @open-design/* dependency", !JSON.stringify(pkg?.dependencies ?? {}).includes("@open-design"),
    "none publish to npm");

  /* I10 — an advertised option is a promise. `depth` shipped for three releases as a
   * declared input that phase 00 wrote into state and NOTHING ever read, so
   * `depth=both` produced a bundle silently missing the spec it advertises. This gate
   * makes that class structurally impossible: every input in the manifest must be read
   * back as `options.<name>`, which is the single place a declared option becomes
   * behaviour. Adding an input without wiring it now fails the packaging check. */
  const inputs = (manifest?.od?.inputs ?? manifest?.inputs ?? []).map((i) => i.name);
  const scriptSrc = readdirSync(join(here, "scripts"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(here, "scripts", f), "utf8"))
    .join("\n");
  const unread = inputs.filter((n) => !new RegExp(`options\\.${n}\\b`).test(scriptSrc));
  g.check("every declared input is consumed — I10", inputs.length > 0 && unread.length === 0,
    unread.length ? `declared but never read: ${unread.join(", ")}` : `${inputs.length} inputs, all read`);

  g.finish();
  process.exit(0);
}

const state = readState(outRoot);
if (!state) die("no .handoff/state.json — run hdd-detect.js first");
const { project, designSystem, options } = state;

/* ── spec mode (Mechanism B) ───────────────────────────────────────────────── */

if (a.spec) {
  // `--spec` with no value means "the feature this run is about". That is the
  // feature's SLUG on disk, not its display string: `--spec` alone used to build
  // `design_handoff_Landing Page` and report the folder missing.
  if (a.spec === true && !options.feature) {
    die(`--spec needs a feature: pass --spec <slug>, or re-run phase 00 with --feature "<scope>"`);
  }
  const dirName = a.spec === true ? featureDirName(options.feature) : `design_handoff_${a.spec}`;
  const slug = dirName.replace(/^design_handoff_/, "");
  const dir = join(project.dir, dirName);
  if (!existsSync(dir)) die(`no ${dirName}/ — run hdd-spec.js first`);
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  const heads = [...readme.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1].toLowerCase());

  const REQUIRED = ["about the design files", "fidelity", "assets", "files"];
  const g = new Gates(`03 validate --spec ${slug}`);

  g.check("title is a handoff title", /^#\s+Handoff:\s+\S/.test(readme), readme.split("\n")[0]);
  for (const need of REQUIRED) {
    g.check(`section "${need}"`, heads.some((h) => h.startsWith(need)));
  }
  // Order matters: fidelity always precedes the scope body, files always last.
  const idx = (needle) => heads.findIndex((h) => h.startsWith(needle));
  g.check("fidelity precedes assets", idx("fidelity") < idx("assets"), `${idx("fidelity")} < ${idx("assets")}`);
  g.check("files is the last required section", idx("files") === Math.max(...REQUIRED.map(idx)));
  g.check("no TODO markers left", !/\bTODO\b/.test(readme),
    (readme.match(/^.*\bTODO\b.*$/gm) ?? []).slice(0, 3).join(" | "));
  g.check("prototypes/ has design references", existsSync(join(dir, "prototypes")) &&
    walk(join(dir, "prototypes")).length > 0);
  g.check("states that HTML is a reference, not the artifact",
    /\b(reference|prototype)s?\b/i.test(readme.slice(0, 4000)));
  g.finish();
  process.exit(0);
}

/* ── bundle mode (Mechanism A) ─────────────────────────────────────────────── */

const bundleRoot = childDir(outRoot, project.slug, "project slug");
if (!existsSync(bundleRoot)) die(`no ${project.slug}/ — run hdd-bundle.js first`);
const files = walk(bundleRoot);

// I2 — offline-complete. Only RESOURCE references count: a remote <a href> is
// fine, a remote <script src> or @font-face is not.
const REMOTE_RESOURCE = [
  /<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i,
  /<link\b[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\//i,
  /<iframe\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i,
  /@import\s+(?:url\(\s*)?["']?(?:https?:)?\/\//i,
  /\burl\(\s*["']?(?:https?:)?\/\//i,
];
const remoteHits = [];
for (const rel of files) {
  if (!TEXTUAL.test(rel)) continue;
  let src = "";
  try { src = readFileSync(join(bundleRoot, rel), "utf8"); } catch { continue; }
  for (const rx of REMOTE_RESOURCE) {
    const m = rx.exec(src);
    if (m) { remoteHits.push(`${rel}: ${m[0].slice(0, 70)}`); break; }
  }
}

const readme = readFileSync(join(bundleRoot, "README.md"), "utf8");
const rootEntries = [...new Set(files.map((f) => f.split("/")[0]))];
const permitted = new Set(["README.md", "project",
  ...(options.rootPointers ? ["AGENTS.md", "CLAUDE.md"] : []),
  ...(options.includeChats ? ["chats"] : [])]);

const g = new Gates("03 validate", { strict: !!a.strict });
// Advisory, not a gate: the mirror is verbatim (I1), so a project whose design
// system @imports a remote font produces a bundle that needs the network. That is
// the source's property, not our defect. `--strict` refuses to ship it anyway.
g.warn("offline-complete", remoteHits.length === 0, remoteHits.slice(0, 3).join(" | ") || "no remote resources");
g.check("no sync bookkeeping", !files.some((f) => SYNC_BOOKKEEPING.test(f)), "I4 — _ds_sync.json / _ods_sync.json / _ods_needs_recompile");
g.check("no re-suffixed sources", !files.some((f) => /\.(jsx|d\.ts)\.txt$/i.test(f)), "I1");
g.check("no unfilled README slots", !/\{\{[A-Z_]+\}\}/.test(readme));
g.check("README is the instruction carrier", /^#\s+CODING AGENTS/m.test(readme));
g.check("root purity", rootEntries.every((e) => permitted.has(e)),
  rootEntries.filter((e) => !permitted.has(e)).join(", ") || rootEntries.sort().join(" + "));
g.check("no screenshots at root", !files.some((f) => !f.includes("/") && /\.(png|jpe?g|webp|gif)$/i.test(f)));
// I9 — the mirror materializes internal links as their target's content, so a
// FINISHED bundle contains no symlinks at all. Any left is a hole in the mirror:
// an archive would flatten or drop it, and the receiving agent would get neither
// the file nor an error.
/* The advertised deliverables, checked against the built tree — the archive is made
 * from this directory, so whatever is missing here is missing from the zip. */

// Same stale-state family as the verdict: the entry file was resolved at phase 00 and
// the README names it as the first thing to read. If it was renamed or deleted before
// the mirror was taken, the bundle instructs the agent to open a path it does not have.
if (state.entry?.file) {
  g.check("the README's entry file is in the mirror", files.includes(`project/${state.entry.file}`),
    `project/${state.entry.file}`);
}
if ((options.depth ?? "both") === "both" && options.feature) {
  const specPrefix = `project/${featureDirName(options.feature)}/`;
  const specFiles = files.filter((f) => f.startsWith(specPrefix));
  const specReadme = specFiles.find((f) => f === `${specPrefix}README.md`);
  g.check("depth=both — authored spec is inside the bundle", !!specReadme,
    specReadme ? `${specPrefix} — ${specFiles.length} file(s)` : `${specPrefix} absent from the mirror`);
  if (specReadme) {
    g.check("the nested spec is authored, not a skeleton",
      !TODO_MARKER.test(readFileSync(join(bundleRoot, specReadme), "utf8")), specReadme);
    g.check("the nested spec carries its prototypes",
      specFiles.some((f) => f.startsWith(`${specPrefix}prototypes/`)), `${specPrefix}prototypes/`);
  }
}
if (options.includeChats) {
  g.check("includeChats — transcript is in the bundle",
    files.some((f) => f.startsWith("chats/")),
    `${files.filter((f) => f.startsWith("chats/")).length} file(s) under chats/`);
}

const bundleLinks = symlinkScan(bundleRoot);
g.check("no symlinks in the bundle — I9",
  bundleLinks.followed.length === 0 && bundleLinks.unsafe.length === 0,
  bundleLinks.unsafe.length
    ? `${bundleLinks.unsafe.length} unsafe:\n${describeUnsafe(bundleLinks.unsafe)}`
    : bundleLinks.followed.length
      ? `${bundleLinks.followed.length} link(s) survived materialization: ${bundleLinks.followed.map((l) => l.rel).join(", ")}`
      : "fully materialized");

if (designSystem) {
  const dsDir = join(bundleRoot, "project", designSystem.dir === "." ? "" : designSystem.dir);
  const config = readJson(join(dsDir, "_adherence.oxlintrc.json"));
  const manifest = readJson(join(dsDir, "_ds_manifest.json"));
  g.check("adherence config parses", !!config);
  if (config && manifest) {
    const problems = verifyAdherence(config, manifest);
    g.check("adherence agrees with the DS manifest", problems.length === 0, problems.slice(0, 3).join(" | "));
  }
  if (designSystem.fonts.length) {
    g.warn("font binaries shipped", files.some((f) => /\.woff2?$/i.test(f)), designSystem.fonts.join(", "));
  }
}

/* I8: the archive phase refuses to run without this verdict — and the verdict is
 * bound to the exact tree it describes. A digest over the bundle's contents is what
 * makes "phase 03 passed" a statement about files rather than about a path: phase 04
 * recomputes it and refuses on any difference, so a rebuild or a hand-edit after
 * validation cannot be archived under a verdict that never saw it. */
const inspected = hashTree(bundleRoot);
writeJson(join(outRoot, ".handoff", "validate.json"), {
  at: new Date().toISOString(),
  root: project.slug,
  ok: g.passed,
  treeHash: inspected.hash,
  fileCount: inspected.files.length,
  // Per-file, so phase 04 can compare the bytes it actually wrote into the archive
  // against the bytes inspected here — and name the file when they differ.
  digests: inspected.digests,
  gates: g.rows,
});

g.finish();
