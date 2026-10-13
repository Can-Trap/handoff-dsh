// dsh/index.js — the receiving end of a handoff-dsh bundle, as a DeepSeek Harness
// Host plugin.
//
// Zero dependencies, and deliberately NO import of the sender's scripts/_lib.js.
// The sender hashes a tree, archives it, and hands the archive over; if the
// receiver verified it with the same code, a bug in that code would vouch for
// itself. This side reads the ZIP/gzip container, the central directory and the
// CRCs itself, so "the archive holds exactly these bytes" is a claim two
// independent implementations agree on rather than one implementation asserting.
//
// It also does something the sender cannot: it refuses to extract an entry whose
// name would land outside the extraction root. The sender's I9 policy governs what
// it mirrors; this governs what it accepts, which is a different threat.

import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, existsSync,
  statSync, rmSync,
} from "node:fs";
import { join, dirname, resolve, sep, relative, isAbsolute, basename } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync, inflateRawSync } from "node:zlib";

/** Loader identity. */
export const name = "handoff-dsh";

/** Services used by the receiving tools. */
export const inject = ["tools"];

/* ── limits ─────────────────────────────────────────────────────────────────
 * A handoff bundle is a design project: a few thousand files and tens of MB. The
 * caps are here so a crafted archive cannot turn inspection into a memory
 * exhaustion, not because a real bundle approaches them. */

const MAX_ENTRIES = 20000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

/* ── crc32 ───────────────────────────────────────────────────────────────── */

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  CRC_TABLE = t;
  return t;
}

function crc32(buf) {
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ── containers ───────────────────────────────────────────────────────────── */

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

/**
 * Read every regular file out of a ZIP, verifying each entry's CRC against the
 * one the central directory declares.
 *
 * @param buf - the complete archive.
 * @returns entry name -> `{ data, mode }`. `mode` is the unix mode from the
 *   central directory's external attributes, or 0 for an entry written by a
 *   tool that recorded none.
 */
function readZip(buf) {
  // The EOCD sits at the end, after a comment of up to 64 KiB. Scan back for it.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("not a zip: no end-of-central-directory record");

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > buf.length) throw new Error("zip central directory runs past the end of the file");
  if (count > MAX_ENTRIES) throw new Error(`zip declares ${count} entries, over the ${MAX_ENTRIES} limit`);

  const files = new Map();
  let total = 0;
  let p = cdOffset;

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== ZIP_CENTRAL) {
      throw new Error(`corrupt central directory entry ${i}`);
    }
    const method = buf.readUInt16LE(p + 10);
    const wantCrc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const mode = (buf.readUInt32LE(p + 38) >>> 16) & 0xffff;
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith("/")) continue;

    // Zip64 keeps the real values in an extra field. Refuse rather than verify
    // the wrong bytes — a bundle that large is a different problem.
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`zip64 entry not supported: ${rawName}`);
    }
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== ZIP_LOCAL) {
      throw new Error(`corrupt local header for ${rawName}`);
    }
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + compSize > buf.length) throw new Error(`entry data runs past the end of the file: ${rawName}`);

    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`unsupported compression ${method} for ${rawName}`);

    if (data.length !== uncompSize) {
      throw new Error(`entry ${rawName} inflated to ${data.length} bytes, header says ${uncompSize}`);
    }
    if (crc32(data) !== wantCrc) {
      throw new Error(`entry ${rawName} failed its CRC — the archive is corrupt`);
    }

    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error(`archive expands past the ${MAX_TOTAL_BYTES} byte limit`);

    const clean = rawName.replace(/^\.\//, "");
    files.set(clean, { data, mode });
  }
  return files;
}

/** NUL-terminated utf8 field. */
function cstr(buf, off, len) {
  const s = buf.subarray(off, off + len);
  const end = s.indexOf(0);
  return s.toString("utf8", 0, end === -1 ? s.length : end);
}

/**
 * Read every regular file out of a `.tar.gz`, honouring the GNU long-name and pax
 * path headers that carry names ustar cannot hold.
 *
 * @param gz - the gzip container's bytes.
 * @returns entry name -> `{ data, mode }`.
 */
