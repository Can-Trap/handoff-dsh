// scripts/_lib.js — shared helpers for the handoff-dsh pipeline.
// Zero dependencies. Node >= 20. Never calls MCP; the agent passes OD facts in.
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync,
  existsSync, statSync, realpathSync, rmSync,
} from "node:fs";
import { join, dirname, basename, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync, inflateRawSync, deflateRawSync } from "node:zlib";

export const STATE_DIR = ".handoff";
export const STATE_PATH = join(STATE_DIR, "state.json");

/* ── paths & io ─────────────────────────────────────────────────────────── */

/** Lower-kebab slug. `Studio CSS - Base Set` -> `studio-css-base-set`. */
export function slugify(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Non-empty slug, for the places a slug becomes a directory name.
 *
 * `slugify` legitimately returns `""` for a name written entirely outside
 * `[a-z0-9]` — `设计`, `дизайн`, `🎨` — and an empty slug is not a cosmetic
 * problem: `join(root, "")` IS `root`. Fall back to a digest of the original
 * name so such a project still gets a directory of its own that is stable
 * across runs (so `--force` can rebuild it) and distinct from its neighbours
 * (so two differently-named projects never share one).
 */
export function slugSafe(name, prefix = "project") {
  return slugify(name) ||
    `${prefix}-${createHash("sha256").update(String(name ?? ""), "utf8").digest("hex").slice(0, 8)}`;
}

/**
 * The `design_handoff_<slug>` directory name for a feature scope.
 *
 * Shared because three phases derive it independently — 02 creates the folder, 01
 * has to find it to nest it, 03 has to find it to validate it — and a second
 * implementation is a second chance for them to disagree about where it lives.
 */
export const featureSlug = (feature) => slugSafe(feature, "feature").replace(/-/g, "_");
export const featureDirName = (feature) => `design_handoff_${featureSlug(feature)}`;

/**
 * The archive's basename, derived from the project's DISPLAY name.
 *
 * Shared because two phases name the same file independently — 04 writes
 * `<base>-handoff.zip`, and the zip prompt tells the receiving agent which file
 * to look for. Upstream derived it twice: 04 sanitized the name, the prompt's
 * fallback did not, so a project called `My App: v2` produced an archive named
 * `My App v2-handoff.zip` and a prompt naming `My App: v2-handoff.zip`. One
 * helper, one answer.
 */
export const archiveBase = (name, slug) =>
  String(name ?? "").replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "") ||
  slug;

/** A spec README still carrying scaffold markers is not an authored spec. */
export const TODO_MARKER = /\bTODO\b/;

/**
 * A directory that MUST be a strict descendant of `root`. Guards every path the
 * pipeline later deletes or writes a whole tree into.
 *
 * The name arrives from `.handoff/state.json`, which is on disk, hand-editable,
 * and may have been written by an older release — so validating it once at the
 * point it was produced is not enough. An empty, `.`, `..`-escaping or absolute
 * name resolves to `root` itself or outside it, which would turn the documented
 * `--force` rebuild into a recursive delete of the user's output directory.
 */
export function childDir(root, name, label = "path") {
  const base = resolve(root);
  const target = resolve(base, String(name ?? ""));
  if (target === base) die(`refusing to use ${label} "${name}" — it resolves to the output directory itself (${base})`);
  if (!target.startsWith(base + sep)) die(`refusing to use ${label} "${name}" — it resolves outside the output directory (${target})`);
  return target;
}

/**
 * True when `rel` lands at or under `root`. The predicate form of `childDir`,
 * for the places that filter a list rather than resolve a single target.
 *
 * Resolves symlinks when the path exists, so it answers the question that
 * matters for I9 — "would reading this leave the project?" — rather than the
 * merely lexical one. Falls back to a lexical resolve for paths that do not
 * exist yet.
 */
export function isUnder(root, rel) {
  let base;
  try { base = realpathSync(root); } catch { base = resolve(root); }
  const abs = resolve(base, String(rel ?? ""));
  let real;
  try { real = realpathSync(abs); } catch { real = abs; }
  return real === base || real.startsWith(base + sep);
}

export const posix = (p) => String(p).split(sep).join("/");

export function readJson(p, fallback = null) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
}

export function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

export function writeText(p, s) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s, "utf8");
}

export const readState = (cwd = process.cwd()) => readJson(join(cwd, STATE_PATH));

export function writeState(state, cwd = process.cwd()) {
  writeJson(join(cwd, STATE_PATH), state);
  return state;
}

