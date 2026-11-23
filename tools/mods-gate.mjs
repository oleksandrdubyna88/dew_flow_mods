#!/usr/bin/env node
// mods-gate.mjs — what a commit of this repository must look like before it can be `release`, read from git
// objects and never from the work tree: the checkout of a promotion is the gate's own commit, and the commit being
// judged can be older.
//
// `release` is what every machine loads as a plugin marketplace, with the owner's permissions and outside any
// sandbox. So two questions are asked of the commit, and both fail closed:
//   LAYOUT   the catalog (.claude-plugin/marketplace.json) is exactly the shape this repository serves, the plugin
//            folders and the catalog entries are one set, and no plugin folder holds a package.json, a lockfile,
//            node_modules, a symlink or a gitlink (nothing that installs or reaches outside the folder);
//   VERSION  a plugin folder that differs from `release` (a test file counts: tests ship) has a version that went UP.
//            Versions are `major.minor.patch`, digits only, compared as three numbers: 1.10.0 is above 1.9.0.
//
// `layoutFindings` returns every finding of the commit as `{path, reason}` (a commit with three defects prints three),
// `versionVerdict` returns `{ok, tags, changed}` or a refusal. Both take `git` as a function, as promote-release does.
//
// Usage:  node tools/mods-gate.mjs [rev=HEAD]
// Exit:   0 the layout is good · 1 findings, printed one `path: reason` per line · 2 usage · 3 the commit could not be read

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { git as gitIn } from "./lib/git.mjs";

export const CATALOG_PATH = ".claude-plugin/marketplace.json";
export const MARKETPLACE_NAME = "dew-flow-mods";

/** The names that make a folder installable or non-hermetic. A plugin folder holds none of them, at any depth. */
export const FORBIDDEN_NAMES = Object.freeze(["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"]);

const TOP_KEYS = ["name", "owner", "metadata", "plugins"];
const ENTRY_KEYS = ["name", "source", "description"];
/** Lowercase words joined by SINGLE hyphens: a name is also a tag prefix, and `--v` is what ends it. */
const PLUGIN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Canonical: a number has no leading zero, so one version has one spelling and one tag (`1.6.01` is not `1.6.1`). */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const firstLine = (text) => String(text ?? "").trim().split("\n")[0];
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const refusal = (headline, ...lines) => ({ ok: false, code: 1, headline, lines });

/** The tag of one plugin version, and the ref of it. */
export const tagFor = (name, version) => `${name}--v${version}`;
export const tagRefFor = (name, version) => `refs/tags/${tagFor(name, version)}`;

/** `major.minor.patch` as three numbers; BigInt so a long number cannot lose a digit. Null when it is not that. */
function parts(version) {
  return typeof version === "string" && VERSION.test(version) ? version.split(".").map((n) => BigInt(n)) : null;
}

/** -1, 0, 1 — both arguments must be valid versions. */
export function compareVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** Every entry of the tree at `rev`, recursive from the root: `{mode, type, path}`. */
function listTree(git, rev) {
  return git("ls-tree", "-r", "-z", "--full-tree", rev).split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    const [mode, type] = record.slice(0, tab).split(" ");
    return { mode, type, path: record.slice(tab + 1) };
  });
}

/** The folder names directly under plugins/ at `rev`. */
function pluginFolders(git, rev) {
  const out = git("ls-tree", "--name-only", rev, "plugins/");
  return out.split("\n").filter(Boolean).map((p) => p.slice("plugins/".length));
}

/** The text of one blob at `rev`, or null when the path is not there. */
function blobAt(git, rev, file) {
  try {
    return git("show", `${rev}:${file}`);
  } catch {
    return null;
  }
}

const manifestPath = (name) => `plugins/${name}/.claude-plugin/plugin.json`;

/**
 * The tree of the commit: a top-level lookalike of `plugins/`, a link, a stray file, a forbidden name. Returns the
 * folder names found under `plugins/`.
 * Names are judged in lower case: on a case-insensitive disk `Plugins/` IS `plugins/`, and `Package.json` IS package.json.
 */
function checkTree(entries, add) {
  const folders = new Set();
  const lookalikes = new Set();
  for (const entry of entries) {
    const top = entry.path.split("/")[0];
    if (top !== "plugins" && top.toLowerCase() === "plugins" && !lookalikes.has(top)) {
      lookalikes.add(top);
      add(top, "a top-level entry that is `plugins` in other letters; on a case-insensitive disk it is the plugins folder, and only `plugins` is one");
    }
    if (entry.path.startsWith("plugins/")) checkPluginEntry(entry, folders, add);
  }
  return folders;
}

/** One entry under `plugins/`: a link, a file outside every plugin folder, a name that installs. */
function checkPluginEntry(entry, folders, add) {
  if (entry.mode === "120000") add(entry.path, "a symlink (mode 120000); a plugin holds no link");
  else if (entry.mode === "160000") add(entry.path, "a gitlink (mode 160000); a plugin holds no submodule");
  const segments = entry.path.slice("plugins/".length).split("/");
  if (segments.length === 1) {
    if (entry.mode !== "160000") add(entry.path, "a file directly under plugins/; every file belongs to a plugin folder");
    return;
  }
  folders.add(segments[0]);
  if (FORBIDDEN_NAMES.includes(segments.at(-1).toLowerCase()) || segments.some((s) => s.toLowerCase() === "node_modules")) {
    add(entry.path, "a plugin folder holds no package.json, lockfile or node_modules");
  }
}

