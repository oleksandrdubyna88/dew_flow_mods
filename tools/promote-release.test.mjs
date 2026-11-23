#!/usr/bin/env node
/**
 * `promote-release.mjs`'s own tests — every way the gate closes, exercised against real repositories: the shape of the
 * argument, ancestry, the ci run, the push, and the evidence that could not be gathered. Each case is named after the
 * GUARANTEE a consumer relies on and asserts the exit code AND the words a workflow log would show. The fixture
 * (real git, GitHub as a function) is in promote-release.fixture.mjs; the parsers are in promote-release-units.test.mjs,
 * the gate's own cases (G1-G8, the dry run) in promote-release-gate.test.mjs, the layout (G9) in mods-gate.test.mjs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { EXIT, RELEASE_REF } from "./promote-release.mjs";
import { SLUG, git, TAG_160, checkout, ciRun, run, scene, runsQuery } from "./promote-release.fixture.mjs";

// ── the shape of the argument ─────────────────────────────────────────────────────────────────────

test("a sha that is not a full 40-character hex is refused before anything is asked", (t) => {
  const s = scene(t);
  s.github.lists([ciRun(s.rules.first)]);
  for (const named of ["main", s.rules.first.slice(0, 7), "v1.0", `${s.rules.first}0`, "refs/heads/main"]) {
    const { code, out } = s.promote([named]);
    assert.equal(code, EXIT.REFUSED, out);
    assert.match(out, /REFUSED — NOT A SHA/, out);
    assert.match(out, /not a full 40-character commit id/, out);
    assert.match(out, /No push was attempted/, out);
  }
  assert.deepEqual(s.github.calls(), [], "GitHub is never asked about something that is not a commit id");
  assert.equal(s.rules.releaseAt(), "");
});

test("an upper-case sha names the same commit and is not malformed", (t) => {
  const s = scene(t);
  s.github.lists([ciRun(s.rules.first)]);
  const { code, out } = s.promote([s.rules.first.toUpperCase(), "--dry-run"]);
  assert.equal(code, EXIT.PROMOTED, out);
  assert.match(out, /DRY RUN/, out);
  assert.deepEqual(s.github.calls(), [runsQuery(s.rules.first)], "the API is asked with the lower-cased sha GitHub stores");
});

test("the command takes exactly one sha, and an option that would rewind does not exist", (t) => {
  const s = scene(t);
  const none = s.promote([]);
  assert.equal(none.code, EXIT.USAGE, none.out);
  assert.match(none.out, /no sha was given/, none.out);

  const two = s.promote([s.rules.first, s.rules.second]);
  assert.equal(two.code, EXIT.USAGE, two.out);
  assert.match(two.out, /one sha, not 2/, two.out);

  for (const flag of ["--force", "--rewind", "--allow-backwards"]) {
    const { code, out } = s.promote([s.rules.first, flag]);
    assert.equal(code, EXIT.USAGE, out);
    assert.match(out, /Unknown option/, out);
    assert.match(out, /no --force and no rewind: release moves forward only/, out);
  }
  assert.deepEqual(s.github.calls(), []);
  assert.equal(s.rules.releaseAt(), "");
});

// ── ancestry: a release is a commit that merged ───────────────────────────────────────────────────

test("a commit main does not reach is refused as not on main, however green its own ci run is", (t) => {
  // The guarantee the plan states first: "a release is a commit that merged, never a branch tip". The
  // double is primed with a GREEN run for the branch tip, so if this ever passes, ancestry is not
  // being checked — CI alone would have let it through.
  const s = scene(t);
  s.github.lists([ciRun(s.rules.topic)]);
  const { code, out } = s.promote([s.rules.topic]);
  assert.equal(code, EXIT.REFUSED, out);
  assert.match(out, /REFUSED — NOT ON MAIN/, out);
  assert.match(out, new RegExp(`main is ${s.rules.second}, and it does not reach ${s.rules.topic}`), out);
  assert.match(out, /never a branch tip/, out);
  assert.deepEqual(s.github.calls(), [], "ancestry is settled locally; GitHub is not asked about a commit that never merged");
  assert.equal(s.rules.releaseAt(), "");
});

test("a sha this checkout has never seen is not on main — a refusal with a cure, not a crash", (t) => {
  const s = scene(t);
  const unknown = "b".repeat(40);
  const { code, out } = s.promote([unknown]);
  assert.equal(code, EXIT.REFUSED, out);
  assert.match(out, /REFUSED — NOT ON MAIN/, out);
  assert.match(out, new RegExp(`no commit ${unknown} at all`), out);
  assert.match(out, /fix: {3}check the sha against `git log origin\/main`/, out);
  assert.doesNotMatch(out, /at file:/, "a stack trace is not a finding");
});

// ── the ci run: the single most important behaviour ───────────────────────────────────────────────

test("a sha with no ci run at all is refused, never passed as harmless", (t) => {
  const s = scene(t);
  s.github.lists([]);
  const { code, out } = s.promote([s.rules.first]);
  assert.equal(code, EXIT.REFUSED, out);
  assert.match(out, /REFUSED — NO CI RUN/, out);
  assert.match(out, new RegExp(`no run of the \`ci\` workflow for ${s.rules.first} in ${SLUG}`), out);
  assert.match(out, /An absent run is not a pass/, out);
  assert.deepEqual(s.github.calls(), [runsQuery(s.rules.first)]);
  assert.equal(s.rules.releaseAt(), "", "nothing moved");
});

test("a ci run still in progress is refused, and the refusal says so rather than waiting", (t) => {
  const s = scene(t);
  for (const status of ["in_progress", "queued", "waiting"]) {
    s.github.lists([ciRun(s.rules.first, { status, conclusion: null })]);
    const { code, out } = s.promote([s.rules.first]);
    assert.equal(code, EXIT.REFUSED, out);
    assert.match(out, /REFUSED — CI NOT FINISHED/, out);
    assert.match(out, new RegExp(`run for ${s.rules.first} is ${status} \\(https://github\\.com/`), out);
    assert.match(out, /has verified nothing yet/, out);
  }
  assert.equal(s.rules.releaseAt(), "");
});

test("a ci run that completed without success is refused by its conclusion", (t) => {
  const s = scene(t);
  for (const conclusion of ["failure", "cancelled", "timed_out", "startup_failure"]) {
    s.github.lists([ciRun(s.rules.first, { conclusion })]);
    const { code, out } = s.promote([s.rules.first]);
    assert.equal(code, EXIT.REFUSED, out);
    assert.match(out, /REFUSED — CI NOT GREEN/, out);
    assert.match(out, new RegExp(`completed with conclusion ${conclusion} \\(https://github\\.com/`), out);
  }
  assert.equal(s.rules.releaseAt(), "");
});

test("a green run of another workflow for the same sha does not count as ci", (t) => {
  // `head_sha=` returns EVERY workflow's runs for the commit. A green release-distance report, or a
  // docs-only job, verifies nothing about the tools six repositories run.
  const s = scene(t);
  s.github.lists([ciRun(s.rules.first, { name: "release-distance", path: ".github/workflows/release-distance.yml" })]);
  const { code, out } = s.promote([s.rules.first]);
  assert.equal(code, EXIT.REFUSED, out);
  assert.match(out, /REFUSED — NO CI RUN/, out);
});

test("a green ci run for a different sha does not vouch for this one", (t) => {
  // The filter is GitHub's; the check is ours. An answer that lists main's tip while the question was
  // about an older commit — a misrouted query, a lying double — must not read as evidence.
  const s = scene(t);
  s.github.lists([ciRun(s.rules.second)]);
  const { code, out } = s.promote([s.rules.first]);
  assert.equal(code, EXIT.REFUSED, out);
  assert.match(out, /REFUSED — NO CI RUN/, out);
});

test("two ci runs for one sha must both be green — a failed twin is not outvoted", (t) => {
  const s = scene(t);
  s.github.lists([ciRun(s.rules.first), ciRun(s.rules.first, { id: 4243, conclusion: "failure" })]);
  const { code, out } = s.promote([s.rules.first]);
  assert.equal(code, EXIT.REFUSED, out);
  assert.match(out, /REFUSED — CI NOT GREEN/, out);
  assert.match(out, /2 run\(s\) listed; every one must be completed and successful/, out);
});

// ── the push ──────────────────────────────────────────────────────────────────────────────────────

test("the happy path pushes exactly refs/heads/release at the promoted sha, and asks GitHub about exactly that sha", (t) => {
  const s = scene(t);
  s.github.lists([ciRun(s.rules.first)]);
  const before = s.rules.refs();
  const { code, out } = s.promote([s.rules.first]);
  assert.equal(code, EXIT.PROMOTED, out);
  assert.match(out, new RegExp(`PROMOTED — origin/release is ${s.rules.first}`), out);
  assert.equal(s.rules.releaseAt(), s.rules.first, "release is the promoted commit");
  // The first commit carries the plugin at 1.6.0 and `release` does not exist: the first promotion of a plugin
  // creates its tag too, in the same atomic push (G6).
  assert.deepEqual(s.rules.refs(), [...before, RELEASE_REF, TAG_160].sort(), "a branch and the plugin's tag appeared, nothing else moved");
  assert.equal(git(s.rules.work, "ls-remote", s.rules.url, "refs/heads/main").split(/\s+/)[0], s.rules.second, "main is untouched");
  assert.deepEqual(s.github.calls(), [runsQuery(s.rules.first)], "one question, about this sha, in this repository");
});

test("--dry-run pushes nothing, and says what it would have pushed", (t) => {
  const s = scene(t);
  s.github.lists([ciRun(s.rules.first)]);
  const { code, out } = s.promote([s.rules.first, "--dry-run"]);
  assert.equal(code, EXIT.PROMOTED, out);
  assert.match(out, new RegExp(`DRY RUN — would push ${s.rules.first}:refs/heads/release to origin: release does not exist yet`), out);
  assert.match(out, /Nothing pushed\./, out);
  assert.doesNotMatch(out, /PROMOTED/, out);
  assert.equal(s.rules.releaseAt(), "", "a dry run creates no ref");
  assert.deepEqual(s.github.calls(), [runsQuery(s.rules.first)], "the judgement still ran in full");
});

test("a dry run of a sha that would be refused reports the refusal, not a would-push", (t) => {
  // The flag suppresses the push, never the judgement — otherwise a dry run could only ever say yes.
  const s = scene(t);
  s.github.lists([ciRun(s.rules.first, { conclusion: "failure" })]);
  const { code, out } = s.promote([s.rules.first, "--dry-run"]);
  assert.equal(code, EXIT.REFUSED, out);
  assert.match(out, /REFUSED — CI NOT GREEN/, out);
  assert.doesNotMatch(out, /DRY RUN|would push/, out);
});

test("release advances forward from the old commit to the new one, and says by how much", (t) => {
  const s = scene(t);
  s.rules.release(s.rules.first);
  s.github.lists([ciRun(s.rules.second)]);
  const { code, out } = s.promote([s.rules.second]);
  assert.equal(code, EXIT.PROMOTED, out);
  assert.match(out, new RegExp(`release ${s.rules.first} → ${s.rules.second} \\(\\+1 commit\\(s\\)\\)`), out);
  assert.equal(s.rules.releaseAt(), s.rules.second);
});

test("release never moves backwards: an older sha is refused, and the refusal names the forward-release rollback", (t) => {
  // The commit is on main and its run is GREEN — everything but the direction is in order — so the
  // only thing that can refuse it is the rule that release moves forward.
  const s = scene(t);
  s.rules.release(s.rules.second);
  s.github.lists([ciRun(s.rules.first)]);
  const { code, out } = s.promote([s.rules.first]);
  assert.equal(code, EXIT.REFUSED, out);
  assert.match(out, /REFUSED — NOT A FORWARD MOVE/, out);
  assert.match(out, new RegExp(`release is ${s.rules.second}, and ${s.rules.first} is BEHIND it by 1 commit`), out);
  assert.match(out, /revert the content on main, merge, and promote the NEW commit/, out);
  assert.equal(s.rules.releaseAt(), s.rules.second, "release did not move");
  assert.deepEqual(s.github.calls(), [], "the direction is settled before GitHub is asked");
});

test("a commit beside release — neither reaches the other — is not a forward move either", (t) => {
  // release was hand-pushed to a commit that is not on main (the ruleset exists to prevent exactly
  // this; the tool must still cope). main's tip does not descend from it, so promoting main's tip
  // would be a sideways rewrite of the ref, and the tool has no way to do one.
  const s = scene(t);
  s.rules.release(s.rules.stray);
  s.github.lists([ciRun(s.rules.second)]);
  const { code, out } = s.promote([s.rules.second]);
  assert.equal(code, EXIT.REFUSED, out);
  assert.match(out, /REFUSED — NOT A FORWARD MOVE/, out);
  assert.match(out, /is beside it — neither reaches the other/, out);
  assert.equal(s.rules.releaseAt(), s.rules.stray);
});

test("promoting the commit release already points at moves nothing and exits 0, so the workflow can be re-run", (t) => {
  const s = scene(t);
  s.rules.release(s.rules.first);
  s.github.lists([ciRun(s.rules.first)]);
  const { code, out } = s.promote([s.rules.first]);
  assert.equal(code, EXIT.PROMOTED, out);
  assert.match(out, new RegExp(`release is already ${s.rules.first} — nothing to move`), out);
  assert.deepEqual(s.github.calls(), [runsQuery(s.rules.first)], "still verified — an idempotent re-run is not an unchecked one");
});

test("a sha release already points at is still refused when its ci run is not green", (t) => {
  // Nothing would move, and the tool still says no: it never exits 0 for a commit it could not
  // verify, because "already there" would otherwise launder a hand-pushed ref into a pass.
  const s = scene(t);
  s.rules.release(s.rules.first);
  s.github.lists([ciRun(s.rules.first, { conclusion: "failure" })]);
  const { code, out } = s.promote([s.rules.first]);
  assert.equal(code, EXIT.REFUSED, out);
  assert.match(out, /REFUSED — CI NOT GREEN/, out);
});

// ── evidence that could not be gathered is not evidence ───────────────────────────────────────────

test("an unreadable answer from GitHub is no answer, not an absence of runs", (t) => {
  const s = scene(t);
  s.github.answers({ stdout: "<html><body>rate limited</body></html>" });
  const { code, out } = s.promote([s.rules.first]);
  assert.equal(code, EXIT.UNDECIDED, out);
  assert.match(out, /UNDECIDED — UNREADABLE ANSWER/, out);
  assert.match(out, /the answer is not JSON/, out);
  assert.doesNotMatch(out, /NO CI RUN/, "garbage must not be read as an empty listing");
  assert.equal(s.rules.releaseAt(), "");
});

test("gh failing is a refusal to decide, and the refusal carries gh's own words", (t) => {
  const s = scene(t);
  s.github.answers({ exitCode: 1, stderr: "gh: Bad credentials (HTTP 401)\n" });
  const { code, out } = s.promote([s.rules.first]);
  assert.equal(code, EXIT.UNDECIDED, out);
  assert.match(out, /UNDECIDED — GITHUB NOT ASKED/, out);
  assert.match(out, /Bad credentials \(HTTP 401\)/, out);
  assert.match(out, /no evidence is a refusal/, out);
  assert.equal(s.rules.releaseAt(), "");
});

test("a shallow checkout cannot judge ancestry, and says so instead of guessing", (t) => {
  // A local-path clone silently ignores --depth ("--depth is ignored in local clones"), so the remote
  // is re-addressed as file:// — the same trap the plan's G1 measurement walked into.
  const s = scene(t);
  const fileUrl = s.rules.url.startsWith("/") ? `file://${s.rules.url}` : `file:///${s.rules.url}`;
  const shallow = checkout(s.root, fileUrl, "--depth", "1");
  assert.equal(git(shallow, "rev-parse", "--is-shallow-repository"), "true", "the fixture must actually be shallow");
  s.github.lists([ciRun(s.rules.second)]);
  const { code, out } = run(shallow, [s.rules.second], s.env);
  assert.equal(code, EXIT.UNDECIDED, out);
  assert.match(out, /UNDECIDED — SHALLOW CHECKOUT/, out);
  assert.match(out, /fetch-depth: 0/, out);
  assert.equal(s.rules.releaseAt(), "");
});

test("when it cannot tell which GitHub repository to ask, it stops rather than asking the wrong one", (t) => {
  // origin here is a local path, not github.com, and GITHUB_REPOSITORY is removed — including the one
  // the runner itself carries when this suite runs under Actions.
  const s = scene(t);
  const env = { ...s.env };
  delete env.GITHUB_REPOSITORY;
  s.github.lists([ciRun(s.rules.first)]);
  const { code, out } = run(s.runner, [s.rules.first], env);
  assert.equal(code, EXIT.UNDECIDED, out);
  assert.match(out, /UNDECIDED — WHICH REPOSITORY/, out);
  assert.match(out, /set GITHUB_REPOSITORY=owner\/name/, out);
  assert.deepEqual(s.github.calls(), []);
});
