#!/usr/bin/env node
// Phase 04 — archive. Emits `<Project Name>-handoff.zip` and `.tar.gz`.
// The `-handoff` suffix is what distinguishes this from a plain project export.
//
//   node scripts/hdd-archive.js [--out <dir>] [--format zip|targz|both]
//
// DONE-gate: phase 03 verdict is ok (I8); archive entry count >= tree file count.
import { existsSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  args, die, readState, readJson, writeJson, archive, archiveFileDigests, childDir,
  hashTree, symlinkScan, describeUnsafe, Gates, archiveBase as deriveArchiveBase,
} from "./_lib.js";

const a = args();
const outRoot = a.out ?? process.cwd();
const state = readState(outRoot);
if (!state) die("no .handoff/state.json — run hdd-detect.js first");

const { project } = state;
const bundleRoot = childDir(outRoot, project.slug, "project slug");
if (!existsSync(bundleRoot)) die(`no ${project.slug}/ — run hdd-bundle.js first`);

// The display name goes straight into a filename. Drop the characters a path or a
// Windows filesystem would choke on so `Design: v2` or a name carrying a separator
// cannot steer the archive out of outRoot. Shared with hdd-prompt.js, which names
// this same file to the receiving agent.
const archiveBase = deriveArchiveBase(project.name, project.slug);

/* ── I8 — never archive an unvalidated tree ─────────────────────────────────
 * "Unvalidated" has to mean *this* tree, not a tree that once lived at this path.
 * A verdict carrying only `ok` is a claim about a path: `--force` could replace the
 * whole bundle, or a hand-edit could add a file phase 03 would have rejected, and
 * this phase would archive it under the old verdict. So the verdict carries a digest
 * of what it inspected, and it is recomputed here. */

const verdict = readJson(join(outRoot, ".handoff", "validate.json"));
if (!verdict?.ok) die("phase 03 has not passed — run hdd-validate.js first (I8: archive only after validate)");
if (verdict.root !== project.slug) {
  die(`the verdict describes a different bundle (${verdict.root}/, not ${project.slug}/) — run phase 03`);
}
if (!verdict.treeHash) {
  die(`the verdict predates tree binding and cannot be trusted — run hdd-validate.js again`);
}

const current = hashTree(bundleRoot);
if (current.hash !== verdict.treeHash) {
  const delta = current.files.length - (verdict.fileCount ?? 0);
  die(`the bundle changed after it was validated — refusing to archive it (I8).\n` +
    `  validated: ${verdict.treeHash.slice(0, 16)}…  (${verdict.fileCount} files, ${verdict.at})\n` +
    `  on disk:   ${current.hash.slice(0, 16)}…  (${current.files.length} files${delta ? `, ${delta > 0 ? "+" : ""}${delta}` : ", same count, different content"})\n` +
    `  Phase 03 checks root purity, symlinks, spec completeness and adherence — none of\n` +
    `  which have been applied to what is on disk now. Run hdd-validate.js again.`);
}

// A symlink added after validation would not change the digest, because the walk
// that feeds it refuses unsafe links — but the archiver would still follow one.
const strayLinks = symlinkScan(bundleRoot);
if (strayLinks.followed.length || strayLinks.unsafe.length) {
  die(`I9 — the bundle contains symlinks and must not be archived:\n` +
    describeUnsafe([...strayLinks.unsafe, ...strayLinks.followed.map((l) => ({ ...l, reason: "link in a built bundle" }))]));
}

const format = a.format ?? "both";
const expected = new Set(current.files.map((f) => `${project.slug}/${f}`));
const treeCount = current.files.length;
const written = [];

for (const ext of format === "both" ? ["zip", "tar.gz"] : [format === "targz" ? "tar.gz" : "zip"]) {
  const outFile = join(outRoot, `${archiveBase}-handoff.${ext}`);
  try {
    archive(outRoot, project.slug, outFile);
  } catch (err) {
    // Both formats are written in-process, so this is a real I/O or memory failure,
    // not a missing host tool. There is nothing for the user to install.
    die(`archiving ${ext} failed: ${String(err.message ?? err).split("\n")[0]}`);
  }
  /* Read the finished archive back and compare its CONTENTS to the verdict.
   *
   * The digest check above proves the tree was intact when this phase started; it
   * cannot prove the archiver read that tree. Between `hashTree` and the archiver's
   * open() the directory is still writable — by another agent working in the output
   * tree, by a racing build, by a substituted tool — so the bytes that landed in the
   * archive are the only ones worth verifying. Names are not enough: a file can be
   * replaced by different content under the same name. */

  let inArchive;
  try {
    inArchive = archiveFileDigests(outFile);
  } catch (err) {
    die(`${ext} could not be read back for verification: ${String(err.message ?? err)}\n` +
      `  An archive this phase cannot verify is not a deliverable.`);
  }

  const names = new Set(Object.keys(inArchive));
  const missing = [...expected].filter((f) => !names.has(f));
  const extra = [...names].filter((f) => !expected.has(f));
  const altered = [...expected].filter((f) =>
    names.has(f) && inArchive[f] !== verdict.digests[f.slice(project.slug.length + 1)]);

  written.push({
    format: ext, path: outFile, bytes: statSync(outFile).size,
    entries: names.size, missing, extra, altered,
  });
}

writeJson(join(outRoot, ".handoff", "archive.json"), {
  at: new Date().toISOString(), treeCount, treeHash: current.hash, written,
});

const g = new Gates("04 archive");
for (const w of written) {
  const problems = [
    w.missing.length ? `${w.missing.length} missing (${w.missing.slice(0, 3).join(", ")})` : "",
    w.extra.length ? `${w.extra.length} unexpected (${w.extra.slice(0, 3).join(", ")})` : "",
    w.altered.length ? `${w.altered.length} with contents that are not what phase 03 validated ` +
      `(${w.altered.slice(0, 3).join(", ")})` : "",
  ].filter(Boolean).join("; ");
  g.check(`${w.format} carries exactly the validated bytes`, !problems,
    problems || `${w.entries}/${treeCount} files, every one byte-identical to the verdict, ` +
      `${(w.bytes / 1024).toFixed(0)} KB`);
}

/* An archive that failed verification must not be left lying around looking finished.
 * The gate below exits non-zero, but the file would still be there for someone to
 * pick up and send. */
if (!g.passed) {
  for (const w of written.filter((x) => x.missing.length || x.extra.length || x.altered.length)) {
    rmSync(w.path, { force: true });
    console.error(`removed unverifiable archive: ${w.path}`);
  }
  rmSync(join(outRoot, ".handoff", "archive.json"), { force: true });
}
console.log(`\nDeliverable(s):\n${written.map((w) => `  ${w.path}`).join("\n")}`);
g.finish();
