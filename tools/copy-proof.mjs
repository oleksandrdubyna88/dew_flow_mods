#!/usr/bin/env node
/**
 * C1: plugins/agent-models is the folder mods/agent-models of dew_flow_conventions at one named commit, byte for byte.
 *
 * Usage: node tools/copy-proof.mjs [--root <this repository>] [--conventions <dir>] [--commit <sha>]
 *   --root         default: the repository this file is in
 *   --conventions  default: <root>/.agents/conventions (the family mount; CI fetches the commit into it first)
 *   --commit       default: the commit named below
 *
 * Two proofs, both from git, with no list of files typed here:
 *   1. every file of mods/agent-models at the commit is in the folder with the same git blob id, and the folder holds
 *      no other file (a changed test or tsconfig is red too);
 *   2. the files that are the keys of the "1.6.0" row of tools/agent-models-pins.json at the commit (the files the old
 *      installer copies) have the sha256 of that row.
 *
 * When plugin.json names a version above 1.6.0 the folder has legitimately moved on, so the same two proofs are made
 * on the tree of the tag agent-models--v1.6.0 of this repository instead; a missing tag is red.
 *
 * Exit 0 with one line on success; exit 1 with every finding named. A commit that cannot be read, or a missing row, is
 * red, never a skip. Only node: builtins and git.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_COMMIT = '69adc1e21e0a6336aa04ba5fb50a9bce0ef999aa'; // the 1.6.0 merge commit of dew_flow_conventions (PR #189)
const PROVEN_VERSION = '1.6.0';
const TAG = `agent-models--v${PROVEN_VERSION}`;
const SOURCE = 'mods/agent-models';
const FOLDER = 'plugins/agent-models';
const PINS = 'tools/agent-models-pins.json';
// The engine writes this folder when the host loads the plugin; the plugin's own .gitignore excludes it.
const GENERATED = '.claude-plugin/types/';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const blobId = (buffer) => createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');

function git(repo, args, { allowFail = false } = {}) {
  const r = spawnSync('git', ['-C', repo, ...args], { maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr).trim()}`);
  return r.status === 0 ? r.stdout : null;
}

/** path -> blob id of every file under `dir` at `rev` in `repo`. */
function treeBlobs(repo, rev, dir) {
  const out = git(repo, ['ls-tree', '-r', '-z', rev, '--', dir], { allowFail: true });
  if (out === null) return null;
  const map = new Map();
  for (const record of String(out).split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const [, type, id] = record.slice(0, tab).split(' ');
    if (type === 'blob') map.set(record.slice(tab + 1).slice(dir.length + 1), id);
  }
  return map;
}

/** path -> blob id of every file on disk under `dir`, and a reader for the bytes. */
function diskBlobs(dir) {
  const map = new Map();
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        if (`${rel}/` !== GENERATED) walk(path.join(current, entry.name), `${rel}/`);
      } else {
        map.set(rel, blobId(fs.readFileSync(path.join(current, entry.name))));
      }
    }
  };
  walk(dir, '');
  return map;
}

const versionParts = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10));
function isAbove(version, base) {
  const a = versionParts(version);
  const b = versionParts(base);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/** The proof. Returns { ok, findings, line }. */
export function proveCopy({ root, conventions, commit }) {
  const findings = [];
  let full;
  try {
    full = String(git(conventions, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])).trim();
  } catch {
    return { ok: false, findings: [`the conventions commit ${commit} cannot be read in ${conventions}: fetch it first (git fetch --depth 1 origin ${commit})`] };
  }

  let table;
  try {
    table = JSON.parse(String(git(conventions, ['show', `${full}:${PINS}`])));
  } catch (error) {
    return { ok: false, findings: [`${PINS} cannot be read at ${full}: ${error.message}`] };
  }
  const row = table[PROVEN_VERSION];
  if (!row || typeof row !== 'object' || Object.keys(row).length === 0) {
    return { ok: false, findings: [`${PINS} at ${full} has no ${PROVEN_VERSION} row`] };
  }

  const expected = treeBlobs(conventions, full, SOURCE);
  if (!expected || expected.size === 0) return { ok: false, findings: [`${SOURCE} is empty or missing at ${full}`] };

  // What is compared: the folder on disk, or the tree of the tag when the version has moved above the proven one.
  let actual;
  let read;
  let what = FOLDER;
  const manifestPath = path.join(root, FOLDER, '.claude-plugin', 'plugin.json');
  let version;
  try {
    version = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version;
  } catch (error) {
    return { ok: false, findings: [`the plugin manifest of ${FOLDER} cannot be read: ${error.message}`] };
  }
  if (isAbove(version, PROVEN_VERSION)) {
    what = `tag ${TAG}`;
    actual = treeBlobs(root, `refs/tags/${TAG}`, FOLDER);
    if (!actual || actual.size === 0) {
      return { ok: false, findings: [`plugin.json is ${version}, above ${PROVEN_VERSION}, so ${FOLDER} at the tag ${TAG} is the copy to prove; the tag is absent`] };
    }
    read = (rel) => git(root, ['show', `refs/tags/${TAG}:${FOLDER}/${rel}`]);
  } else {
    actual = diskBlobs(path.join(root, FOLDER));
    read = (rel) => fs.readFileSync(path.join(root, FOLDER, rel));
  }

  for (const [rel, id] of expected) {
    if (!actual.has(rel)) findings.push(`missing from ${what}: ${rel}`);
    else if (actual.get(rel) !== id) findings.push(`differs from ${SOURCE}/${rel} at ${full}: ${rel} (blob ${actual.get(rel)}, expected ${id})`);
  }
  for (const rel of actual.keys()) {
    if (!expected.has(rel)) findings.push(`extra in ${what}, not in ${SOURCE} at ${full}: ${rel}`);
  }

  for (const [rel, want] of Object.entries(row)) {
    if (!actual.has(rel)) continue; // already named as missing above
    const got = sha256(read(rel));
    if (got !== want) findings.push(`sha256 of ${rel} is ${got}, the ${PROVEN_VERSION} row has ${want}`);
  }

  if (findings.length > 0) return { ok: false, findings };
  return {
    ok: true,
    findings,
    line: `copy-proof: ${what} equals ${SOURCE} of dew_flow_conventions ${full}: ${Object.keys(row).length} sha256 = ${PROVEN_VERSION} row, ${expected.size} blobs equal`,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--root', '--conventions', '--commit'].includes(key) || argv[i + 1] === undefined) {
      throw new Error(`usage: copy-proof.mjs [--root dir] [--conventions dir] [--commit sha] (got ${key})`);
    }
    options[key.slice(2)] = argv[i + 1];
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const root = path.resolve(options.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
    const conventions = path.resolve(options.conventions ?? path.join(root, '.agents', 'conventions'));
    const result = proveCopy({ root, conventions, commit: options.commit ?? DEFAULT_COMMIT });
    if (result.ok) {
      console.log(result.line);
    } else {
      for (const finding of result.findings) console.error(`copy-proof: ${finding}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`copy-proof: ${error.message}`);
    process.exitCode = 1;
  }
}