/** The catalog as an object, or null after a finding that says why it is not one. */
function readCatalog(git, rev, add) {
  const text = blobAt(git, rev, CATALOG_PATH);
  if (text === null) {
    add(CATALOG_PATH, "is missing");
    return null;
  }
  let catalog;
  try {
    catalog = JSON.parse(text);
  } catch (error) {
    add(CATALOG_PATH, `not JSON: ${firstLine(error.message)}`);
    return null;
  }
  if (!isObject(catalog)) {
    add(CATALOG_PATH, "is not a JSON object");
    return null;
  }
  return catalog;
}

/** The catalog outside its plugin list: the top-level keys, the name, the metadata. */
function checkCatalogHead(catalog, add) {
  for (const key of Object.keys(catalog)) {
    if (!TOP_KEYS.includes(key)) add(CATALOG_PATH, `unknown top-level key "${key}"`);
  }
  if (catalog.name !== MARKETPLACE_NAME) add(CATALOG_PATH, `name is ${JSON.stringify(catalog.name)}, it must be "${MARKETPLACE_NAME}"`);
  if (catalog.metadata === undefined) return;
  if (!isObject(catalog.metadata)) {
    add(CATALOG_PATH, "metadata is not an object");
    return;
  }
  for (const key of Object.keys(catalog.metadata)) {
    if (key !== "description") add(CATALOG_PATH, `metadata has the key "${key}"; only description is allowed`);
  }
}

/**
 * One catalog entry on its own: its keys, its name, its source, its description. Returns the name when the entry has
 * one that is valid and new (it is then in `seen`), and null when the rest of the entry cannot be judged.
 */
function checkEntry(entry, at, seen, add) {
  if (!isObject(entry)) {
    add(CATALOG_PATH, `${at} is not an object`);
    return null;
  }
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.includes(key)) add(CATALOG_PATH, `${at} has the key "${key}"; an entry is exactly name, source, description`);
  }
  for (const key of ENTRY_KEYS) {
    if (!(key in entry)) add(CATALOG_PATH, `${at} has no "${key}"; an entry is exactly name, source, description`);
  }
  const name = entry.name;
  if (typeof name !== "string" || !PLUGIN_NAME.test(name)) {
    add(CATALOG_PATH, `${at} name ${JSON.stringify(name)} is not lowercase words joined by single hyphens`);
    return null;
  }
  if (seen.has(name)) {
    add(CATALOG_PATH, `${at} repeats the name "${name}"`);
    return null;
  }
  seen.add(name);
  // The STRING, exactly: an object source can point anywhere, and `./plugins/<name>/` or `./plugins/../..` are
  // other spellings that a loader may resolve differently from this check.
  if (entry.source !== `./plugins/${name}`) add(CATALOG_PATH, `${at} "${name}": source must be the string "./plugins/${name}"`);
  if (typeof entry.description !== "string") add(CATALOG_PATH, `${at} "${name}": description must be a string`);
  return name;
}

/** The manifest of one plugin: it is there, it is an object, its name is the entry's, its version is canonical. */
function checkManifest({ git, rev, name, files, add, plugins }) {
  const manifest = manifestPath(name);
  const text = files.has(manifest) ? blobAt(git, rev, manifest) : null;
  if (text === null) {
    add(manifest, "is missing");
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    add(manifest, `not JSON: ${firstLine(error.message)}`);
    return;
  }
  if (!isObject(parsed)) {
    add(manifest, "is not a JSON object");
    return;
  }
  if (parsed.name !== name) add(manifest, `name is ${JSON.stringify(parsed.name)} but the catalog entry is "${name}"`);
  if (parts(parsed.version) === null) add(manifest, `version ${JSON.stringify(parsed.version)} is not <major>.<minor>.<patch>, digits only`);
  else plugins.push({ name, version: parsed.version });
}

/** The plugin list: every entry, its folder and manifest, and every folder that has no entry. */
function checkPlugins(catalog, { git, rev, files, folders, add, plugins }) {
  if (!Array.isArray(catalog.plugins)) {
    add(CATALOG_PATH, "plugins is not a list");
    return;
  }
  const seen = new Set();
  catalog.plugins.forEach((entry, i) => {
    const at = `plugins[${i}]`;
    const name = checkEntry(entry, at, seen, add);
    if (name === null) return;
    if (!folders.has(name)) add(CATALOG_PATH, `${at} "${name}": there is no folder plugins/${name}`);
    else checkManifest({ git, rev, name, files, add, plugins });
  });
  for (const folder of [...folders].sort()) {
    if (!seen.has(folder)) add(`plugins/${folder}`, "a plugin folder with no catalog entry");
  }
}

/**
 * The layout of the commit, as every finding it has, plus the plugins that were read.
 * `release` (optional, a rev or empty) adds one rule: a plugin that release serves cannot vanish.
 */
