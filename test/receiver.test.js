// The two legs, together: run the sender's pipeline, then hand its archive to the
// receiver's tools and check that what comes out is what went in.
//
// The interesting assertions are the cross-implementation ones. The sender hashes a
// tree with scripts/_lib.js; the receiver recomputes that digest from the archive's
// own decoded bytes with a separate reader in dsh/index.js. If those two agree, the
// digest means something. If they agreed because they shared code, it would not.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts");
const DS = "fixture-ds-11111111-2222-3333-4444-555555555555";

/* ── the sender, driven exactly as the runbook drives it ──────────────────── */

function run(script, argv, cwd) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [join(SCRIPTS, script), ...argv],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/** A project with a bound design system, its short alias, and sync bookkeeping. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hdd-rx-"));
  const proj = join(root, "src");
  const ds = join(proj, "_ds", DS);
  mkdirSync(join(ds, "components", "Actions", "Button"), { recursive: true });
  mkdirSync(join(proj, "_ds", "fx"), { recursive: true });

  writeFileSync(join(proj, "Landing.dc.html"),
    `<link rel="stylesheet" href="_ds/fx/_ds_bundle.css">\n<script src="./support.js"></script>\n<h1>Landing</h1>`);
  writeFileSync(join(proj, "support.js"), "// runtime");
  writeFileSync(join(proj, "_ds_sync.json"), `{"bundleSha12":"deadbeef"}`);
  writeFileSync(join(ds, "_ds_bundle.css"), ":root{--bg:#000}");
  writeFileSync(join(ds, "styles.css"), `@import "./_ds_bundle.css";`);
  writeFileSync(join(ds, "components", "Actions", "Button", "Button.jsx"),
    "export const Button=()=>null");
  writeFileSync(join(ds, "components", "Actions", "Button", "Button.d.ts"),
    `export interface ButtonProps { variant?: "primary" | "ghost"; }`);
  writeFileSync(join(ds, "_ds_manifest.json"), JSON.stringify({
    namespace: "Fixture",
    components: [{ name: "Button", sourcePath: "components/Actions/Button/Button.jsx" }],
    globalCssPaths: ["styles.css"],
    tokens: [{ name: "--bg", value: "#000", kind: "color" }],
  }));
  writeFileSync(join(proj, "_ds", "fx", "_ds_bundle.css"), ":root{--bg:#000}");

  const out = join(root, "out");
  mkdirSync(out, { recursive: true });
  return { root, proj, out };
}

/** detect -> bundle -> validate -> archive. Returns everything the tests reach for. */
function produce() {
  const { proj, out, root } = fixture();
  const d = run("hdd-detect.js", ["--project-name", "Fixture Project", "--project-dir", proj,
    "--entry", "Landing.dc.html"], out);
  assert.equal(d.code, 0, d.out);
  const b = run("hdd-bundle.js", [], out);
  assert.equal(b.code, 0, b.out);
  const v = run("hdd-validate.js", [], out);
  assert.equal(v.code, 0, v.out);
  const a = run("hdd-archive.js", ["--format", "zip"], out);
  assert.equal(a.code, 0, a.out);

  const verdictPath = join(out, ".handoff", "validate.json");
  const zip = JSON.parse(readFileSync(join(out, ".handoff", "archive.json"), "utf8"))
    .written.find((w) => w.format === "zip").path;
  return { root, proj, out, zip, verdictPath, verdict: JSON.parse(readFileSync(verdictPath, "utf8")) };
}

/* ── the receiver, loaded the way the Loader would ────────────────────────── */

async function loadTools() {
  const { apply } = await import("../dsh/index.js");
  const registered = [];
  apply({ tools: { register: (t) => { registered.push(t); return () => {}; } } });
  return { registered, tool: Object.fromEntries(registered.map((t) => [t.name, t])) };
}

const call = (tool, args) => tool.execute(args, {});

/* ── a hand-rolled zip, for the archives the sender refuses to write ──────── */