function readTarGz(gz) {
  const buf = gunzipSync(gz);
  const files = new Map();
  let override = null;   // a pending name from a GNU 'L' or pax 'x'/'g' header
  let total = 0;
  let count = 0;

  for (let p = 0; p + 512 <= buf.length;) {
    const head = buf.subarray(p, p + 512);
    if (head.every((b) => b === 0)) break;

    const size = parseInt(cstr(head, 124, 12).trim() || "0", 8) || 0;
    const mode = parseInt(cstr(head, 100, 8).trim() || "0", 8) || 0;
    const type = String.fromCharCode(head[156] || 0x30);
    const dataStart = p + 512;
    const next = dataStart + Math.ceil(size / 512) * 512;

    if (type === "L") { override = cstr(buf, dataStart, size); p = next; continue; }
    if (type === "x" || type === "X" || type === "g") {
      const rec = buf.toString("utf8", dataStart, dataStart + size);
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(rec);
      if (m) override = m[1];
      p = next; continue;
    }

    const prefix = cstr(head, 345, 155);
    const raw = cstr(head, 0, 100);
    const entryName = (override ?? (prefix ? `${prefix}/${raw}` : raw)).replace(/^\.\//, "");
    override = null;

    // '0'/'\0' are regular files; '2' is a symlink and is reported, never followed.
    if (type === "0" || type === "\0" || type === "2") {
      const data = Buffer.from(buf.subarray(dataStart, dataStart + size));
      total += data.length;
      if (total > MAX_TOTAL_BYTES) throw new Error(`archive expands past the ${MAX_TOTAL_BYTES} byte limit`);
      if (++count > MAX_ENTRIES) throw new Error(`archive holds more than ${MAX_ENTRIES} entries`);
      if (!entryName.endsWith("/")) files.set(entryName, { data, mode: type === "2" ? S_IFLNK | 0o777 : mode });
    }
    p = next;
  }
  return files;
}

/* ── entry-name policy ────────────────────────────────────────────────────── */

/**
 * The receiver's own gate: an entry name is a PATH, and a path from an archive is
 * untrusted input. `../`, a leading `/`, a drive letter, or a backslash (which
 * Windows would read as a separator even though ZIP says `/`) all let an archive
 * choose where it writes.
 *
 * @param entryName - the name as the archive carries it.
 * @returns The reason to refuse, or `null` when the name is safe.
 */
function entryNameProblem(entryName) {
  if (!entryName) return "empty entry name";
  if (entryName.includes("\0")) return "entry name contains a NUL";
  if (entryName.includes("\\")) return "entry name contains a backslash";
  if (entryName.startsWith("/")) return "entry name is absolute";
  if (/^[A-Za-z]:/.test(entryName)) return "entry name carries a drive letter";
  if (entryName.split("/").some((s) => s === "..")) return "entry name climbs out with ..";
  return null;
}

/* ── loading a deliverable ────────────────────────────────────────────────── */

const posix = (p) => String(p).split(sep).join("/");

/** Point at a `.zip`, a `.tar.gz`, or an already-extracted bundle directory. */
function load(target) {
  if (!existsSync(target)) throw new Error(`no such file or directory: ${target}`);

  if (statSync(target).isDirectory()) {
    return { kind: "directory", source: target, ...loadDirectory(target) };
  }

  const buf = readFileSync(target);
  if (buf.length >= 4 && buf.readUInt32LE(0) === ZIP_LOCAL) {
    return { kind: "zip", source: target, ...splitRoot(readZip(buf)) };
  }
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return { kind: "tar.gz", source: target, ...splitRoot(readTarGz(buf)) };
  }
  throw new Error(
    `${basename(target)} is neither a zip (PK\\x03\\x04) nor a gzip stream — ` +
    `a .zip written by GNU tar is a tar with a .zip name, and this refuses it rather than guess`);
}

function loadDirectory(dir) {
  const files = new Map();
  const links = [];
  const base = resolve(dir);
  (function rec(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      const rel = posix(relative(base, abs));
      if (e.isSymbolicLink()) { links.push(rel); continue; }
      if (e.isDirectory()) { rec(abs); continue; }
      if (e.isFile()) files.set(rel, { data: readFileSync(abs), mode: S_IFREG | 0o644 });
    }
  })(base);
  return { entries: files, links, rejected: [] };
}

