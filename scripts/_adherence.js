// scripts/_adherence.js — generate `_adherence.oxlintrc.json`, the machine-enforced
// design-system fidelity contract that ships in the bundle and polices the TARGET
// codebase. Pure functions; every rule derives from `_ds_manifest.json` plus each
// component's `.d.ts`. Never hand-write this file.
//
// Rule shapes were recovered by diffing two real generated configs. Severity is
// `warn` throughout — advisory, not build-breaking.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const PROP_TAIL = ["key", "ref", "className", "style", "children"];
const IDENT = /^[A-Za-z_$][\w$]*$/;
const STRING_LITERAL = /^(?:"[^"]*"|'[^']*')$/;

/* ── .d.ts parsing ──────────────────────────────────────────────────────── */

const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/**
 * End of one interface member's type annotation. Only `{[(` nest — `<` and `>`
 * must NOT be tracked, or the `>` in an arrow type (`(x) => void`) unbalances the
 * depth and silently swallows every member that follows.
 */
function skipType(body, i) {
  let depth = 0;
  for (; i < body.length; i++) {
    const c = body[i];
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) { if (depth === 0) return i; depth--; }
    else if (depth === 0 && (c === ";" || c === "\n")) return i;
  }
  return i;
}

/** Brace-balanced body of the interface declared at `from`. */
function bodyAt(src, from) {
  const open = src.indexOf("{", from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

/** `[{ name, optional, type }]` in declaration order — the order the message lists. */
export function parseMembers(body) {
  const members = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s;,]/.test(body[i])) i++;
    if (i >= body.length) break;

    let name = "";
    if (body[i] === '"' || body[i] === "'") {
      const q = body[i++];
      while (i < body.length && body[i] !== q) name += body[i++];
      i++;
    } else {
      while (i < body.length && /[\w$]/.test(body[i])) name += body[i++];
    }
    if (!name) { i = skipType(body, i + 1); continue; }

    while (i < body.length && /\s/.test(body[i])) i++;
    const optional = body[i] === "?";
    if (optional) i++;
    while (i < body.length && /\s/.test(body[i])) i++;

    if (body[i] !== ":") { i = skipType(body, i); continue; }
    const start = ++i;
    i = skipType(body, i);
    members.push({ name, optional, type: body.slice(start, i).trim() });
  }
  return members;
}

/**
 * Every exported interface in a `.d.ts`, as `{ name, members }`. A trailing
 * `Props` is stripped to recover the component name.
 *
 * Divergence, deliberate: the upstream generator skips components declared as
 * bare `FC<XProps>` (while keeping `React.FC<XProps>` ones) — a quirk of its own
 * regex. We emit a rule for every exported interface, which is a strict superset
 * and lints more of the surface. Nothing is lost, two extra components are gained.
 */
export function parseInterfaces(dtsSource) {
  const src = stripComments(dtsSource);
  const out = [];
  const re = /\bexport\s+interface\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src))) {
    const body = bodyAt(src, m.index);
    if (body === null) continue;
    out.push({ name: m[1].replace(/Props$/, ""), members: parseMembers(body) });
  }
  return out;
}

/** Inline string-literal union -> its values. Aliased unions return null. */
export function literalUnion(type) {
  const parts = String(type).split("|").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2 || !parts.every((p) => STRING_LITERAL.test(p))) return null;
  return parts.map((p) => p.slice(1, -1));
}