/* ── tree walking & mirroring ───────────────────────────────────────────── */

/**
 * One pass over a tree, classifying every entry.
 *
 * I9 — nothing outside the project directory is ever mirrored.
 *
 * A symlink is not a design file, and `Dirent.isDirectory()` is FALSE for one
 * even when it points at a directory — the Dirent describes the link, not its
 * target. An unclassified walk therefore hands every symlink to `copyFileSync`,
 * which then either
 *   - follows it and writes the TARGET's bytes into the bundle as a regular
 *     file, silently disclosing whatever lived outside the project, or
 *   - throws (EISDIR on POSIX, EPERM on Windows) for a directory link and
 *     aborts the handoff mid-mirror, leaving a partial bundle.
 *
 * The policy is applied to the RESOLVED target, not the link:
 *   - resolves under the project root -> followed, and mirrored as its target's
 *     content. Materializing rather than preserving the link is deliberate: the
 *     bundle has to stay self-contained, and zip/tar plus a Windows extract
 *     would flatten or break the link anyway.
 *   - resolves anywhere else, or does not resolve -> refused, listed by
 *     `symlinkScan().unsafe`, and hard-gated in phases 00, 01 and 03. Never
 *     silently dropped: a mirror that quietly omits a file is not verbatim.
 *
 * A link whose target is inside the root but EXCLUDED (`node_modules`, `.git`,
 * sync bookkeeping) is skipped exactly as the target itself would be —
 * otherwise a symlink is a way around `NEVER_SHIP`.
 */
function scanTree(dir, { exclude = [] } = {}) {
  const files = [];
  const unsafe = [];
  const followed = [];

  let base;
  try { base = realpathSync(dir); } catch { return { files, unsafe, followed }; }

  const excluded = (rel, name) => exclude.some((rx) => rx.test(rel) || rx.test(name));
  const inside = (real) => real === base || real.startsWith(base + sep);

  (function rec(d, stack) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      const abs = join(d, e.name);
      const rel = posix(relative(dir, abs));
      if (excluded(rel, e.name)) continue;

      if (e.isSymbolicLink()) {
        let real;
        try { real = realpathSync(abs); } catch {
          unsafe.push({ rel, target: null, reason: "does not resolve" });
          continue;
        }
        if (!inside(real)) {
          unsafe.push({ rel, target: real, reason: "resolves outside the project" });
          continue;
        }
        // Honour the exclude list against the target, so a link cannot smuggle
        // an excluded path into the bundle by pointing at it from a clean name.
        if (excluded(posix(relative(base, real)), basename(real))) continue;
        // A link back up its own branch would recurse forever.
        if (stack.includes(real)) continue;

        let st;
        try { st = statSync(abs); } catch {
          unsafe.push({ rel, target: real, reason: "does not resolve" });
          continue;
        }
        followed.push({ rel, target: real });
        if (st.isDirectory()) rec(abs, [...stack, real]);
        else if (st.isFile()) files.push(rel);
        continue;
      }

      if (e.isDirectory()) { rec(abs, stack); continue; }
      // Regular files only — a fifo, socket or device node would hang or fail
      // the copy, and is never a design file.
      if (e.isFile()) files.push(rel);
    }
  })(dir, [base]);

  const byRel = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  return { files: files.sort(), unsafe: unsafe.sort(byRel), followed: followed.sort(byRel) };
}

/**
 * Recursive relative file list, sorted. `exclude` entries are tested against
 * both the posix relative path and the bare basename. Symlinks are resolved
 * under the I9 policy above; anything it refuses is absent from this list and
 * present in `symlinkScan().unsafe`.
 */
export function walk(dir, opts) { return scanTree(dir, opts).files; }

/**
 * The symlink verdict for a tree: `followed` are links resolving inside it (safe
 * to materialize), `unsafe` are the ones the mirror refuses. An empty `unsafe`
 * is the gate condition for I9.
 */
export function symlinkScan(dir, opts) {
  const { unsafe, followed } = scanTree(dir, opts);
  return { unsafe, followed };
}

/** Human-readable I9 offender list, one per line. */
export const describeUnsafe = (unsafe) =>
  unsafe.map((u) => `  ${u.rel} -> ${u.target ?? "(unresolvable)"}  [${u.reason}]`).join("\n");

/**
 * Verbatim mirror. I1: never rename, never re-suffix, never reformat.
 * Returns the list of relative paths copied.
 *
 * Only ever copies what `scanTree` classified as a real file, so an unsafe
 * symlink cannot reach `copyFileSync` even if a caller forgot to gate on it.
 */