/**
 * Every entry must live under one top-level directory — the bundle root, which is
 * the project slug. Two roots would mean the archive is not a handoff bundle.
 *
 * An entry whose NAME is rejected is recorded rather than dropped. Dropping it
 * quietly would let `../outside.txt` vanish from the tree under inspection and
 * leave the escape gate with nothing to report — a receiver that silently ignores
 * a path-traversal attempt reports a clean archive.
 */
function splitRoot(entries) {
  const roots = new Set();
  const rejected = [];
  for (const entryName of entries.keys()) {
    const problem = entryNameProblem(entryName);
    if (problem) { rejected.push(`${entryName} (${problem})`); continue; }
    roots.add(entryName.split("/")[0]);
  }
  if (roots.size === 0 && rejected.length === 0) throw new Error("the archive carries no readable entries");
  if (roots.size > 1) {
    throw new Error(`the archive has ${roots.size} top-level directories (${[...roots].sort().slice(0, 5).join(", ")}) — a handoff bundle has exactly one`);
  }
  const root = [...roots][0] ?? "";
  const files = new Map();
  for (const [entryName, value] of entries) {
    if (root && entryName.startsWith(`${root}/`)) files.set(entryName.slice(root.length + 1), value);
  }
  return { root, entries: files, links: [], rejected };
}

/* ── the bundle contract, re-checked ──────────────────────────────────────── */

const ROOT_ALLOWED = new Set(["README.md", "AGENTS.md", "CLAUDE.md"]);
const ROOT_ALLOWED_PREFIX = ["project/", "chats/"];
const SYNC_BOOKKEEPING = /(^|\/)(_ds_sync\.json|_ods_sync\.json|_ods_needs_recompile)$/;
const RE_SUFFIXED = /\.(jsx|d\.ts)\.txt$/i;
const UUID_DIR = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Top-level names that are never part of a bundle.
 *
 * `ROOT_ALLOWED_PREFIX` entries are directories, and a top-level name list holds
 * the bare directory name (`project`), not a path into it — so both spellings have
 * to be accepted or a perfectly ordinary bundle fails its own purity gate.
 */
const rootPurityOffenders = (names) =>
  names.filter((n) => {
    if (ROOT_ALLOWED.has(n)) return false;
    return !ROOT_ALLOWED_PREFIX.some((p) => n === p.replace(/\/$/, "") || n.startsWith(p));
  });

