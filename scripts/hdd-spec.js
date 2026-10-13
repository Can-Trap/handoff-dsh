#!/usr/bin/env node
// Phase 02 — spec scaffold (Mechanism B). Does the MECHANICAL half of the authored
// handoff folder: creates the tree, copies prototypes and the design-system doc,
// and writes a README skeleton with every derivable fact already filled in.
//
// The agent then authors the prose over the TODO markers. hdd-validate --spec
// refuses to pass while any remain.
//
//   node scripts/hdd-spec.js --feature "auth system" [--files "a.html,b.html"] [--out <dir>]
import { existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import {
  args, die, readState, readJson, writeText, walk, slugify, childDir, isUnder,
  featureSlug, featureDirName, Gates, posix, NEVER_SHIP,
} from "./_lib.js";

const a = args();
const outRoot = a.out ?? process.cwd();
const state = readState(outRoot);
if (!state) die("no .handoff/state.json — run hdd-detect.js first");

const { project, entry, designSystem, options } = state;
const feature = (typeof a.feature === "string" && a.feature) || options.feature;
if (!feature) die('--feature is required, e.g. --feature "auth system"');

// `depth` is a real switch, not a label: at depth=bundle this phase does not run.
const depth = a.depth ?? options.depth ?? "both";
if (depth === "bundle") {
  die(`depth=bundle — phase 02 does not run at this depth.\n` +
    `  Re-run phase 00 with --depth both (nest the spec inside the bundle) or --depth spec\n` +
    `  (author the spec alone), or pass --depth both to this script to override.`);
}

const slug = featureSlug(feature);
const dir = childDir(project.dir, featureDirName(feature), "feature slug");
mkdirSync(join(dir, "prototypes"), { recursive: true });
mkdirSync(join(dir, "reference"), { recursive: true });

/* ── in-scope prototypes ────────────────────────────────────────────────────── */

const all = walk(project.dir, { exclude: [...NEVER_SHIP, /^design_handoff_/] });
// A feature named entirely outside [a-z0-9] has no stem to match on, and `""` is a
// substring of every string — so guard it, or the filter selects the whole project.
const stem = slugify(feature).split("-")[0];
const selected = typeof a.files === "string"
  ? a.files.split(",").map((s) => s.trim()).filter(Boolean)
  : (stem ? all.filter((f) => /\.(dc\.html|html)$/i.test(f) && !f.includes("/") &&
      slugify(basename(f)).includes(stem)) : []);

// I9 — `--files` is raw user input and bypasses `walk`, so it is the one way an
// arbitrary path reaches copyFileSync. `../../../secrets.env` exists, and would
// otherwise be copied into a spec folder that then ships inside the bundle.
const escaping = (selected.length ? selected : []).filter((f) => !isUnder(project.dir, f));
if (escaping.length) {
  die(`I9 — --files must stay inside the project:\n${escaping.map((f) => `  ${f}`).join("\n")}\n` +
    `  Paths are relative to ${project.dir}.`);
}

const prototypes = (selected.length ? selected : (entry.file ? [entry.file] : []))
  .filter((f) => existsSync(join(project.dir, f)) && isUnder(project.dir, f));

for (const rel of prototypes) copyFileSync(join(project.dir, rel), join(dir, "prototypes", basename(rel)));

for (const doc of ["DESIGN.md"]) {
  if (existsSync(join(project.dir, doc))) copyFileSync(join(project.dir, doc), join(dir, doc));
}

/* ── derivable facts ────────────────────────────────────────────────────────── */

// A prototype usually multiplexes screens through one state machine and has no
// routing. Naming those states is what lets the target turn them into real routes —
// the single highest-value section in the document.
const SCREEN_PATTERNS = [
  /\bscreen\s*===\s*["'`]([\w-]+)["'`]/g,
  /\bdata-screen\s*=\s*["']([\w-]+)["']/g,
  /\bshowScreen\(\s*["'`]([\w-]+)["'`]/g,
  /\bsetScreen\(\s*["'`]([\w-]+)["'`]/g,
];
const screens = new Set();
for (const rel of prototypes) {
  let src = "";
  try { src = readFileSync(join(project.dir, rel), "utf8"); } catch { continue; }
  for (const rx of SCREEN_PATTERNS) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(src))) screens.add(m[1]);
  }
}

const dsDir = designSystem ? join(project.dir, designSystem.dir) : null;
const manifest = dsDir ? readJson(join(dsDir, "_ds_manifest.json")) : null;

/**
 * Tokens come from the manifest when a design system is bound. Most projects have
 * no manifest at all, so fall back to whatever carrier phase 00 detected — a W3C-ish
 * `tokens.json` or CSS custom properties. The exporter never normalizes carriers and
 * neither do we; we just read the one that exists.
 */
function tokensFromCarrier(rel) {
  if (!rel || rel === "none") return [];
  const abs = join(project.dir, rel);
  if (!existsSync(abs)) return [];

  if (/\.json$/i.test(rel)) {
    const doc = readJson(abs);
    if (!doc) return [];
    const out = [];
    for (const [group, body] of Object.entries(doc)) {
      if (group.startsWith("$") || body === null || typeof body !== "object") continue;
      (function flatten(node, path) {
        for (const [k, v] of Object.entries(node)) {
          if (k.startsWith("$")) continue;
          if (v !== null && typeof v === "object") flatten(v, [...path, k]);
          else out.push({ name: `--${[...path, k].join("-")}`, value: String(v), kind: group, definedIn: rel });
        }
      })(body, [group]);
    }
    return out;
  }

  const css = (() => { try { return readFileSync(abs, "utf8"); } catch { return ""; } })();
  return [...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
    .map((m) => ({ name: m[1], value: m[2].trim(), kind: "css", definedIn: rel }));
}

const tokens = manifest?.tokens?.length ? manifest.tokens : tokensFromCarrier(state.tokenCarrier);
const byKind = tokens.reduce((acc, t) => ((acc[t.kind ?? "other"] ??= []).push(t), acc), {});

// Where a reader can find the full set — the manifest's DS dir, or the carrier
// phase 00 detected when there is no design system at all.
const tokenSource = manifest?.tokens?.length && designSystem
  ? `${posix(designSystem.dir)}/tokens/tokens.json`
  : (state.tokenCarrier && state.tokenCarrier !== "none" ? state.tokenCarrier : "the prototype CSS");

const tokenTable = Object.keys(byKind).length
  ? Object.entries(byKind).sort().map(([kind, list]) =>
      `**${kind}** (${list.length})\n\n| Token | Value |\n|---|---|\n` +
      list.slice(0, 12).map((t) => `| \`${t.name}\` | \`${t.value}\` |`).join("\n") +
      (list.length > 12 ? `\n\n_…and ${list.length - 12} more — see \`${tokenSource}\`._` : "")
    ).join("\n\n")
  : "TODO — no design-system manifest found; extract the tokens from the prototype CSS by hand.";

const routeMap = screens.size
  ? `### Route map (recreate the state machine as real routes)\n\n` +
    `The prototype multiplexes every screen through one state machine and has no routing. ` +
    `In the target each state becomes its own route.\n\n` +
    `| Prototype \`screen\` | Route | Purpose |\n|---|---|---|\n` +
    [...screens].sort().map((s) => `| \`${s}\` | \`/${s}\` | TODO |`).join("\n") + "\n\n"
  : "";

const assets = all.filter((f) => /\.(png|jpe?g|webp|gif|svg|mp4|woff2?)$/i.test(f));
const fileTree = walk(dir).map((f) => `- \`${f}\``).join("\n");

const verification = options.verification || a.verification
  ? `\n## Visual verification (required)\n\n` +
    `After implementing, verify every screen at three breakpoints and iterate until they match.\n\n` +
    `1. Run the dev server; note the port.\n` +
    `2. Screenshot each route at **1440x900**, **1024x768** and **402x874**.\n` +
    `3. Capture key states too — TODO list them (error, loading, empty, open overlays).\n` +
    `4. Compare against \`prototypes/\`. Check spacing, radius, shadow, focus ring, motion.\n` +
    `5. Fix and re-shoot. Confirm no console errors. Keep shots under \`screenshots/\`.\n`
  : "";

/* ── the skeleton ───────────────────────────────────────────────────────────── */

const readme = `# Handoff: ${project.name} — ${feature}

## Overview

TODO — one paragraph: what this feature is, who uses it, and what "done" looks like.

## About the Design Files

The files in \`prototypes/\` are **design references, not the shipping artifact**. They are
HTML/CSS/JS so they render anywhere; that is not a statement about the target stack. Rebuild them
pixel-accurately in whatever the target codebase already uses.

Everything you need — dimensions, colors, spacing, easing — is in the source. Read it directly.

## Fidelity

TODO — state the bar. Which parts are exact (spacing, color, type scale, motion) and which are
free (data, copy beyond the quoted strings, backend shape).

## Screens / Views

${routeMap}TODO — one \`### N. <Name> — \`/route\`\` block per screen. For each: exact copy strings,
every control with its size/color/state, and any algorithm spelled out rather than described.

## Interactions & Behavior

TODO — hover, focus, active, disabled, loading, empty, error. Include duration and easing.

## State Management

TODO — what is local, what is shared, what is server state, what persists.

## Design Tokens

${tokenTable}

## Assets

${assets.length ? assets.slice(0, 20).map((f) => `- \`${f}\``).join("\n") + (assets.length > 20 ? `\n- _…and ${assets.length - 20} more_` : "") : "TODO — none detected."}

## Files (in this bundle)

${fileTree}
${verification}
## Definition of done

- [ ] TODO — one checkbox per screen or contract, each independently verifiable.
`;

writeText(join(dir, "README.md"), readme);

/* ── gates ──────────────────────────────────────────────────────────────────── */

const g = new Gates(`02 spec ${slug}`);
g.check("handoff folder created", existsSync(dir), posix(dir));
g.check("prototypes copied", prototypes.length > 0, `${prototypes.length} file(s)`);
g.check("README skeleton written", existsSync(join(dir, "README.md")));
// Advisory: a project may genuinely carry no tokens, and the author can still
// extract them from the prototype CSS by hand.
g.warn("token table derived", !tokenTable.startsWith("TODO"),
  tokens.length ? `${tokens.length} tokens from ${state.tokenCarrier}` : "none found — author extracts by hand");
if (screens.size) g.check("route map pre-filled", true, `${screens.size} screen states found`);
console.log(`\nNEXT: author the prose over every TODO in ${posix(join(dir, "README.md"))},\n` +
  `then run:  node scripts/hdd-validate.js --spec ${slug}`);
g.finish();