export function copyTree(srcDir, destDir, { exclude = [] } = {}) {
  const files = walk(srcDir, { exclude });
  for (const rel of files) {
    const to = join(destDir, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(srcDir, rel), to);
  }
  return files;
}

export const fileCount = (dir) => walk(dir).length;

/* ── archiving (in-process — no external tool at either end) ────────── */

const ZIP_MAGIC = 0x04034b50;
/* ── writing archives, in-process ───────────────────────────────────────────
 *
 * Both formats are written here rather than shelled out to `zip`, `bsdtar` or
 * `tar`. The deliverable cannot depend on a host package the plugin never declared:
 * a bare Linux box has GNU tar and neither of the others, and GNU tar's `-a` accepts
 * a `.zip` target and silently writes a TAR — so "try tools until one works" had no
 * portable branch left and failed outright.
 *
 * Writing it ourselves also finishes the argument phase 04's verification started:
 * nothing external writes the archive, and nothing external reads it back, so no
 * outside tool is trusted at either end. It removes the two platform bugs that came
 * with the old path as well — GNU tar reading `C:\…` as a remote host spec, and the
 * silent tar-named-`.zip`.
 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** DOS date/time. The format's epoch is 1980; anything older clamps to it. */
function dosStamp(date) {
  const d = date && date.getFullYear() >= 1980 ? date : new Date(1980, 0, 1);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data, mtime } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    if (data.length > 0xffffffff) throw new Error(`${name} is too large for a non-zip64 archive`);
    const deflated = deflateRawSync(data, { level: 6 });
    // Storing beats deflating when deflate made it bigger, which happens on tiny
    // or already-compressed files.
    const stored = deflated.length >= data.length;
    const payload = stored ? data : deflated;
    const { time, date } = dosStamp(mtime);
    // Bit 11 marks the name as UTF-8; without it a non-ASCII path is read as CP437.
    const flags = /^[\x20-\x7e]*$/.test(name) ? 0 : 0x800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);          // version made by
    cd.writeUInt16LE(20, 6);          // version needed
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(stored ? 0 : 8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc32(data), 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    // External attrs: unix mode 0644 in the high word. `<<` yields a signed int32
    // here, and 0o100644 << 16 overflows it — coerce back to unsigned.
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

const TAR_BLOCK = 512;
const pad = (n) => (n % TAR_BLOCK === 0 ? 0 : TAR_BLOCK - (n % TAR_BLOCK));

function tarHeader(nameBytes, size, mtime, typeflag = "0") {
  const h = Buffer.alloc(TAR_BLOCK);
  // Raw bytes, capped at the field width. Slicing the STRING would cut a multi-byte
  // character in half and write past 100 bytes.
  nameBytes.copy(h, 0, 0, Math.min(nameBytes.length, 100));
  h.write("0000644\0", 100, 8, "ascii");                       // mode
  h.write("0000000\0", 108, 8, "ascii");                       // uid
  h.write("0000000\0", 116, 8, "ascii");                       // gid
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  h.write(Math.floor((mtime?.getTime() ?? 0) / 1000).toString(8).padStart(11, "0") + "\0", 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii");                        // checksum placeholder
  h.write(typeflag, 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");

  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

/**
 * One pax record: `<len> <key>=<value>\n`, where `<len>` counts itself. Solved by
 * iteration because adding a digit to the length can change the length.
 */
function paxRecord(key, value) {
  const tail = ` ${key}=${value}\n`;
  const tailLen = Buffer.byteLength(tail, "utf8");
  let len = tailLen + 1;
  for (let i = 0; i < 4; i++) {
    const next = tailLen + String(len).length;
    if (next === len) break;
    len = next;
  }
  return Buffer.from(String(len) + tail, "utf8");
}

function buildTar(entries) {
  const parts = [];
  for (const { name, data, mtime } of entries) {
    const nameBuf = Buffer.from(name, "utf8");

    /* ustar caps the name at 100 bytes and says nothing about its encoding, so a
     * non-ASCII path is decoded with whatever legacy codepage the reader guesses —
     * bsdtar on Windows turned `файл-ünïcode.txt` into mojibake on extraction, even
     * though the bytes were intact. A pax extended header is defined as UTF-8 and
     * carries the full path, so it fixes long names and non-ASCII names at once.
     * The ustar header below still carries a truncated fallback for readers that
     * ignore pax. */
    if (nameBuf.length > 100 || !/^[\x20-\x7e]*$/.test(name)) {
      const rec = paxRecord("path", name);
      parts.push(tarHeader(Buffer.from("PaxHeaders/entry", "utf8"), rec.length, mtime, "x"),
        rec, Buffer.alloc(pad(rec.length)));
    }

    parts.push(tarHeader(nameBuf, data.length, mtime), data, Buffer.alloc(pad(data.length)));
  }
  parts.push(Buffer.alloc(TAR_BLOCK * 2));                     // end-of-archive
  return Buffer.concat(parts);
}

/**
 * Write `<parentDir>/<rootName>` to `outFile`, as zip or tar.gz by extension.
 * Entries are the tree's regular files, in walk order, so the output is stable.
 */
export function archive(parentDir, rootName, outFile) {
  const root = join(parentDir, rootName);
  const entries = walk(root).map((rel) => ({
    name: `${rootName}/${rel}`,
    data: readFileSync(join(root, rel)),
    mtime: statSync(join(root, rel)).mtime,
  }));

  const buf = outFile.toLowerCase().endsWith(".zip")
    ? buildZip(entries)
    : gzipSync(buildTar(entries), { level: 6 });

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, buf);
  return outFile;
}

/**
 * Entry count of an existing archive. Zip is read from its End-of-Central-Directory
 * record rather than shelled out, so it does not depend on which tar is on PATH.
 */
/**
 * Every regular file inside an archive, as `name -> bytes`.
 *
 * Decoded here rather than by shelling out to an extractor, for two reasons. The
 * portable one: GNU tar cannot list or read a zip, so `tar -tf` answers on Windows
 * (bsdtar) and fails on Linux. The load-bearing one: this is the check that says the
 * archive holds the bytes phase 03 approved, and running it through the same external
 * tool family that wrote the archive would let one lying tool vouch for another.
 */
function zipContents(buf) {
  const files = new Map();
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen).replace(/^\.\//, "");
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);

    if (name.endsWith("/")) continue;
    // Zip64 puts the real sizes in an extra field. Refuse rather than verify the
    // wrong bytes — a handoff bundle that large is a different problem anyway.
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`zip64 entry not supported for verification: ${name}`);
    }
    if (buf.readUInt32LE(localOffset) !== ZIP_MAGIC) {
      throw new Error(`corrupt local header for ${name}`);
    }
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(start, start + compSize);
    if (method !== 0 && method !== 8) throw new Error(`unsupported compression ${method} for ${name}`);
    files.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
  }
  return files;
}

