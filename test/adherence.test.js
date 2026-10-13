import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMembers, parseInterfaces, literalUnion, buildAdherence, verifyAdherence, fontAllowlist,
} from "../scripts/_adherence.js";

/* ── the arrow-type regression ─────────────────────────────────────────────
 * `(next: boolean) => void` — if `>` is tracked as a closing bracket the depth
 * counter goes negative and every later member vanishes. This cost a real prop. */

test("parseMembers survives an arrow-type annotation", () => {
  const members = parseMembers(`
    checked?: boolean;
    onChange?: (next: boolean) => void;
    scale?: number;
  `);
  assert.deepEqual(members.map((m) => m.name), ["checked", "onChange", "scale"]);
});

test("parseMembers keeps declaration order and handles generics, arrays, nested objects", () => {
  const members = parseMembers(`
    links: NavigationLink[];
    render?: Record<string, () => JSX.Element>;
    meta?: { a: string; b: number };
    last?: string;
  `);
  assert.deepEqual(members.map((m) => m.name), ["links", "render", "meta", "last"]);
});

test("parseMembers reads quoted keys without derailing the rest", () => {
  const members = parseMembers(`links: X[];\n"aria-label"?: string;\ntrailing?: number;`);
  assert.deepEqual(members.map((m) => m.name), ["links", "aria-label", "trailing"]);
});

test("parseInterfaces strips a trailing Props and finds every exported interface", () => {
  const ifaces = parseInterfaces(`
    export interface HyperspeedHeroCta { label: string; href: string; }
    export interface HyperspeedHeroProps { eyebrow?: string; }
  `);
  assert.deepEqual(ifaces.map((i) => i.name), ["HyperspeedHeroCta", "HyperspeedHero"]);
});

test("literalUnion accepts inline unions and rejects aliases", () => {
  assert.deepEqual(literalUnion(`"divider" | "vein"`), ["divider", "vein"]);
  assert.deepEqual(literalUnion(`'left' | 'right'`), ["left", "right"]);
  assert.equal(literalUnion("ButtonVariant"), null);
  assert.equal(literalUnion("string"), null);
  assert.equal(literalUnion(`"only"`), null, "a single literal is not a union");
});

/* ── generator ─────────────────────────────────────────────────────────────── */

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hdd-adh-"));
  mkdirSync(join(dir, "components", "Actions", "Button"), { recursive: true });
  mkdirSync(join(dir, "components", "Display", "Separator"), { recursive: true });
  writeFileSync(join(dir, "components", "Actions", "Button", "Button.d.ts"), `
    import type { ButtonHTMLAttributes } from "react";
    export type ButtonVariant = "primary" | "ghost";
    export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
      /** doc comment must not become a prop */
      variant?: ButtonVariant;
      disabled?: boolean;
      onPress?: (e: unknown) => void;
      children?: React.ReactNode;
    }
  `);
  writeFileSync(join(dir, "components", "Display", "Separator", "Separator.d.ts"), `
    export interface SeparatorProps {
      variant?: "divider" | "vein";
      orientation?: "horizontal" | "vertical";
    }
  `);
  const manifest = {
    namespace: "Fixture_01",
    components: [
      { name: "Button", sourcePath: "components/Actions/Button/Button.jsx", replaces: ["button"] },
      { name: "Separator", sourcePath: "components/Display/Separator/Separator.jsx" },
    ],
    fonts: ["Inter", "JetBrains Mono"],
    tokens: [{ name: "--bg", value: "#000", kind: "color" }, { name: "--fg", value: "#fff", kind: "color" }],
  };
  return { dir, manifest };
}

test("buildAdherence emits the documented rule shape", () => {
  const { dir, manifest } = fixture();
  const c = buildAdherence(manifest, dir);

  assert.deepEqual(c.plugins, ["react", "import"]);
  assert.deepEqual(c.overrides, [{ files: ["**/index.js"], rules: { "no-restricted-imports": "off" } }]);

  // library-declared replaces only
  assert.deepEqual(c.rules["react/forbid-elements"][1].forbid, [
    { element: "button", message: "Use <Button> from the design system instead of <button>." },
  ]);

  assert.deepEqual(c.rules["no-restricted-imports"][1].patterns[0].group,
    ["components/Actions/Button/**", "components/Display/Separator/**"]);

  const rules = c.rules["no-restricted-syntax"];
  assert.equal(rules[0], "warn");
  assert.match(rules[1].selector, /#\[0-9a-fA-F\]\{3,8\}/);
  assert.match(rules[2].selector, /\\b\\d\+px\\b/);
  assert.match(rules[3].message, /Available: Inter, JetBrains Mono\./);

  const byMsg = Object.fromEntries(rules.slice(1).filter((r) => r.message.includes("Declared props"))
    .map((r) => [/<(\w+)>/.exec(r.message)[1], r.message]));
  assert.equal(byMsg.Button,
    "<Button> doesn't accept that prop. Declared props: variant, disabled, onPress, children.");
  assert.equal(byMsg.Separator,
    "<Separator> doesn't accept that prop. Declared props: variant, orientation.");

  // the always-appended tail is in the allowlist but never in the message
  const buttonRule = rules.slice(1).find((r) => r.message.startsWith("<Button> doesn't"));
  for (const tail of ["key", "ref", "className", "style", "children"]) {
    assert.ok(buttonRule.selector.includes(tail), `${tail} missing from allowlist`);
  }

  // inline unions constrain the value; the aliased one does not
  const unions = rules.slice(1).filter((r) => r.message.includes("must be one of")).map((r) => r.message);
  assert.deepEqual(unions, [
    "<Separator> variant must be one of 'divider' | 'vein'.",
    "<Separator> orientation must be one of 'horizontal' | 'vertical'.",
  ]);

  assert.deepEqual(c["x-omelette"].tokens, ["--bg", "--fg"]);
  assert.deepEqual(Object.keys(c["x-omelette"].components).sort(), ["Button", "Separator"]);
});

test("components are emitted alphabetically", () => {
  const { dir, manifest } = fixture();
  const names = buildAdherence(manifest, dir).rules["no-restricted-syntax"]
    .slice(1).map((r) => /name\.name='(\w+)'/.exec(r.selector)?.[1]).filter(Boolean);
  assert.deepEqual([...new Set(names)], ["Button", "Separator"]);
});

test("no font rule when the design system declares no fonts", () => {
  const { dir, manifest } = fixture();
  const c = buildAdherence({ ...manifest, fonts: [], brandFonts: [] }, dir);
  assert.equal(c.rules["no-restricted-syntax"].filter((r) => r.message?.includes("Font not provided")).length, 0);
  assert.deepEqual(fontAllowlist({ fonts: [], brandFonts: [] }), []);
});

test("verifyAdherence catches a rule for a component the manifest does not know", () => {
  const { dir, manifest } = fixture();
  const c = buildAdherence(manifest, dir);
  assert.deepEqual(verifyAdherence(c, manifest), []);

  c.rules["no-restricted-syntax"].push({
    selector: "JSXOpeningElement[name.name='Ghost'] > JSXAttribute > JSXIdentifier[name!=/^(?:x)$/]",
    message: "<Ghost> doesn't accept that prop. Declared props: x.",
  });
  assert.deepEqual(verifyAdherence(c, manifest), ["prop rule for unknown component <Ghost>"]);
});