let CRC = null;
function crc32(buf) {
  if (!CRC) {
    CRC = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[i] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * A stored-entry zip. Entry names are taken literally, which is the point: the
 * sender's writer can only name files a walk produced, so the hostile names a
 * receiver must survive cannot be produced by the sender at all.
 * @param entries - `{ name, data, crc?, uncompSize?, zip64? }`
 */
function zipOf(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data ?? "");
    const crc = e.crc ?? crc32(data);
    const uncomp = e.zip64 ? 0xffffffff : (e.uncompSize ?? data.length);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(uncomp, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(uncomp, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const README_OK = "# CODING AGENTS: START HERE\n\nRead `demo/project/index.html`.\n";

/* ── the happy path ───────────────────────────────────────────────────────── */

test("the receiver verifies an archive the sender produced", async () => {
  const { tool } = await loadTools();
  const { zip, verdictPath } = produce();

  const r = await call(tool.handoff_inspect, { path: zip, verdict: verdictPath });
  assert.equal(r.ok, true, JSON.stringify(r.gates.filter((g) => !g.ok), null, 2));
  assert.equal(r.kind, "zip");
  assert.equal(r.root, "fixture-project");
  assert.ok(r.fileCount > 0);
  for (const g of r.gates) assert.equal(g.ok, true, `${g.name}: ${g.detail}`);
});

/* ── the cross-implementation assertion ───────────────────────────────────── */

test("the receiver recomputes the sender's tree digest from the archive's own bytes", async () => {
  const { tool } = await loadTools();
  const { zip, verdict } = produce();

  const r = await call(tool.handoff_inspect, { path: zip });
  assert.equal(r.treeHash, verdict.treeHash,
    "two independent readers must agree on the digest, or the digest means nothing");
  assert.equal(r.fileCount, verdict.fileCount);
});

test("a verdict for a different tree is caught", async () => {
  const { tool } = await loadTools();
  const { zip, verdictPath } = produce();
  const forged = join(dirname(verdictPath), "forged.json");
  const verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
  verdict.digests["project/Landing.dc.html"] = "0".repeat(64);
  writeFileSync(forged, JSON.stringify(verdict));

  const r = await call(tool.handoff_inspect, { path: zip, verdict: forged });
  assert.equal(r.ok, false);
  assert.match(r.gates.find((g) => g.name.includes("byte-identical")).detail, /altered/);
});

/* ── import ───────────────────────────────────────────────────────────────── */

test("import extracts the bundle verbatim", async () => {
  const { tool } = await loadTools();
  const { zip, out } = produce();
  const into = join(out, "..", "imported");

  const r = await call(tool.handoff_import, { archive: zip, into });
  assert.equal(r.root, "fixture-project");
  assert.ok(r.extracted > 0);

  const bundle = join(into, "fixture-project");
  assert.match(readFileSync(join(bundle, "README.md"), "utf8"), /^# CODING AGENTS/);
  // I1 — the mirror is byte-verbatim, and the entry file survived it.
  assert.equal(readFileSync(join(bundle, "project", "support.js"), "utf8"), "// runtime");
  assert.equal(readFileSync(join(bundle, "project", "_ds", "fx", "_ds_bundle.css"), "utf8"),
    ":root{--bg:#000}");
  // I4 — sync bookkeeping never ships.
  assert.equal(existsSync(join(bundle, "project", "_ds_sync.json")), false);
});

test("import refuses a non-empty target without force", async () => {
  const { tool } = await loadTools();
  const { zip, out } = produce();
  const into = join(out, "..", "occupied");
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, "something.txt"), "mine");

  await assert.rejects(() => call(tool.handoff_import, { archive: zip, into }), /is not empty/);

  const r = await call(tool.handoff_import, { archive: zip, into, force: true });
  assert.ok(r.extracted > 0);
  assert.equal(readFileSync(join(into, "something.txt"), "utf8"), "mine",
    "force replaces the bundle it names, never the directory around it");
});

/* ── the brief ────────────────────────────────────────────────────────────── */

test("the brief is the README, verbatim", async () => {
  const { tool } = await loadTools();
  const { zip } = produce();
  const r = await call(tool.handoff_brief, { path: zip });
  assert.match(r.readme, /^# CODING AGENTS: START HERE/);
  assert.match(r.readme, /## Sending changes back/);
  assert.equal(r.entryFile, "Landing.dc.html");
  assert.ok(r.topLevel.includes("project"));
});

/* ── what the receiver must refuse ────────────────────────────────────────── */

test("an entry that climbs out of the extraction root is refused, not sanitized", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hdd-evil-"));
  const outside = join(dir, "outside.txt");
  const zip = join(dir, "evil.zip");
  writeFileSync(zip, zipOf([
    { name: "demo/README.md", data: README_OK },
    { name: "demo/project/index.html", data: "<h1>hi</h1>" },
    { name: "../outside.txt", data: "pwned" },
  ]));

  const { tool } = await loadTools();
  const r = await call(tool.handoff_inspect, { path: zip });
  assert.equal(r.ok, false);
  assert.equal(r.gates.find((g) => g.name.startsWith("no entry escapes")).ok, false);

  await assert.rejects(
    () => call(tool.handoff_import, { archive: zip, into: join(dir, "into") }),
    /gate\(s\) failed/);
  assert.equal(existsSync(outside), false, "nothing may be written outside the target");
});

test("an absolute entry name is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hdd-abs-"));
  const zip = join(dir, "abs.zip");
  writeFileSync(zip, zipOf([
    { name: "demo/README.md", data: README_OK },
    { name: "/etc/passwd", data: "x" },
  ]));
  const { tool } = await loadTools();
  const r = await call(tool.handoff_inspect, { path: zip });
  assert.equal(r.ok, false);
  assert.match(r.gates.find((g) => g.name.startsWith("no entry escapes")).detail, /absolute/);
});

test("a backslash entry name is refused — Windows reads it as a separator", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hdd-bs-"));
  const zip = join(dir, "bs.zip");
  writeFileSync(zip, zipOf([
    { name: "demo/README.md", data: README_OK },
    { name: "..\\outside.txt", data: "x" },
  ]));
  const { tool } = await loadTools();
  const r = await call(tool.handoff_inspect, { path: zip });
  assert.equal(r.ok, false);
});

