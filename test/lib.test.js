import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { symlinkSync } from "node:fs";
import { slugify, slugSafe, walk, symlinkScan, copyTree, archive, archiveContents, archiveEntryCount, Gates, args, NEVER_SHIP } from "../scripts/_lib.js";

/**
 * Windows needs Developer Mode or elevation for symlinks; a `junction` needs
 * neither but only works for directories. Probe once — if the platform refuses
 * outright, the symlink suite has nothing to assert and says so loudly rather
 * than passing silently.
 */
function linkKinds() {
  const probe = mkdtempSync(join(tmpdir(), "hdd-link-probe-"));
  mkdirSync(join(probe, "d"));
  writeFileSync(join(probe, "f"), "x");
  const ok = { file: false, dir: false, junction: false };
  for (const [kind, target, name] of [["file", "f", "lf"], ["dir", "d", "ld"], ["junction", "d", "lj"]]) {
    try { symlinkSync(target, join(probe, name), kind); ok[kind] = true; } catch { /* unsupported */ }
  }
  return ok;
}
const LINKS = linkKinds();

test("slugify matches every known project name", () => {
  const cases = [
    ["DESIGN SYSTEM KIT", "design-system-kit"],
    ["Studio CSS - Base Set", "studio-css-base-set"],
    ["Nova Reader App", "nova-reader-app"],
    ["AI Apple", "ai-apple"],
    ["Café  Déjà--Vu!", "cafe-deja-vu"],
    ["  leading and trailing  ", "leading-and-trailing"],
  ];
  for (const [input, want] of cases) assert.equal(slugify(input), want, input);
});

/* ── the empty-slug data-loss path ──────────────────────────────────────────
 * A project name written entirely outside [a-z0-9] slugifies to "", and
 * `join(outRoot, "")` IS outRoot — so the bundle's `--force` rebuild used to
 * target the output directory itself. `slugSafe` is the half of the fix that
 * keeps such a project nameable; `childDir` is the half that makes it
 * unrepresentable (see pipeline.test.js). */

test("slugSafe is never empty, even for a name with no Latin characters at all", () => {
  for (const name of ["设计", "дизайн", "🎨", "こんにちは", "-", "  ", "", null, undefined]) {
    const slug = slugSafe(name);
    assert.ok(slug, `empty slug for ${JSON.stringify(name)}`);
    assert.match(slug, /^[a-z0-9][a-z0-9-]*$/, slug);
    assert.notEqual(slug, ".");
    assert.notEqual(slug, "..");
  }
});

test("slugSafe is deterministic per name and distinct across names", () => {
  assert.equal(slugSafe("设计"), slugSafe("设计"), "a rebuild must find the same directory");
  assert.notEqual(slugSafe("设计"), slugSafe("デザイン"), "two projects must not share one directory");
  assert.match(slugSafe("设计"), /^project-[0-9a-f]{8}$/);
  assert.equal(slugSafe("设计", "feature").startsWith("feature-"), true);
});

test("slugSafe leaves any name that already slugifies alone", () => {
  assert.equal(slugSafe("Nova Reader App"), "nova-reader-app");
  assert.equal(slugSafe("设计 v2"), "v2", "one Latin token is enough — no digest needed");
});

function tree() {
  const dir = mkdtempSync(join(tmpdir(), "hdd-lib-"));
  mkdirSync(join(dir, "sub", "deep"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "a.html"), "<h1>a</h1>");
  writeFileSync(join(dir, "sub", "b.css"), "body{}");
  writeFileSync(join(dir, "sub", "deep", "c.js"), "//c");
  writeFileSync(join(dir, "_ds_sync.json"), "{}");
  writeFileSync(join(dir, "node_modules", "junk.js"), "//junk");
  return dir;
}

test("walk is recursive, sorted, posix-separated and honours excludes", () => {
  const dir = tree();
  assert.deepEqual(walk(dir, { exclude: NEVER_SHIP }),
    ["a.html", "sub/b.css", "sub/deep/c.js"]);
  assert.ok(walk(dir).includes("_ds_sync.json"), "no exclude list means nothing is excluded");
});

test("copyTree mirrors byte-for-byte and skips excluded paths", () => {
  const src = tree();
  const dest = join(mkdtempSync(join(tmpdir(), "hdd-dst-")), "out");
  const copied = copyTree(src, dest, { exclude: NEVER_SHIP });
  assert.equal(copied.length, 3);
  assert.equal(readFileSync(join(dest, "sub", "deep", "c.js"), "utf8"), "//c");
  assert.ok(!existsSync(join(dest, "_ds_sync.json")), "I4 — sync bookkeeping must not ship");
  assert.ok(!existsSync(join(dest, "node_modules")));
});