/** Every component contract the design system declares, sorted by name. */
export function collectComponents(manifest, dsDir) {
  const seen = new Map();
  for (const comp of manifest.components ?? []) {
    const dts = join(dsDir, dirname(comp.sourcePath), `${comp.name}.d.ts`);
    if (!existsSync(dts)) { seen.set(comp.name, seen.get(comp.name) ?? { name: comp.name, members: [] }); continue; }
    let src = "";
    try { src = readFileSync(dts, "utf8"); } catch { continue; }
    for (const iface of parseInterfaces(src)) if (!seen.has(iface.name)) seen.set(iface.name, iface);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ── x-omelette ─────────────────────────────────────────────────────────── */

// Which native element a component supersedes is LIBRARY-DECLARED metadata, not
// static analysis. The npm-library design system declares button/dialog/input;
// the project-local one declares none at all despite shipping Button and Input.
// So: read it when present, never guess.
export function buildOmelette(manifest, components) {
  const declared = manifest.replaces ?? {};
  const byName = Object.fromEntries((manifest.components ?? []).map((c) => [c.name, c.replaces]));
  const out = {};
  for (const c of components) out[c.name] = { replaces: byName[c.name] ?? declared[c.name] ?? [] };
  const tokens = [...new Set((manifest.tokens ?? []).map((t) => t.name).filter(Boolean))].sort();
  return { components: out, tokens };
}

export function fontAllowlist(manifest) {
  const names = [...(manifest.fonts ?? []), ...(manifest.brandFonts ?? [])]
    .flatMap((f) => (typeof f === "string" ? [f] : [f?.family ?? f?.name]))
    .filter(Boolean);
  return [...new Set(names)];
}

/* ── the generator ──────────────────────────────────────────────────────── */

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function buildAdherence(manifest, dsDir, opts = {}) {
  const components = opts.components ?? collectComponents(manifest, dsDir);
  const omelette = buildOmelette(manifest, components);

  const forbid = Object.entries(omelette.components)
    .flatMap(([name, { replaces }]) => replaces.map((element) => ({
      element,
      message: `Use <${name}> from the design system instead of <${element}>.`,
    })))
    .sort((a, b) => a.element.localeCompare(b.element));

  const group = [...new Set((manifest.components ?? []).map((c) => `${dirname(c.sourcePath)}/**`))];

  const fonts = fontAllowlist(manifest);
  const restricted = [
    { selector: "Literal[value=/#[0-9a-fA-F]{3,8}\\b/]", message: "Raw hex color — use a design-system color token via var()." },
    { selector: "Literal[value=/\\b\\d+px\\b/]", message: "Raw px value — use a design-system spacing token via var()." },
  ];
  if (fonts.length) {
    restricted.push({
      selector: `Literal[value=/font-family\\s*:\\s*(?!['\\"]?(?:${fonts.map(escapeRe).join("|")}))/i]`,
      message: `Font not provided by the design system. Available: ${fonts.join(", ")}.`,
    });
  }

  for (const comp of components) {
    const props = comp.members.filter((m) => IDENT.test(m.name));
    if (!props.length) continue; // collapsed design systems ship no .d.ts to read
    const names = props.map((p) => p.name);
    const allowed = [...names, ...PROP_TAIL].map(escapeRe).join("|");
    restricted.push({
      selector: `JSXOpeningElement[name.name='${comp.name}'] > JSXAttribute > JSXIdentifier[name!=/^(?:${allowed})$/]`,
      message: `<${comp.name}> doesn't accept that prop. Declared props: ${names.join(", ")}.`,
    });
    // Inline string-literal unions additionally constrain the VALUE.
    for (const p of props) {
      const values = literalUnion(p.type);
      if (!values) continue;
      restricted.push({
        selector: `JSXOpeningElement[name.name='${comp.name}'] > JSXAttribute[name.name='${p.name}'] > Literal[value!=/^(?:${values.map(escapeRe).join("|")})$/]`,
        message: `<${comp.name}> ${p.name} must be one of ${values.map((v) => `'${v}'`).join(" | ")}.`,
      });
    }
  }

  return {
    plugins: ["react", "import"],
    rules: {
      "react/forbid-elements": ["warn", { forbid }],
      "no-restricted-imports": ["warn", {
        patterns: [{ group, message: "Import design-system components from 'index.js', not component internals." }],
      }],
      "no-restricted-syntax": ["warn", ...restricted],
    },
    overrides: [{ files: ["**/index.js"], rules: { "no-restricted-imports": "off" } }],
    "x-omelette": omelette,
  };
}

/** Phase-03 gate: the config parses AND every prop rule names a known component. */
export function verifyAdherence(config, manifest, components = null) {
  const problems = [];
  const known = new Set([
    ...(manifest.components ?? []).map((c) => c.name),
    ...(components ?? []).map((c) => c.name),
    ...Object.keys(config?.["x-omelette"]?.components ?? {}),
  ]);
  const rules = config?.rules?.["no-restricted-syntax"];
  if (!Array.isArray(rules)) return ["no-restricted-syntax rule missing"];

  for (const r of rules.slice(1)) {
    const name = /JSXOpeningElement\[name\.name='([^']+)'\]/.exec(r?.selector ?? "")?.[1];
    if (name && !known.has(name)) problems.push(`prop rule for unknown component <${name}>`);
  }
  for (const f of config?.rules?.["react/forbid-elements"]?.[1]?.forbid ?? []) {
    if (!/^Use <[\w$]+> from the design system instead of <[\w-]+>\.$/.test(f.message ?? "")) {
      problems.push(`malformed forbid message for <${f.element}>`);
    }
  }
  if (!Array.isArray(config?.plugins) || !config.plugins.includes("react")) problems.push("plugins missing 'react'");
  return problems;
}