function verifyBundle(loaded) {
  const gates = [];
  const add = (name, ok, detail = "") => gates.push({ name, ok: !!ok, detail });

  const names = [...loaded.entries.keys()].sort();
  const topLevel = [...new Set(names.map((n) => n.split("/")[0]))];
  const readme = loaded.entries.get("README.md")?.data.toString("utf8") ?? null;

  // Names first: everything below is a statement about a tree we agreed to accept.
  // `rejected` carries the names the loader refused to even index, so an archive
  // that TRIED to escape is reported rather than merely not extracted.
  const rejected = loaded.rejected ?? [];
  const bad = names.filter((n) => entryNameProblem(n));
  add("no entry escapes the extraction root", bad.length === 0 && rejected.length === 0,
    [...rejected, ...bad].slice(0, 5).join(", ") || `${names.length} entries`);

  const links = loaded.links ?? [];
  const linkEntries = names.filter((n) => {
    const m = loaded.entries.get(n).mode & S_IFMT;
    return m === S_IFLNK;
  });
  add("no symlinks in the bundle — I9", links.length === 0 && linkEntries.length === 0,
    [...links, ...linkEntries].slice(0, 5).join(", ") || "none");

  add("README is the instruction carrier",
    !!readme && /^#\s+CODING AGENTS/m.test(readme),
    readme ? (readme.split("\n")[0] || "").slice(0, 60) : "README.md missing");

  const unfilled = readme ? (readme.match(/\{\{[A-Z_]+\}\}/g) ?? []) : [];
  add("no unfilled README slots", unfilled.length === 0, [...new Set(unfilled)].join(", "));

  add("root purity", rootPurityOffenders(topLevel).length === 0,
    topLevel.sort().join(", "));

  const inProject = names.filter((n) => n.startsWith("project/"));
  add("project/ is present and non-empty — I1", inProject.length > 0, `${inProject.length} files`);

  const sync = names.filter((n) => SYNC_BOOKKEEPING.test(n));
  add("no sync bookkeeping — I4", sync.length === 0, sync.slice(0, 5).join(", "));

  const resuffixed = names.filter((n) => RE_SUFFIXED.test(n));
  add("no re-suffixed sources — I1", resuffixed.length === 0, resuffixed.slice(0, 5).join(", "));

  // I3 — the HTML loads the short alias, the components live in the canonical
  // directory, and BOTH must ship.
  const dsDirs = [...new Set(names
    .map((n) => /^project\/_ds\/([^/]+)\//.exec(n)?.[1])
    .filter(Boolean))];
  const canonical = dsDirs.find((d) => UUID_DIR.test(d));
  const aliases = dsDirs.filter((d) => d !== canonical);
  const aliasOk = !canonical || aliases.every((a) =>
    names.includes(`project/_ds/${a}/_ds_bundle.css`) || names.includes(`project/_ds/${a}/_ds_bundle.js`));
  add("design-system alias present — I3", aliasOk,
    canonical ? `canonical ${canonical}, ${aliases.length} alias(es)` : "no design system");

  // I7 — a malformed adherence config is worse than an absent one, because it looks
  // like enforcement.
  const adherence = names.filter((n) => n.endsWith("_adherence.oxlintrc.json"));
  let adherenceOk = true;
  let adherenceDetail = adherence.length ? `${adherence.length} config(s)` : "none bound";
  for (const n of adherence) {
    try { JSON.parse(loaded.entries.get(n).data.toString("utf8")); }
    catch (err) { adherenceOk = false; adherenceDetail = `${n}: ${err.message}`; break; }
  }
  add("adherence config parses — I7", adherenceOk, adherenceDetail);

  return { gates, names };
}

/**
 * The sender's tree digest, recomputed here from the deliverable's own bytes.
 *
 * Byte-for-byte the same algorithm phase 03 uses — content only, no mtimes — so
 * the value is directly comparable with `.handoff/validate.json` and with
 * `.handoff/archive.json`. Passing the verdict in turns that comparison into a
 * gate; leaving it out still reports the digest, which is the honest minimum.
 */
function treeHash(entries) {
  const names = [...entries.keys()].sort();
  const h = createHash("sha256");
  const digests = {};
  for (const rel of names) {
    const sha = createHash("sha256").update(entries.get(rel).data).digest("hex");
    digests[rel] = sha;
    h.update(rel, "utf8");
    h.update("\0");
    h.update(sha, "hex");
    h.update("\n");
  }
  return { hash: h.digest("hex"), digests, names };
}

/** Bind the deliverable to the verdict the sender wrote, when one is supplied. */
function bindVerdict(gates, loaded, verdictPath) {
  if (!verdictPath) return null;
  let verdict;
  try { verdict = JSON.parse(readFileSync(verdictPath, "utf8")); }
  catch (err) { gates.push({ name: "sender verdict readable", ok: false, detail: err.message }); return null; }

  if (verdict.root && verdict.root !== loaded.root) {
    gates.push({ name: "sender verdict describes this bundle", ok: false,
      detail: `verdict is for ${verdict.root}/, archive holds ${loaded.root}/` });
    return null;
  }
  gates.push({ name: "sender verdict describes this bundle", ok: true, detail: verdict.root ?? loaded.root });

  const { hash, digests } = treeHash(loaded.entries);
  gates.push({ name: "tree digest matches the sender's verdict — I8", ok: hash === verdict.treeHash,
    detail: hash === verdict.treeHash ? hash.slice(0, 16) : `verdict ${String(verdict.treeHash).slice(0, 16)} vs archive ${hash.slice(0, 16)}` });

  const expected = verdict.digests ?? {};
  const missing = Object.keys(expected).filter((k) => !(k in digests));
  const extra = Object.keys(digests).filter((k) => !(k in expected));
  const altered = Object.keys(expected).filter((k) => k in digests && digests[k] !== expected[k]);
  const ok = missing.length === 0 && extra.length === 0 && altered.length === 0;
  gates.push({ name: "every file is byte-identical to the verdict", ok,
    detail: ok ? `${Object.keys(expected).length} files` :
      [missing.length && `${missing.length} missing`, extra.length && `${extra.length} unexpected`,
        altered.length && `${altered.length} altered`].filter(Boolean).join(", ") });
  return { hash, digests };
}

/* ── shared shapes ────────────────────────────────────────────────────────── */

const text = (s) => [{ type: "text", text: s }];
const gateLine = (g) => `  ${g.ok ? "PASS" : "FAIL"}  ${g.name}${g.detail ? ` — ${g.detail}` : ""}`;
const gateReport = (label, gates) =>
  `[${label}] ${gates.every((g) => g.ok) ? "DONE" : "BLOCKED"}\n${gates.map(gateLine).join("\n")}`;

const GATE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      ok: { type: "boolean" },
      detail: { type: "string" },
    },
    required: ["name", "ok", "detail"],
  },
};