/* ── I9: nothing outside the project is ever mirrored ───────────────────────
 * `Dirent.isDirectory()` describes the LINK, not its target, so an unclassified
 * walk called every symlink a file and handed it to copyFileSync — which either
 * copied an external target's bytes into the bundle (disclosure) or threw
 * EISDIR/EPERM on a directory link and aborted the mirror. */

/** A project with every link shape: file/dir, inside/outside, dangling, cyclic. */
function linkedTree() {
  const root = mkdtempSync(join(tmpdir(), "hdd-link-"));
  const outside = join(root, "outside");
  const proj = join(root, "proj");
  mkdirSync(join(outside, "dir"), { recursive: true });
  mkdirSync(join(proj, "real", "nested"), { recursive: true });
  mkdirSync(join(proj, "node_modules"), { recursive: true });

  writeFileSync(join(outside, "creds.env"), "AWS_SECRET_ACCESS_KEY=hunter2");
  writeFileSync(join(outside, "dir", "unrelated.txt"), "not ours");
  writeFileSync(join(proj, "Landing.dc.html"), "<h1>L</h1>");
  writeFileSync(join(proj, "real", "inside.css"), "body{}");
  writeFileSync(join(proj, "real", "nested", "deep.js"), "//deep");
  writeFileSync(join(proj, "node_modules", "junk.js"), "//junk");
  return { root, proj, outside };
}

const link = (from, to, kind) => symlinkSync(to, from, kind);

test("a symlink to a file OUTSIDE the project is refused, never copied", { skip: !LINKS.file }, () => {
  const { proj, outside } = linkedTree();
  link(join(proj, "linked-secret.txt"), join(outside, "creds.env"), "file");

  const { unsafe } = symlinkScan(proj, { exclude: NEVER_SHIP });
  assert.equal(unsafe.length, 1);
  assert.equal(unsafe[0].rel, "linked-secret.txt");
  assert.equal(unsafe[0].reason, "resolves outside the project");

  assert.ok(!walk(proj, { exclude: NEVER_SHIP }).includes("linked-secret.txt"),
    "an unsafe link must never reach the file list copyTree consumes");

  const dest = join(mkdtempSync(join(tmpdir(), "hdd-link-dst-")), "out");
  copyTree(proj, dest, { exclude: NEVER_SHIP });
  assert.ok(!existsSync(join(dest, "linked-secret.txt")), "the target's bytes must not be in the mirror");
  assert.ok(existsSync(join(dest, "Landing.dc.html")), "the rest of the project still mirrors");
});

test("a symlink to a directory OUTSIDE the project is refused, not an EISDIR crash", { skip: !LINKS.dir }, () => {
  const { proj, outside } = linkedTree();
  link(join(proj, "linked-dir"), join(outside, "dir"), "dir");

  const { unsafe } = symlinkScan(proj, { exclude: NEVER_SHIP });
  assert.deepEqual(unsafe.map((u) => u.rel), ["linked-dir"]);

  const dest = join(mkdtempSync(join(tmpdir(), "hdd-link-dst-")), "out");
  const copied = copyTree(proj, dest, { exclude: NEVER_SHIP });   // must not throw
  assert.ok(!copied.some((f) => f.startsWith("linked-dir")));
  assert.ok(!existsSync(join(dest, "linked-dir", "unrelated.txt")));
});

test("a symlink to a file INSIDE the project is followed and materialized", { skip: !LINKS.file }, () => {
  const { proj } = linkedTree();
  link(join(proj, "alias.css"), join(proj, "real", "inside.css"), "file");

  const { unsafe, followed } = symlinkScan(proj, { exclude: NEVER_SHIP });
  assert.equal(unsafe.length, 0);
  assert.deepEqual(followed.map((l) => l.rel), ["alias.css"]);
  assert.ok(walk(proj, { exclude: NEVER_SHIP }).includes("alias.css"));

  const dest = join(mkdtempSync(join(tmpdir(), "hdd-link-dst-")), "out");
  copyTree(proj, dest, { exclude: NEVER_SHIP });
  assert.equal(readFileSync(join(dest, "alias.css"), "utf8"), "body{}",
    "materialized as its target's content — the bundle must stay self-contained");
  assert.ok(!lstatSync(join(dest, "alias.css")).isSymbolicLink(), "and as a real file, not a link");
});

