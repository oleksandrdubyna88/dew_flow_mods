/**
 * Story 2.2 of the move: this repository's release gate. G1, G3, G5-G8 and the dry run, against real repositories
 * (the fixture is promote-release.fixture.mjs). G9, the layout, is mods-gate.test.mjs; the workflows are
 * workflows.test.mjs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { EXIT, RELEASE_REF, ciRunsFor } from "./promote-release.mjs";
import { SLUG, ciRun, run, scene, TAG, hookChange, bump, tagRefs, moved } from "./promote-release.fixture.mjs";

// ── G1: the shape of the argument ────────────────────────────────────────────────────────────────

test("G1: 39 characters, a branch name and HEAD are not a sha — GitHub is not asked and no ref moves", (t) => {
  const s = scene(t);
  s.github.lists([ciRun(s.rules.first)]);
  const before = s.rules.refs();
  for (const named of [s.rules.first.slice(0, 39), "main", "HEAD"]) {
    const { code, out } = s.promote([named]);
    assert.equal(code, EXIT.REFUSED, out);
    assert.match(out, /REFUSED — NOT A SHA/, out);
  }
  assert.deepEqual(s.github.calls(), []);
  assert.deepEqual(s.rules.refs(), before, "the remote's refs are unchanged");
});

// ── G3: only a push run of ci on main is evidence ────────────────────────────────────────────────

test("G3: a ci run of another event or another branch is no evidence; a cancelled push run is not green", (t) => {
  const s = scene(t);
  for (const odd of [{ event: "workflow_dispatch" }, { event: "pull_request" }, { event: "schedule" }, { head_branch: "topic" }]) {
    s.github.lists([ciRun(s.rules.first, odd)]);
    const { code, out } = s.promote([s.rules.first]);
    assert.equal(code, EXIT.REFUSED, out);
    assert.match(out, /REFUSED — NO CI RUN/, `${JSON.stringify(odd)}: ${out}`);
  }
  // the repository's ci has cancel-in-progress: a cancelled push run is a run, and it is not green
  s.github.lists([ciRun(s.rules.first, { conclusion: "cancelled" }), ciRun(s.rules.first, { id: 1, event: "workflow_dispatch" })]);
  const cancelled = s.promote([s.rules.first]);
  assert.equal(cancelled.code, EXIT.REFUSED, cancelled.out);
  assert.match(cancelled.out, /REFUSED — CI NOT GREEN/, cancelled.out);
  assert.match(cancelled.out, /conclusion cancelled/, cancelled.out);
  // a red run of another event beside the green push run is not the judge's concern
  s.github.lists([ciRun(s.rules.first), ciRun(s.rules.first, { id: 2, event: "pull_request", conclusion: "failure" })]);
  const ok = s.promote([s.rules.first, "--dry-run"]);
  assert.equal(ok.code, EXIT.PROMOTED, ok.out);
  assert.equal(s.rules.releaseAt(), "");
});

test("G3: ciRunsFor keeps only the ci runs of event push on main for the sha", () => {
  const sha = "a".repeat(40);
  const listing = JSON.stringify({ total_count: 5, workflow_runs: [
    ciRun(sha, { id: 1 }),
    ciRun(sha, { id: 2, event: "workflow_dispatch" }),
    ciRun(sha, { id: 3, event: "pull_request" }),
    ciRun(sha, { id: 4, head_branch: "feature" }),
    ciRun(sha, { id: 5, head_branch: undefined }),
  ] });
  assert.deepEqual(ciRunsFor(listing, sha).runs.map((r) => r.id), [1]);
});

// ── G5: a change to a plugin needs a higher version ──────────────────────────────────────────────

test("G5: a plugin file changed and the version equal or lower: VERSION NOT RAISED, with the plugin, both versions and the paths", (t) => {
  for (const [label, files, shown] of [
    ["a hook, version equal", hookChange(), "plugins/agent-models/hooks/limits.tsx"],
    ["a hook, version lower", { ...hookChange(), ...bump("1.5.9") }, "plugins/agent-models/hooks/limits.tsx"],
    ["only a test file, version equal", { "plugins/agent-models/tests/limits.test.tsx": "changed\n" }, "plugins/agent-models/tests/limits.test.tsx"],
  ]) {
    const { s, sha } = moved(t, files);
    const { code, out } = s.promote([sha]);
    assert.equal(code, EXIT.REFUSED, `${label}: ${out}`);
    assert.match(out, /REFUSED — VERSION NOT RAISED/, `${label}: ${out}`);
    assert.match(out, /agent-models/, out);
    assert.match(out, /release has [^\s]*1\.6\.0/, `${label}: ${out}`);
    assert.ok(out.includes(shown), `${label}: the changed path is named: ${out}`);
    assert.deepEqual(s.github.calls(), [], `${label}: GitHub is not asked`);
    assert.equal(s.rules.releaseAt(), s.rules.second, `${label}: release did not move`);
    assert.deepEqual(tagRefs(s), [], `${label}: no tag`);
  }
});

test("G5: the changed paths are the first five and the count", (t) => {
  const many = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`plugins/agent-models/hooks/h${i}.tsx`, `${i}\n`]));
  const { s, sha } = moved(t, many);
  const { code, out } = s.promote([sha]);
  assert.equal(code, EXIT.REFUSED, out);
  assert.match(out, /7 file\(s\) changed/, out);
  assert.equal([...out.matchAll(/plugins\/agent-models\/hooks\/h\d\.tsx/g)].length, 5, out);
  assert.match(out, /and 2 more/, out);
});

test("G5: a version that is not major.minor.patch is a LAYOUT finding, not a version verdict", (t) => {
  for (const bad of ["1.6", "1.6.1-rc1", "v1.6.1", "1.6.1.0"]) {
    const { s, sha } = moved(t, { ...hookChange(), ...bump(bad) });
    const { code, out } = s.promote([sha]);
    assert.equal(code, EXIT.REFUSED, `${bad}: ${out}`);
    assert.match(out, /REFUSED — LAYOUT/, `${bad}: ${out}`);
    assert.match(out, /plugins\/agent-models\/\.claude-plugin\/plugin\.json: version "[^"]*" is not/, `${bad}: ${out}`);
    assert.deepEqual(s.github.calls(), []);
    assert.equal(s.rules.releaseAt(), s.rules.second);
  }
});

// ── G6: a raised version moves release and creates the tag in one push ───────────────────────────

test("G6: 1.6.0 → 1.6.1 moves release and creates the lightweight tag at the same sha, and no other ref", (t) => {
  const { s, sha } = moved(t, { ...hookChange(), ...bump("1.6.1") });
  const before = s.rules.refs();
  const { code, out } = s.promote([sha]);
  assert.equal(code, EXIT.PROMOTED, out);
  assert.equal(s.rules.releaseAt(), sha);
  assert.equal(s.rules.refAt(TAG("1.6.1")), sha);
  assert.equal(s.rules.refLines(TAG("1.6.1")).length, 1, "lightweight: no peeled line");
  assert.deepEqual(s.rules.refs(), [...before, TAG("1.6.1")].sort(), "exactly one new ref");
  assert.match(out, new RegExp(`PROMOTED — origin/release is ${sha}`), out);
});

test("G6: 1.9.0 → 1.10.0 is a raise — a string compare would refuse it", (t) => {
  const s = scene(t);
  const nine = s.rules.advance({ ...hookChange(3), ...bump("1.9.0") });
  s.rules.release(nine);
  const ten = s.rules.advance({ ...hookChange(4), ...bump("1.10.0") });
  s.github.lists([ciRun(ten)]);
  const { code, out } = s.promote([ten]);
  assert.equal(code, EXIT.PROMOTED, out);
  assert.equal(s.rules.releaseAt(), ten);
  assert.equal(s.rules.refAt(TAG("1.10.0")), ten);
});

test("G6: with no release yet every plugin of the commit is new: release and the tag of its version appear together", (t) => {
  const s = scene(t);
  s.github.lists([ciRun(s.rules.first)]);
  const before = s.rules.refs();
  const { code, out } = s.promote([s.rules.first]);
  assert.equal(code, EXIT.PROMOTED, out);
  assert.equal(s.rules.releaseAt(), s.rules.first);
  assert.equal(s.rules.refAt(TAG("1.6.0")), s.rules.first);
  assert.deepEqual(s.rules.refs(), [...before, RELEASE_REF, TAG("1.6.0")].sort());
});

// ── G7: the tag ──────────────────────────────────────────────────────────────────────────────────

test("G7a: a tag that exists at another sha is refused, both shas are named, and nothing is pushed", (t) => {
  const { s, sha } = moved(t, { ...hookChange(), ...bump("1.6.1") });
  s.rules.tag("agent-models--v1.6.1", s.rules.first);
  const before = s.rules.refs();
  const { code, out } = s.promote([sha]);
  assert.equal(code, EXIT.REFUSED, out);
  assert.match(out, /REFUSED — TAG EXISTS/, out);
  assert.ok(out.includes(s.rules.first) && out.includes(sha), out);
  assert.deepEqual(s.rules.refs(), before);
  assert.equal(s.rules.releaseAt(), s.rules.second);
});

test("G7b: a remote that refuses the tag ref refuses the whole push (atomic): release does not move, and the read-back names both refs", (t) => {
  const { s, sha } = moved(t, { ...hookChange(), ...bump("1.6.1") });
  // An `update` hook judges each ref on its own: without --atomic release would move and only the tag would fail.
  const hook = path.join(s.rules.url, "hooks", "update");
  fs.writeFileSync(hook, ["#!/bin/sh", 'case "$1" in refs/tags/*) echo "no tags here" >&2; exit 1;; esac', "exit 0", ""].join("\n"));
  fs.chmodSync(hook, 0o755);
  const { code, out } = s.promote([sha]);
  assert.equal(code, EXIT.UNDECIDED, out);
  assert.match(out, /PUSH REFUSED/, out);
  assert.equal(s.rules.releaseAt(), s.rules.second, "release did NOT move");
  assert.equal(s.rules.refAt(TAG("1.6.1")), "", "the tag did not appear");
  assert.ok(out.includes("refs/heads/release") && out.includes(TAG("1.6.1")), `the read-back names both refs: ${out}`);
});

// ── G8: a change outside plugins/ is a release without a tag ─────────────────────────────────────

test("G8: only README.md, .github/ and tools/ changed: release moves, no tag, and the line says so", (t) => {
  const { s, sha } = moved(t, { "README.md": "new words\n", ".github/workflows/ci.yml": "name: ci\n# edited\n", "tools/x.mjs": "export const x = 1;\n" });
  const { code, out } = s.promote([sha]);
  assert.equal(code, EXIT.PROMOTED, out);
  assert.equal(s.rules.releaseAt(), sha);
  assert.deepEqual(tagRefs(s), [], "no tag ref");
  assert.match(out, /plugins: none changed/, out);
});

// ── the dry run ──────────────────────────────────────────────────────────────────────────────────

test("dry: G6's scene with --dry-run pushes nothing and prints the four lines", (t) => {
  const { s, sha } = moved(t, { ...hookChange(), ...bump("1.6.1"), "tools/x.mjs": "export const x = 1;\n" });
  const before = s.rules.refs();
  const { code, out } = s.promote([sha, "--dry-run"]);
  assert.equal(code, EXIT.PROMOTED, out);
  assert.deepEqual(s.rules.refs(), before, "a dry run pushes nothing");
  const lines = out.split("\n");
  assert.ok(lines.includes(`promote-release: DRY RUN — would push ${sha}:refs/heads/release to origin: release ${s.rules.second} → ${sha} (+1 commit(s)), with the tag ${TAG("1.6.1")}. Nothing pushed.`), out);
  assert.ok(lines.includes(`promote-release: compare https://github.com/${SLUG}/compare/${s.rules.second}...${sha}`), out);
  assert.ok(lines.includes("promote-release: plugins: agent-models 1.6.0 → 1.6.1, 2 file(s)"), out);
  assert.ok(lines.includes(`promote-release: gate: runs at ${s.rules.second}; tools/ and .github/ differ from ${sha} in: tools/x.mjs`), out);
  assert.doesNotMatch(out, /PROMOTED/, out);

  // the checkout is the promoted commit: the gate is the promoted commit's own
  const late = path.join(s.root, "runner-late");
  execFileSync("git", ["clone", "-q", s.rules.url, late], { timeout: 20000 });
  const again = run(late, [sha, "--dry-run"], s.env);
  assert.equal(again.code, EXIT.PROMOTED, again.out);
  assert.ok(again.out.split("\n").includes("promote-release: gate: runs at the promoted commit"), again.out);
});

test("dry: with no release yet the compare line is the commit's own and every plugin is new", (t) => {
  const s = scene(t);
  s.github.lists([ciRun(s.rules.first)]);
  const { code, out } = s.promote([s.rules.first, "--dry-run"]);
  assert.equal(code, EXIT.PROMOTED, out);
  const lines = out.split("\n");
  assert.ok(lines.includes(`promote-release: compare https://github.com/${SLUG}/commits/${s.rules.first}`), out);
  assert.ok(lines.includes("promote-release: plugins: agent-models none → 1.6.0, 4 file(s)"), out);
});

