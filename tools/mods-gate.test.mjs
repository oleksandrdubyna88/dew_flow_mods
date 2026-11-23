/**
 * G9: the layout of a commit, judged by `tools/mods-gate.mjs` — through the promotion (each defect a LAYOUT refusal,
 * nothing pushed) and as the standalone command.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { EXIT } from "./promote-release.mjs";
import { FORBIDDEN_NAMES, layoutFindings } from "./mods-gate.mjs";
import { here, git, MANIFEST, CAT_ENTRY, CATALOG, PLUGIN_TREE, workspace, remote, ciRun, scene, MODS_GATE, moved } from "./promote-release.fixture.mjs";

test("the fixture's first commit is a valid layout: the layout findings of a good tree are none", (t) => {
  const rules = remote(workspace(t), "layout-good");
  assert.deepEqual(layoutFindings({ git: (...args) => git(rules.work, ...args), rev: rules.first }), []);
  assert.deepEqual(layoutFindings({ git: (...args) => git(rules.work, ...args), rev: rules.second }), []);
});

// ── G9: the layout of the commit ─────────────────────────────────────────────────────────────────

const GOOD_SOURCE = "./plugins/agent-models";
const entryWith = (patch) => ({ ...CAT_ENTRY("agent-models"), ...patch });
const SOURCE_RE = /\.claude-plugin\/marketplace\.json: plugins\[0\] "agent-models": source must be the string "\.\/plugins\/agent-models"/;
const FORBID_RE = (p) => new RegExp(`${p.replaceAll(".", "\\.")}: a plugin folder holds no package\\.json, lockfile or node_modules`);
const MARKET = ".claude-plugin/marketplace.json";

const LAYOUT_CASES = [
  ["a package.json in a plugin folder", { "plugins/agent-models/package.json": "{}\n" }, [FORBID_RE("plugins/agent-models/package.json")]],
  ["a node_modules folder in a plugin", { "plugins/agent-models/node_modules/x/index.js": "x\n" }, [FORBID_RE("plugins/agent-models/node_modules/x/index.js")]],
  ...FORBIDDEN_NAMES.map((name) => [`${name} in a plugin folder`, { [`plugins/agent-models/hooks/${name}`]: "x\n" }, [FORBID_RE(`plugins/agent-models/hooks/${name}`)]]),
  ["a symlink under plugins/", { "plugins/agent-models/hooks/link": { link: "../../../README.md" } }, [/plugins\/agent-models\/hooks\/link: a symlink \(mode 120000\)/]],
  ["a gitlink under plugins/", { "plugins/agent-models/sub": { gitlink: true } }, [/plugins\/agent-models\/sub: a gitlink \(mode 160000\)/]],
  ["an entry with a fourth key", { [MARKET]: CATALOG([entryWith({ homepage: "https://example.invalid" })]) }, [/marketplace\.json: plugins\[0\] has the key "homepage"; an entry is exactly name, source, description/]],
  ["an entry name that is not the manifest name", { "plugins/agent-models/.claude-plugin/plugin.json": MANIFEST("other", "1.6.0") }, [/plugins\/agent-models\/\.claude-plugin\/plugin\.json: name is "other" but the catalog entry is "agent-models"/]],
  ["source an object (github)", { [MARKET]: CATALOG([entryWith({ source: { source: "github", repo: "example/mods" } })]) }, [SOURCE_RE]],
  ["source an object (git-subdir with the right URL)", { [MARKET]: CATALOG([entryWith({ source: { source: "git-subdir", url: "https://github.com/example/conventions.git", path: "plugins/agent-models" } })]) }, [SOURCE_RE]],
  ["source ./plugins/other", { [MARKET]: CATALOG([entryWith({ source: "./plugins/other" })]) }, [SOURCE_RE]],
  ["source without ./", { [MARKET]: CATALOG([entryWith({ source: "plugins/agent-models" })]) }, [SOURCE_RE]],
  ["source with a trailing slash", { [MARKET]: CATALOG([entryWith({ source: `${GOOD_SOURCE}/` })]) }, [SOURCE_RE]],
  ["source with ..", { [MARKET]: CATALOG([entryWith({ source: "./plugins/../plugins/agent-models" })]) }, [SOURCE_RE]],
  ["metadata.pluginRoot", { [MARKET]: CATALOG(undefined, { metadata: { description: "mods", pluginRoot: "./plugins" } }) }, [/marketplace\.json: metadata has the key "pluginRoot"; only description is allowed/]],
  ["an unknown top-level key", { [MARKET]: CATALOG(undefined, { strict: false }) }, [/marketplace\.json: unknown top-level key "strict"/]],
  ["a marketplace name that is not dew-flow-mods", { [MARKET]: CATALOG(undefined, { name: "other-mods" }) }, [/marketplace\.json: name is "other-mods", it must be "dew-flow-mods"/]],
  ["a plugin folder with no entry", PLUGIN_TREE("extra", "1.0.0"), [/plugins\/extra: a plugin folder with no catalog entry/]],
  ["an entry with no folder", { [MARKET]: CATALOG([CAT_ENTRY("agent-models"), CAT_ENTRY("ghost")]) }, [/marketplace\.json: plugins\[1\] "ghost": there is no folder plugins\/ghost/]],
  ["two entries of one name", { [MARKET]: CATALOG([CAT_ENTRY("agent-models"), CAT_ENTRY("agent-models")]) }, [/marketplace\.json: plugins\[1\] repeats the name "agent-models"/]],
  ["unparsable catalog JSON", { [MARKET]: "{ nope" }, [/marketplace\.json: not JSON/]],
  ["unparsable manifest JSON", { "plugins/agent-models/.claude-plugin/plugin.json": "{ nope" }, [/plugins\/agent-models\/\.claude-plugin\/plugin\.json: not JSON/]],
];

test("G9: each defect of the layout is a LAYOUT refusal that names path and reason; nothing is pushed", (t) => {
  for (const [label, files, expected] of LAYOUT_CASES) {
    const { s, sha } = moved(t, files, "first");
    const before = s.rules.refs();
    const { code, out } = s.promote([sha]);
    assert.equal(code, EXIT.REFUSED, `${label}: ${out}`);
    assert.match(out, /REFUSED — LAYOUT/, `${label}: ${out}`);
    for (const re of expected) assert.match(out, re, `${label}: ${out}`);
    assert.deepEqual(s.github.calls(), [], `${label}: GitHub is not asked`);
    assert.deepEqual(s.rules.refs(), before, `${label}: nothing pushed`);
  }
});

test("G9: a plugin that release has and the commit has not is a LAYOUT finding", (t) => {
  const s = scene(t);
  const both = s.rules.advance({ ...PLUGIN_TREE("extra", "1.0.0"), [MARKET]: CATALOG([CAT_ENTRY("agent-models"), CAT_ENTRY("extra")]) });
  s.rules.release(both);
  const without = s.rules.advance({ "plugins/extra/.claude-plugin/plugin.json": null, "plugins/extra/hooks/hooks.json": null, [MARKET]: CATALOG() });
  s.github.lists([ciRun(without)]);
  const { code, out } = s.promote([without]);
  assert.equal(code, EXIT.REFUSED, out);
  assert.match(out, /REFUSED — LAYOUT/, out);
  assert.match(out, /plugins\/extra: release has this plugin and this commit has not/, out);
  assert.equal(s.rules.releaseAt(), both);
});

test("G9: every finding of the commit is printed — three defects print three lines", (t) => {
  const defects = {
    "plugins/agent-models/package.json": "{}\n",
    [MARKET]: CATALOG([entryWith({ homepage: "x" })], { metadata: { description: "mods", pluginRoot: "./plugins" } }),
  };
  const { s, sha } = moved(t, defects, "first");
  const { code, out } = s.promote([sha]);
  assert.equal(code, EXIT.REFUSED, out);
  const found = out.split("\n").filter((l) => /^ {2}(\.claude-plugin|plugins)\/\S*: /.test(l));
  assert.equal(found.length, 3, out);

  // the standalone gate prints the same lines and exits 1
  git(s.runner, "fetch", "-q", "origin", "main");
  const cli = spawnSync(process.execPath, [MODS_GATE, sha], { cwd: s.runner, encoding: "utf8", timeout: 60000 });
  const cliOut = `${cli.stdout}${cli.stderr}`;
  assert.equal(cli.status, 1, cliOut);
  for (const line of found) assert.ok(cliOut.includes(line.trim()), `${line.trim()} is in the gate's own output: ${cliOut}`);
});

test("G9: the standalone gate on this repository's HEAD exits 0 and says how many plugins it read", () => {
  const root = path.join(here, "..");
  const cli = spawnSync(process.execPath, [MODS_GATE], { cwd: root, encoding: "utf8", timeout: 60000 });
  assert.equal(cli.status, 0, `${cli.stdout}${cli.stderr}`);
  assert.match(cli.stdout, /1 plugin read/, cli.stdout);
});

// ── review fixes: the version is canonical, and names are judged in lower case ───────────────────

test("G5: a version with a leading zero is a LAYOUT finding — 1.6.01 would name the tag agent-models--v1.6.01", (t) => {
  for (const bad of ["1.6.01", "01.6.1", "1.06.1", "1.6.001"]) {
    const { s, sha } = moved(t, { "plugins/agent-models/.claude-plugin/plugin.json": MANIFEST("agent-models", bad) });
    const { code, out } = s.promote([sha]);
    assert.equal(code, EXIT.REFUSED, `${bad}: ${out}`);
    assert.match(out, /REFUSED — LAYOUT/, `${bad}: ${out}`);
    assert.match(out, new RegExp(`plugin\\.json: version "${bad.replaceAll(".", "\\.")}" is not`), `${bad}: ${out}`);
    assert.deepEqual(s.github.calls(), [], `${bad}: GitHub is not asked`);
    assert.equal(s.rules.releaseAt(), s.rules.second, `${bad}: release did not move`);
  }
  // the zero itself is a number: 0.0.0 and 10.20.30 are canonical
  for (const good of ["0.0.0", "10.20.30"]) {
    const { s, sha } = moved(t, { "plugins/agent-models/.claude-plugin/plugin.json": MANIFEST("agent-models", good) });
    const found = layoutFindings({ git: (...args) => git(s.rules.work, ...args), rev: sha });
    assert.deepEqual(found, [], good);
  }
});

test("G9: a top-level Plugins/ or PLUGINS/ is refused — on a case-insensitive disk it is the plugins folder", (t) => {
  for (const top of ["Plugins", "PLUGINS"]) {
    const { s, sha } = moved(t, { [`${top}/agent-models/hooks/evil.tsx`]: "x\n", [`${top}/other/readme`]: "y\n" }, "first");
    const before = s.rules.refs();
    const { code, out } = s.promote([sha]);
    assert.equal(code, EXIT.REFUSED, `${top}: ${out}`);
    assert.match(out, /REFUSED — LAYOUT/, `${top}: ${out}`);
    assert.equal([...out.matchAll(new RegExp(`^ {2}${top}: a top-level entry`, "gm"))].length, 1, `${top}: one finding for the entry: ${out}`);
    assert.deepEqual(s.github.calls(), [], `${top}: GitHub is not asked`);
    assert.deepEqual(s.rules.refs(), before, `${top}: nothing pushed`);
  }
});

test("G9: Package.json, Yarn.lock and Node_Modules are the same names in other cases — refused", (t) => {
  for (const file of ["plugins/agent-models/Package.json", "plugins/agent-models/hooks/PACKAGE-LOCK.JSON", "plugins/agent-models/Yarn.lock", "plugins/agent-models/Node_Modules/x/index.js"]) {
    const { s, sha } = moved(t, { [file]: "x\n" }, "first");
    const { code, out } = s.promote([sha]);
    assert.equal(code, EXIT.REFUSED, `${file}: ${out}`);
    assert.match(out, new RegExp(`${file.replaceAll(".", "\\.")}: a plugin folder holds no package\\.json, lockfile or node_modules`), `${file}: ${out}`);
    assert.equal(s.rules.releaseAt(), s.rules.first, `${file}: release did not move`);
  }
});