test("a symlink to a directory INSIDE the project is walked into", { skip: !(LINKS.dir || LINKS.junction) }, () => {
  const { proj } = linkedTree();
  link(join(proj, "_ds_alias"), join(proj, "real"), LINKS.dir ? "dir" : "junction");

  const { unsafe } = symlinkScan(proj, { exclude: NEVER_SHIP });
  assert.equal(unsafe.length, 0);

  const files = walk(proj, { exclude: NEVER_SHIP });
  assert.ok(files.includes("_ds_alias/inside.css"), "the alias dir's contents are mirrored");
  assert.ok(files.includes("_ds_alias/nested/deep.js"), "recursively");

  const dest = join(mkdtempSync(join(tmpdir(), "hdd-link-dst-")), "out");
  copyTree(proj, dest, { exclude: NEVER_SHIP });
  assert.equal(readFileSync(join(dest, "_ds_alias", "nested", "deep.js"), "utf8"), "//deep");
});

test("a dangling symlink is refused, not silently dropped", { skip: !LINKS.file }, () => {
  const { proj } = linkedTree();
  link(join(proj, "gone.css"), join(proj, "real", "never-existed.css"), "file");

  const { unsafe } = symlinkScan(proj, { exclude: NEVER_SHIP });
  assert.deepEqual(unsafe.map((u) => [u.rel, u.reason]), [["gone.css", "does not resolve"]]);
});

test("a symlink cannot smuggle an excluded path past NEVER_SHIP", { skip: !LINKS.file }, () => {
  const { proj } = linkedTree();
  link(join(proj, "innocent.js"), join(proj, "node_modules", "junk.js"), "file");

  const { unsafe } = symlinkScan(proj, { exclude: NEVER_SHIP });
  assert.equal(unsafe.length, 0, "it resolves inside the project, so it is not an I9 escape");
  assert.ok(!walk(proj, { exclude: NEVER_SHIP }).includes("innocent.js"),
    "but the exclude list applies to the TARGET — otherwise a link is a way around it");
});

test("a symlink loop terminates instead of recursing forever", { skip: !(LINKS.dir || LINKS.junction) }, () => {
  const { proj } = linkedTree();
  link(join(proj, "real", "loop"), proj, LINKS.dir ? "dir" : "junction");

  const files = walk(proj, { exclude: NEVER_SHIP });   // must return, not blow the stack
  assert.ok(files.includes("Landing.dc.html"));
  assert.ok(files.every((f) => (f.match(/loop/g) ?? []).length <= 1), "no runaway repetition");
});

test("the symlink suite actually ran somewhere", () => {
  assert.ok(LINKS.file || LINKS.dir || LINKS.junction,
    "no symlink kind could be created — I9 coverage would be vacuous on this machine");
});

/* ── I10: every advertised option is wired to behaviour ─────────────────────
 * `depth` shipped for three releases as a declared manifest input that phase 00
 * wrote into state and nothing ever read. The gate is structural, so the next
 * unwired input fails here rather than in a reviewer's hands. */

test("every input declared in open-design.json is read back by a script", () => {
  const here = join(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(here, "open-design.json"), "utf8"));
  const inputs = (manifest.od?.inputs ?? manifest.inputs ?? []).map((i) => i.name);
  assert.ok(inputs.length, "the manifest declares inputs");

  const src = readdirSync(join(here, "scripts"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(here, "scripts", f), "utf8"))
    .join("\n");

  const unread = inputs.filter((n) => !new RegExp(`options\\.${n}\\b`).test(src));
  assert.deepEqual(unread, [], `declared but never read: ${unread.join(", ")}`);
});

/* ── the silent-corruption regression ──────────────────────────────────────
 * GNU tar accepts `-a -c -f out.zip` and writes a TAR. Without a magic-byte
 * check the pipeline ships an archive nothing can open. */

test("archive writes a real zip, verified by magic bytes", () => {
  const parent = mkdtempSync(join(tmpdir(), "hdd-zip-"));
  mkdirSync(join(parent, "bundle", "project"), { recursive: true });
  writeFileSync(join(parent, "bundle", "README.md"), "# hi");
  writeFileSync(join(parent, "bundle", "project", "a.html"), "<h1>a</h1>");

  const out = join(parent, "Some Name-handoff.zip");
  archive(parent, "bundle", out);

  const magic = readFileSync(out).readUInt32LE(0);
  assert.equal(magic, 0x04034b50, "not a zip — a tar-named-.zip would pass a naive check");
  assert.ok(archiveEntryCount(out) >= 2);
});