/** Resolve an optional path argument against the session working directory. */
const abspath = (p) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

/* ── tools ────────────────────────────────────────────────────────────────── */

function inspectTool() {
  return {
    name: "handoff_inspect",
    description:
      "Verify an Open Design handoff bundle before trusting it: a `<Project>-handoff.zip`, " +
      "a `.tar.gz`, or an already-extracted bundle directory. Reads the container itself " +
      "(ZIP central directory and CRCs, or ustar/pax headers) rather than shelling out, " +
      "re-checks the bundle contract, and reports the tree digest. Pass `verdict` with the " +
      "sender's `.handoff/validate.json` to prove the archive still holds exactly the bytes " +
      "that were validated. Writes nothing.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Archive or extracted bundle directory to verify.",
      },
      verdict: {
        type: "string",
        description: "Optional path to the sender's `.handoff/validate.json`, to bind the archive to the validated tree.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          kind: { type: "string" },
          root: { type: "string" },
          fileCount: { type: "number" },
          bytes: { type: "number" },
          treeHash: { type: "string" },
          gates: GATE_SCHEMA,
          names: { type: "array", items: { type: "string" } },
        },
        required: ["ok", "kind", "root", "fileCount", "bytes", "treeHash", "gates", "names"],
      },
      render(args, value) {
        const head =
          `${value.ok ? "Verified" : "REFUSED"} ${value.kind}: ${value.root}/ — ` +
          `${value.fileCount} files, ${(value.bytes / 1024).toFixed(1)} KB\n` +
          `tree ${value.treeHash.slice(0, 16)}\n`;
        return text(head + gateReport("handoff_inspect", value.gates));
      },
    },
    async execute(argv) {
      const loaded = load(abspath(argv.path));
      const { gates, names } = verifyBundle(loaded);
      const binding = bindVerdict(gates, loaded, argv.verdict ? abspath(argv.verdict) : null);
      const { hash } = binding ?? treeHash(loaded.entries);
      const bytes = [...loaded.entries.values()].reduce((n, e) => n + e.data.length, 0);
      return {
        ok: gates.every((g) => g.ok),
        kind: loaded.kind,
        root: loaded.root,
        fileCount: loaded.entries.size,
        bytes,
        treeHash: hash,
        gates,
        names: names.slice(0, 400),
      };
    },
  };
}