export function inspect({ git, rev, release = "" }) {
  const findings = [];
  const add = (file, reason) => findings.push({ path: file, reason });
  const plugins = [];

  const entries = listTree(git, rev);
  const files = new Set(entries.map((e) => e.path));
  const folders = checkTree(entries, add);
  const catalog = readCatalog(git, rev, add);
  if (catalog !== null) {
    checkCatalogHead(catalog, add);
    checkPlugins(catalog, { git, rev, files, folders, add, plugins });
  }
  if (release !== "") {
    for (const folder of pluginFolders(git, release)) {
      if (!folders.has(folder)) add(`plugins/${folder}`, "release has this plugin and this commit has not");
    }
  }
  return { findings, plugins };
}

/** Every finding of the layout at `rev`, as `{path, reason}`. */
export function layoutFindings({ git, rev, release = "" }) {
  return inspect({ git, rev, release }).findings;
}

/** `git diff --quiet` says "differs" with exit 1; any other failure is an error to surface. */
function differs(git, release, sha, folder) {
  try {
    git("diff", "--quiet", release, sha, "--", folder);
    return false;
  } catch (error) {
    if (error.status === 1) return true;
    throw error;
  }
}

function versionAt(git, rev, name) {
  const text = blobAt(git, rev, manifestPath(name));
  if (text === null) return null;
  try {
    const { version } = JSON.parse(text);
    return parts(version) === null ? null : version;
  } catch {
    return null;
  }
}

const some = (paths, n = 5) => (paths.length <= n ? paths.join(", ") : `${paths.slice(0, n).join(", ")} and ${paths.length - n} more`);

/**
 * The version question for moving `release` to `sha`. A plugin counts as changed when its folder differs from
 * release's (a test file counts). With no release yet, every plugin is new. A raised version yields the tag
 * `<name>--v<version>`; a changed plugin whose version did not go up is a refusal that names every such plugin.
 */
export function versionVerdict({ git, release = "", sha }) {
  const changed = [];
  const tags = [];
  const stuck = [];
  for (const name of pluginFolders(git, sha)) {
    const folder = `plugins/${name}`;
    const to = versionAt(git, sha, name);
    if (to === null) return refusal("LAYOUT", `${manifestPath(name)}: no readable <major>.<minor>.<patch> version at ${sha}.`);
    let from = null;
    let paths;
    if (release !== "" && blobAt(git, release, manifestPath(name)) !== null) {
      if (!differs(git, release, sha, folder)) continue;
      from = versionAt(git, release, name);
      if (from === null) return refusal("LAYOUT", `${manifestPath(name)}: no readable <major>.<minor>.<patch> version at release ${release}.`);
      paths = git("diff", "--name-only", "--no-renames", release, sha, "--", folder).split("\n").filter(Boolean);
    } else {
      paths = git("ls-tree", "-r", "--name-only", sha, "--", folder).split("\n").filter(Boolean);
    }
    if (from !== null && compareVersions(to, from) <= 0) {
      stuck.push({ name, from, to, paths });
      continue;
    }
    changed.push({ name, from, to, files: paths });
    tags.push({ name, version: to, tag: tagFor(name, to), ref: tagRefFor(name, to) });
  }
  if (stuck.length > 0) {
    const lines = [];
    for (const s of stuck) {
      lines.push(`plugin ${s.name}: release has ${s.from}, ${sha} has ${s.to}; ${s.paths.length} file(s) changed in plugins/${s.name}, and the version did not rise.`);
      lines.push(`changed: ${some(s.paths)}`);
    }
    lines.push("A plugin folder that differs from release ships to every machine — a test file too — and the engine's updater moves a machine only when the version goes up.",
      "fix:   raise \"version\" in the plugin's .claude-plugin/plugin.json above the release's (1.10.0 is above 1.9.0), merge, and promote the new commit.");
    return refusal("VERSION NOT RAISED", ...lines);
  }
  return { ok: true, tags, changed };
}

/** The command: argv → exit code. */
export function main(argv, log = console.log, fail = console.error, git = (...args) => gitIn(process.cwd(), ...args)) {
  if (argv.length > 1 || argv.some((a) => a.startsWith("-"))) {
    fail("mods-gate: usage: node tools/mods-gate.mjs [rev=HEAD]");
    return 2;
  }
  const rev = argv[0] ?? "HEAD";
  let result;
  try {
    result = inspect({ git, rev });
  } catch (error) {
    fail(`mods-gate: cannot read ${rev}: ${firstLine(error.stderr) || firstLine(error.message)}`);
    return 3;
  }
  if (result.findings.length > 0) {
    fail(`mods-gate: LAYOUT — ${result.findings.length} finding(s) at ${rev}`);
    for (const f of result.findings) fail(`  ${f.path}: ${f.reason}`);
    return 1;
  }
  const n = result.plugins.length;
  log(`mods-gate: ${n} plugin${n === 1 ? "" : "s"} read at ${rev} (${result.plugins.map((p) => `${p.name} ${p.version}`).join(", ")}); the layout is good.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