test("a corrupted entry is caught by its CRC", async () => {
  const { tool } = await loadTools();
  const { zip } = produce();
  const buf = readFileSync(zip);

  // Flip a bit in the first central-directory entry's stored CRC. Everything else
  // stays consistent, so only a reader that actually re-hashes the data notices.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  const cdStart = buf.readUInt32LE(eocd + 16);
  buf.writeUInt32LE((buf.readUInt32LE(cdStart + 16) ^ 0xffffffff) >>> 0, cdStart + 16);

  const broken = join(dirname(zip), "broken.zip");
  writeFileSync(broken, buf);
  await assert.rejects(() => call(tool.handoff_inspect, { path: broken }), /failed its CRC/);
});

test("a zip64 sentinel is refused rather than verified against the wrong bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hdd-z64-"));
  const zip = join(dir, "z64.zip");
  writeFileSync(zip, zipOf([
    { name: "demo/README.md", data: README_OK },
    { name: "demo/big.bin", data: "tiny", zip64: true },
  ]));
  const { tool } = await loadTools();
  await assert.rejects(() => call(tool.handoff_inspect, { path: zip }), /zip64/);
});

/* ── the trap that cost the upstream project a rewrite ────────────────────── */

test("a file named .zip that is not a zip is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hdd-tar-"));
  const fake = join(dir, "not-really.zip");
  // A ustar header followed by zero blocks — GNU `tar -a -c -f out.zip` writes this.
  const tar = Buffer.alloc(512 + 1024);
  tar.write("demo/README.md", 0, "utf8");
  tar.write("0000644\0", 100, "utf8");
  tar.write("00000000000\0", 124, "utf8");
  tar.write("ustar\0", 257, "utf8");
  tar.write("00", 263, "utf8");
  writeFileSync(fake, tar);

  const { tool } = await loadTools();
  await assert.rejects(() => call(tool.handoff_inspect, { path: fake }),
    /neither a zip .*nor a gzip stream/s);
});

/* ── the contract gates, on a bundle the sender would never emit ──────────── */

test("a bundle with an unfilled README slot fails its gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hdd-slot-"));
  const zip = join(dir, "slot.zip");
  writeFileSync(zip, zipOf([
    { name: "demo/README.md", data: "# CODING AGENTS: START HERE\n\n{{ENTRY_DIRECTIVE}}\n" },
    { name: "demo/project/index.html", data: "<h1>hi</h1>" },
  ]));
  const { tool } = await loadTools();
  const r = await call(tool.handoff_inspect, { path: zip });
  assert.equal(r.ok, false);
  assert.match(r.gates.find((g) => g.name === "no unfilled README slots").detail, /\{\{ENTRY_DIRECTIVE\}\}/);
});

test("root purity catches a manifest the bundle is not allowed to carry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hdd-pure-"));
  const zip = join(dir, "pure.zip");
  writeFileSync(zip, zipOf([
    { name: "demo/README.md", data: README_OK },
    { name: "demo/project/index.html", data: "<h1>hi</h1>" },
    { name: "demo/handoff.json", data: "{}" },
  ]));
  const { tool } = await loadTools();
  const r = await call(tool.handoff_inspect, { path: zip });
  assert.equal(r.ok, false);
  assert.match(r.gates.find((g) => g.name === "root purity").detail, /handoff\.json/);
});

test("two top-level directories are not a handoff bundle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hdd-two-"));
  const zip = join(dir, "two.zip");
  writeFileSync(zip, zipOf([
    { name: "a/README.md", data: README_OK },
    { name: "b/README.md", data: README_OK },
  ]));
  const { tool } = await loadTools();
  await assert.rejects(() => call(tool.handoff_inspect, { path: zip }), /2 top-level directories/);
});

test("a malformed adherence config fails its gate — it looks like enforcement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hdd-adh-"));
  const zip = join(dir, "adh.zip");
  writeFileSync(zip, zipOf([
    { name: "demo/README.md", data: README_OK },
    { name: "demo/project/index.html", data: "<h1>hi</h1>" },
    { name: "demo/project/_ds/thing-11111111-2222-3333-4444-555555555555/_adherence.oxlintrc.json", data: "{ nope" },
  ]));
  const { tool } = await loadTools();
  const r = await call(tool.handoff_inspect, { path: zip });
  assert.equal(r.ok, false);
  assert.equal(r.gates.find((g) => g.name.startsWith("adherence config parses")).ok, false);
});

/* ── the three tools are actually registered ──────────────────────────────── */

test("the bundle registers exactly the three receiving tools", async () => {
  const { registered } = await loadTools();
  assert.deepEqual(registered.map((t) => t.name).sort(),
    ["handoff_brief", "handoff_import", "handoff_inspect"]);  for (const t of registered) {
    // Every tool needs a usable model-facing contract, not just an implementation.
    assert.ok(t.description.length > 40, `${t.name} needs a real description`);
    assert.equal(t.output.schema.type, "object");
    assert.equal(typeof t.output.render, "function");
    assert.equal(typeof t.execute, "function");
  }
});