function importTool() {
  return {
    name: "handoff_import",
    description:
      "Import an Open Design handoff bundle: verify it, then extract every entry verbatim into " +
      "a directory. Refuses on any failed gate, refuses an entry whose name would land outside " +
      "the target, and refuses to write into a non-empty target unless `force` is true. " +
      "Nothing is renamed, re-suffixed or reformatted.",
    parameters: {
      archive: {
        type: "string",
        required: true,
        description: "The `<Project>-handoff.zip` or `.tar.gz` to import.",
      },
      into: {
        type: "string",
        required: true,
        description: "Directory to extract into. The bundle root is created inside it.",
      },
      force: {
        type: "boolean",
        description: "Extract even when the target already exists and is not empty. Omitted means refuse.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          root: { type: "string" },
          dest: { type: "string" },
          extracted: { type: "number" },
          bytes: { type: "number" },
          treeHash: { type: "string" },
          gates: GATE_SCHEMA,
        },
        required: ["root", "dest", "extracted", "bytes", "treeHash", "gates"],
      },
      render(args, value) {
        return text(
          `Imported ${value.extracted} files (${(value.bytes / 1024).toFixed(1)} KB) to ` +
          `${value.dest}\ntree ${value.treeHash.slice(0, 16)}\n\n` +
          `Read \`${value.root}/README.md\` in full — it is the instruction carrier.\n\n` +
          gateReport("handoff_import", value.gates));
      },
    },
    async execute(argv) {
      const loaded = load(abspath(argv.archive));
      if (loaded.kind === "directory") {
        throw new Error(`${basename(abspath(argv.archive))} is already a directory — use handoff_inspect, or handoff_import on the archive`);
      }

      const { gates } = verifyBundle(loaded);
      const failed = gates.filter((g) => !g.ok);
      if (failed.length) {
        throw new Error(
          `refusing to extract — ${failed.length} gate(s) failed:\n${failed.map(gateLine).join("\n")}`);
      }

      const into = resolve(abspath(argv.into));
      const dest = join(into, loaded.root);

      if (existsSync(into) && !argv.force) {
        let existing = [];
        try { existing = readdirSync(into); } catch { existing = []; }
        if (existing.length) {
          throw new Error(`${into} is not empty (${existing.slice(0, 5).join(", ")}) — pass force to extract anyway`);
        }
      }
      // `--force` replaces the bundle it names, never the directory around it. This
      // is the same guard the sender applies to its own recursive delete.
      if (existsSync(dest)) {
        if (!argv.force) throw new Error(`${dest} already exists — pass force to replace it`);
        rmSync(dest, { recursive: true, force: true });
      }

      let bytes = 0;
      let extracted = 0;
      for (const [rel, entry] of loaded.entries) {
        // Belt and braces: `verifyBundle` already gated on this, and the cost of
        // being wrong is a write outside the target.
        const problem = entryNameProblem(rel);
        if (problem) throw new Error(`refusing ${rel}: ${problem}`);
        const abs = resolve(dest, rel);
        if (abs !== dest && !abs.startsWith(dest + sep)) {
          throw new Error(`refusing ${rel}: resolves outside ${dest}`);
        }
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, entry.data);
        bytes += entry.data.length;
        extracted++;
      }

      return { root: loaded.root, dest, extracted, bytes, treeHash: treeHash(loaded.entries).hash, gates };
    },
  };
}

function briefTool() {
  return {
    name: "handoff_brief",
    description:
      "Surface the brief a handoff bundle carries. The generated `README.md` is the bundle's " +
      "sole instruction carrier — its reading order, its 'do not screenshot' rule and its " +
      "'ask before you build' rule are the whole point of the handoff. Returns it verbatim, " +
      "plus the entry file it names and what else the bundle holds.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "The bundle directory or archive to read the brief from.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          root: { type: "string" },
          readme: { type: "string" },
          entryFile: { type: "string" },
          topLevel: { type: "array", items: { type: "string" } },
          designSystem: { type: "string" },
        },
        required: ["root", "readme", "entryFile", "topLevel", "designSystem"],
      },
      render(args, value) {
        return text(
          `Brief for ${value.root}/ — read every line before you write code.\n\n` +
          `entry file: ${value.entryFile || "(not stated)"}\n` +
          `design system: ${value.designSystem || "none bound"}\n\n` +
          "──────── README.md ────────\n" + value.readme);
      },
    },
    async execute(argv) {
      const loaded = load(abspath(argv.path));
      const readme = loaded.entries.get("README.md")?.data.toString("utf8");
      if (!readme) throw new Error(`${loaded.root}/ carries no README.md — it is the instruction carrier, so without it there is no brief`);
      // The README writes `<slug>/project/<file>`. `<slug>` may itself contain
      // "project", so the capture must not accept a `/`: without that, a bare
      // /project\/([^\s`]+)/ matches at the `-project/` inside `fixture-project/`
      // and swallows the real path into its own capture.
      const found = [...readme.matchAll(/project\/([^\s`/]+\.(?:dc\.html|html))/gi)].map((m) => m[1]);
      const entryFile = found[0] ?? "";
      const dsDirs = [...new Set([...loaded.entries.keys()]
        .map((n) => /^project\/_ds\/([^/]+)\//.exec(n)?.[1])
        .filter(Boolean))];
      return {
        root: loaded.root,
        readme,
        entryFile,
        topLevel: [...new Set([...loaded.entries.keys()].map((n) => n.split("/")[0]))].sort(),
        designSystem: dsDirs.length ? `project/_ds/{${dsDirs.sort().join(", ")}}` : "",
      };
    },
  };
}

/**
 * Register the three receiving tools.
 * @param ctx - agent-scoped services carrying the tool registry.
 */
export function apply(ctx) {
  for (const tool of [inspectTool(), importTool(), briefTool()]) ctx.tools.register(tool);
}