const cstr = (buf, off, len) => {
  const s = buf.subarray(off, off + len);
  const end = s.indexOf(0);
  return s.toString("utf8", 0, end === -1 ? s.length : end);
};

function tarContents(buf) {
  const files = new Map();
  let override = null;                       // from a GNU 'L' or pax 'x' header

  for (let p = 0; p + 512 <= buf.length;) {
    const head = buf.subarray(p, p + 512);
    if (head.every((b) => b === 0)) break;

    const size = parseInt(cstr(head, 124, 12).trim() || "0", 8) || 0;
    const type = String.fromCharCode(head[156] || 0x30);
    const dataStart = p + 512;
    const next = dataStart + Math.ceil(size / 512) * 512;

    if (type === "L") {                      // GNU long name
      override = cstr(buf, dataStart, size);
      p = next; continue;
    }
    if (type === "x" || type === "X" || type === "g") {   // pax extended header
      const rec = buf.toString("utf8", dataStart, dataStart + size);
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(rec);
      if (m) override = m[1];
      p = next; continue;
    }

    const prefix = cstr(head, 345, 155);
    const raw = cstr(head, 0, 100);
    const name = (override ?? (prefix ? `${prefix}/${raw}` : raw)).replace(/^\.\//, "");
    override = null;

    if ((type === "0" || type === "\0") && !name.endsWith("/")) {
      files.set(name, Buffer.from(buf.subarray(dataStart, dataStart + size)));
    }
    p = next;
  }
  return files;
}

export const archiveContents = (outFile) => {
  const buf = readFileSync(outFile);
  return outFile.toLowerCase().endsWith(".zip") ? zipContents(buf) : tarContents(gunzipSync(buf));
};

/** Regular-file entry names. Directory markers are not deliverables. */
export const archiveEntries = (outFile) => [...archiveContents(outFile).keys()];

export const archiveEntryCount = (outFile) => archiveContents(outFile).size;

/**
 * `name -> sha256` for every regular file the archive actually carries.
 *
 * This is what closes the gap between "the tree was valid when I looked" and "the
 * deliverable holds those bytes": phase 04 hashes the tree, then hands the directory
 * to an external archiver, and anything — another agent in the output tree, a racing
 * build, a substituted tool — can change a file in between. Comparing entry NAMES
 * cannot see that; comparing the archive's own bytes can.
 */
export function archiveFileDigests(outFile) {
  const out = {};
  for (const [name, data] of archiveContents(outFile)) {
    out[name] = createHash("sha256").update(data).digest("hex");
  }
  return out;
}

/* ── binding a verdict to the tree it inspected ─────────────────────────── */

/**
 * A deterministic digest of a directory's contents: every relative path and a hash
 * of its bytes, in walk order. Two trees with the same digest hold the same files.
 *
 * This is what binds a phase-03 verdict to the bundle it actually inspected. Without
 * it the verdict is a claim about a *path*, and a path can be rebuilt or edited
 * underneath it — so phase 04 would archive a tree phase 03 never saw while I8 still
 * claimed otherwise. Content only: mtimes and build timestamps are deliberately not
 * hashed, so an identical rebuild stays valid and a changed one does not.
 */
export function hashTree(root) {
  const files = walk(root);
  const digests = {};
  const h = createHash("sha256");
  for (const rel of files) {
    const sha = createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
    digests[rel] = sha;
    h.update(rel, "utf8");
    h.update("\0");
    h.update(sha, "hex");
    h.update("\n");
  }
  return { hash: h.digest("hex"), files, digests };
}

/**
 * Drop the phase-03 verdict and the phase-04 record. Called before any mutation of
 * the bundle: a verdict must never outlive the tree it describes, and deleting it is
 * the half of that guarantee that does not depend on anyone recomputing anything.
 */
export function clearVerdict(outRoot) {
  const dropped = [];
  for (const name of ["validate.json", "archive.json"]) {
    const p = join(outRoot, STATE_DIR, name);
    if (existsSync(p)) { rmSync(p, { force: true }); dropped.push(name); }
  }
  return dropped;
}

/* ── gates & reporting ──────────────────────────────────────────────────── */

export class Gates {
  /** `strict` promotes advisories to hard failures. */
  constructor(phase, { strict = false } = {}) { this.phase = phase; this.strict = strict; this.rows = []; }

  check(name, ok, detail = "") { this.rows.push({ name, ok: !!ok, detail, level: "gate" }); return ok; }

  /**
   * Advisory. Used where the source project — not our pipeline — decides the
   * outcome: a verbatim mirror cannot invent font binaries the project never had,
   * so a design system that @imports a remote font yields a bundle that needs the
   * network. Worth reporting, not worth refusing to ship. `--strict` escalates.
   */
  warn(name, ok, detail = "") { this.rows.push({ name, ok: !!ok, detail, level: "advisory" }); return ok; }

  get failures() { return this.rows.filter((r) => !r.ok && (r.level === "gate" || this.strict)); }
  get passed() { return this.failures.length === 0; }

  report() {
    const tag = (r) => (r.ok ? "PASS" : r.level === "advisory" && !this.strict ? "WARN" : "FAIL");
    const lines = this.rows.map((r) => `  ${tag(r)}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    return `[${this.phase}] ${this.passed ? "DONE" : "BLOCKED"}\n${lines.join("\n")}`;
  }

  /** Print the report and exit non-zero when a hard gate failed. */
  finish() {
    console.log(this.report());
    if (!this.passed) process.exit(1);
  }
}

/** Minimal `--flag value` / `--flag` parser. */
export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

export function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(2);
}

/* ── shared constants ───────────────────────────────────────────────────── */

/**
 * I4: inbound-sync bookkeeping never ships.
 *
 * Two dialects, both real: `_ds_sync.json` is the proprietary tool's anchor,
 * `_ods_sync.json` + `_ods_needs_recompile` are sync-od's. A project that arrived
 * here THROUGH sync-od carries the latter, and an outbound bundle must not
 * re-export them — a stale anchor travelling with the code can later vouch for
 * state it never saw.
 */
export const SYNC_BOOKKEEPING = /(^|\/)(_ds_sync\.json|_ods_sync\.json|_ods_needs_recompile)$/;

export const NEVER_SHIP = [
  SYNC_BOOKKEEPING,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.handoff(\/|$)/,
];

/** Anything fetched over the network breaks I2 (offline-complete). */
export const REMOTE_URL = /\b(?:https?:)?\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i;

export const TEXTUAL = /\.(html?|css|js|jsx|mjs|cjs|ts|tsx|json|md|svg)$/i;