/* ── the writer has to survive real bundle content ──────────────────────────
 * Both formats are written in-process now, so these cases are ours to get right:
 * a non-ASCII name (ustar has no charset field — the first cut came out mojibake
 * through bsdtar), a path past tar's 100-byte name field, an empty file, binary
 * bytes, and a file so small that deflate makes it bigger. */

function awkwardTree() {
  const parent = mkdtempSync(join(tmpdir(), "hdd-awkward-"));
  const deep = join(parent, "bundle", "a", "very", "deeply", "nested", "directory",
    "chain", "that", "pushes", "the", "path", "past", "one", "hundred", "bytes");
  mkdirSync(deep, { recursive: true });
  const files = {
    "README.md": Buffer.from("# hi\n"),
    "unicode-файл-ünïcode.txt": Buffer.from("naïve café 設計\n", "utf8"),
    "empty.txt": Buffer.alloc(0),
    "tiny.txt": Buffer.from("x"),                              // deflate would grow it
    "binary.woff2": Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 37) % 256)),
  };
  for (const [name, data] of Object.entries(files)) writeFileSync(join(parent, "bundle", name), data);
  files[`a/very/deeply/nested/directory/chain/that/pushes/the/path/past/one/hundred/bytes/deep-файл.txt`] =
    Buffer.from("deep\n");
  writeFileSync(join(deep, "deep-файл.txt"), files[Object.keys(files).pop()]);
  return { parent, files };
}

for (const ext of ["zip", "tar.gz"]) {
  test(`${ext} round-trips unicode names, long paths, empty and binary files`, () => {
    const { parent, files } = awkwardTree();
    const out = join(parent, `Awkward Name-handoff.${ext}`);
    archive(parent, "bundle", out);

    const got = archiveContents(out);
    for (const [rel, data] of Object.entries(files)) {
      const key = `bundle/${rel}`;
      assert.ok(got.has(key), `${ext}: ${rel} missing — got ${[...got.keys()].join(", ")}`);
      assert.deepEqual(got.get(key), data, `${ext}: ${rel} content differs`);
    }
    assert.equal(got.size, Object.keys(files).length);
  });
}

test("the zip is a real zip by signature, and stores what deflate would enlarge", () => {
  const { parent } = awkwardTree();
  const out = join(parent, "z.zip");
  archive(parent, "bundle", out);
  const buf = readFileSync(out);
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  // `tiny.txt` is one byte: deflate adds framing, so the writer must store it.
  const methods = new Set();
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf.readUInt32LE(i) === 0x02014b50) methods.add(buf.readUInt16LE(i + 10));
  }
  assert.ok(methods.has(0), "at least one entry stored rather than deflated");
});

test("archive writes a gzip for tar.gz, even from a path with spaces and a drive letter", () => {
  const parent = mkdtempSync(join(tmpdir(), "hod tgz "));
  mkdirSync(join(parent, "bundle"), { recursive: true });
  writeFileSync(join(parent, "bundle", "README.md"), "# hi");

  const out = join(parent, "Some Name-handoff.tar.gz");
  archive(parent, "bundle", out);

  const head = readFileSync(out);
  assert.equal(head[0], 0x1f);
  assert.equal(head[1], 0x8b);
  assert.ok(archiveEntryCount(out) >= 1);
});

/* ── gates ─────────────────────────────────────────────────────────────────── */

test("advisories do not block, but --strict promotes them", () => {
  const soft = new Gates("t");
  soft.check("hard", true);
  soft.warn("soft", false, "source's fault");
  assert.equal(soft.passed, true);
  assert.match(soft.report(), /WARN {2}soft/);

  const strict = new Gates("t", { strict: true });
  strict.warn("soft", false);
  assert.equal(strict.passed, false);
  assert.match(strict.report(), /FAIL {2}soft/);
});

test("a failed hard gate always blocks", () => {
  const g = new Gates("t");
  g.check("hard", false, "broken");
  assert.equal(g.passed, false);
  assert.match(g.report(), /BLOCKED/);
});

test("args parses flags, values and bare positionals", () => {
  assert.deepEqual(args(["--a", "1", "--flag", "--b", "two words", "pos"]),
    { _: ["pos"], a: "1", flag: true, b: "two words" });
});
