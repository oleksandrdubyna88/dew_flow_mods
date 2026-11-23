/**
 * The parsers and the pager of `promote-release.mjs`, as units and through the tool: `repositorySlug`, `ciRunsFor`,
 * `judgeRuns`, `total_count`, a failed run on the second page, a refused push that says where release is.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { EXIT, ciRunsFor, judgeRuns, repositorySlug } from "./promote-release.mjs";
import { SLUG, commit, ciRun, scene, runsQuery } from "./promote-release.fixture.mjs";

// ── the parsers, as units ─────────────────────────────────────────────────────────────────────────

test("repositorySlug refuses when GITHUB_REPOSITORY names a repository origin does not", () => {
  // The variable decides WHOSE ci runs vouch for the sha; the push always goes to origin. Letting
  // them disagree lets a fork's or mirror's green run authorise a ref on this remote — so a mismatch
  // is not resolved in either direction, it returns nothing and the caller's WHICH REPOSITORY branch
  // stops the run.
  const origin = (url) => (...args) => {
    assert.deepEqual(args, ["remote", "get-url", "origin"]);
    return url;
  };
  assert.equal(repositorySlug({ GITHUB_REPOSITORY: "acme/rules" }, origin("https://github.com/acme/rules.git")), "acme/rules",
    "agreeing is the only way through");
  assert.equal(repositorySlug({ GITHUB_REPOSITORY: "ACME/Rules" }, origin("https://github.com/acme/rules.git")), "ACME/Rules",
    "GitHub owners and names are case-insensitive");
  assert.equal(repositorySlug({ GITHUB_REPOSITORY: "attacker/fork" }, origin("https://github.com/acme/rules.git")), "",
    "a fork's runs may not vouch for a sha pushed to this origin");

  assert.equal(repositorySlug({}, origin("https://github.com/acme/rules.git")), "acme/rules");
  assert.equal(repositorySlug({}, origin("https://github.com/acme/rules")), "acme/rules");
  assert.equal(repositorySlug({}, origin("git@github.com:acme/rules.git")), "acme/rules");
  assert.equal(repositorySlug({}, origin("ssh://git@github.com/acme/rules.git")), "acme/rules");
  assert.equal(repositorySlug({}, origin("D:/rsd/conventions.git")), "", "a local path names no GitHub repository");

  // Origin unparseable as GitHub — a local bare remote, as every test here uses — leaves the variable
  // as the only statement about which repository this is, and nothing to contradict it.
  assert.equal(repositorySlug({ GITHUB_REPOSITORY: "acme/rules" }, origin("D:/rsd/conventions.git")), "acme/rules");
  assert.equal(repositorySlug({ GITHUB_REPOSITORY: "not a slug" }, origin("D:/rsd/conventions.git")), "");
  assert.equal(repositorySlug({}, () => { throw new Error("fatal: No such remote 'origin'"); }), "");
});

test("ciRunsFor keeps only ci runs for the sha, and names why an answer could not be read", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(ciRunsFor("", sha), { error: "the answer is not JSON" });
  assert.deepEqual(ciRunsFor('{"message":"Not Found"}', sha), { error: "the answer carries no workflow_runs list" });
  const listing = JSON.stringify({ total_count: 3, workflow_runs: [
    ciRun(sha),
    ciRun(sha, { name: "other", path: ".github/workflows/other.yml" }),
    ciRun("b".repeat(40)),
    ciRun(sha.toUpperCase(), { name: "renamed", path: ".github/workflows/ci.yml", id: 7 }),
  ] });
  const { runs } = ciRunsFor(listing, sha);
  assert.deepEqual(runs.map((r) => r.id), [4242, 7], "matched by name OR by path; the sha is compared case-insensitively");
});

test("judgeRuns passes only when every run is completed and successful", () => {
  const sha = "a".repeat(40);
  assert.equal(judgeRuns([], sha, SLUG).headline, "NO CI RUN");
  assert.equal(judgeRuns([ciRun(sha, { status: "in_progress", conclusion: null })], sha, SLUG).headline, "CI NOT FINISHED");
  assert.equal(judgeRuns([ciRun(sha), ciRun(sha, { status: "queued" })], sha, SLUG).headline, "CI NOT FINISHED");
  assert.equal(judgeRuns([ciRun(sha), ciRun(sha, { conclusion: "skipped" })], sha, SLUG).headline, "CI NOT GREEN");
  const pass = judgeRuns([ciRun(sha), ciRun(sha, { id: 1, html_url: undefined })], sha, SLUG);
  assert.equal(pass.ok, true);
  assert.deepEqual(pass.urls, ["https://github.com/example/conventions/actions/runs/4242", "run 1"]);
  for (const refusal of [judgeRuns([], sha, SLUG), judgeRuns([ciRun(sha, { conclusion: "failure" })], sha, SLUG)]) {
    assert.equal(refusal.ok, false);
    assert.equal(refusal.code, EXIT.REFUSED);
    assert.ok(refusal.lines.some((l) => l.startsWith("fix:")), "every refusal carries a cure");
  }
});

test("importing the module moves nothing and sets no exit code", () => {
  // The entry guard: `node --test` loaded this file, which imported the tool. Had the tool run its
  // main on import it would have printed usage and left EXIT.USAGE in process.exitCode.
  assert.ok(process.exitCode === undefined || process.exitCode === 0, `process.exitCode is ${process.exitCode}`);
});

// ── what the code round of 2026-09-14 added ──────────────────────────────────────────────────────

test("a total_count that is not a count makes the answer unreadable", () => {
  // The pager uses total_count to know whether it has seen everything, so an answer without a real
  // one is unreadable rather than complete. Treating a missing count as "nothing more to fetch"
  // would let one page of successes stand in for a listing whose later pages hold the failed run.
  const sha = "a".repeat(40);
  const runs = [ciRun(sha)];
  assert.match(ciRunsFor(JSON.stringify({ workflow_runs: runs }), sha).error, /total_count is undefined/);
  assert.match(ciRunsFor(JSON.stringify({ total_count: "lots", workflow_runs: runs }), sha).error, /not a count of runs/);
  assert.match(ciRunsFor(JSON.stringify({ total_count: -1, workflow_runs: runs }), sha).error, /not a count of runs/);

  // The values that COERCE to a number, which is why the count is type-checked rather than passed
  // through `Number()`. Each of these becomes 0, and a total of 0 tells the pager it has seen
  // everything after one page — so a malformed answer would end the listing while looking complete,
  // which is exactly the shape the paging exists to refuse.
  for (const total of [null, false, [], ""]) {
    const answer = JSON.stringify({ total_count: total, workflow_runs: runs });
    assert.match(ciRunsFor(answer, sha).error ?? "", /not a count of runs/,
      `total_count ${JSON.stringify(total)} coerces to 0 and must not be read as a count`);
  }
  // A numeric STRING is the near miss: it looks right and is not.
  assert.match(ciRunsFor(JSON.stringify({ total_count: "1", workflow_runs: runs }), sha).error ?? "", /not a count of runs/);

  const good = ciRunsFor(JSON.stringify({ total_count: 1, workflow_runs: runs }), sha);
  assert.equal(good.error, undefined);
  assert.deepEqual([good.total, good.listed, good.runs.length], [1, 1, 1]);
});

test("a failed ci run on the SECOND page still refuses the promotion", (t) => {
  // The judgement is "every run is green", so a listing that stopped at one page could be missing
  // exactly the run that disqualifies the sha. Here page one is a hundred successes and the failure
  // is on page two \u— the sha must be refused, and both pages must actually be asked for.
  const s = scene(t);
  const green = Array.from({ length: 100 }, (_, i) => ciRun(s.rules.second, { id: 1000 + i }));
  const answers = [
    { stdout: JSON.stringify({ total_count: 101, workflow_runs: green }) },
    { stdout: JSON.stringify({ total_count: 101, workflow_runs: [ciRun(s.rules.second, { id: 9999, conclusion: "failure" })] }) },
  ];
  s.github.answersInOrder(answers);

  const { code, out } = s.promote([s.rules.second]);
  assert.equal(code, EXIT.REFUSED, out);
  assert.match(out, /CI NOT GREEN/, out);
  assert.deepEqual(s.github.calls(), [runsQuery(s.rules.second, 1), runsQuery(s.rules.second, 2)],
    "both pages were asked for, in order");
  assert.equal(s.rules.releaseAt(), "", "nothing was pushed");
});

test("a refused push says where release actually is, instead of only that nothing moved", (t) => {
  // The new read-back in the catch path. Its real purpose is the race where the remote ACCEPTED the
  // update and the connection dropped before the answer arrived \u— reporting that as "nothing was
  // pushed" sends an operator to repair a state that is already correct. That race cannot be staged
  // deterministically against a local bare remote (see research/module_tests.md), so what is asserted
  // here is the half that can be: after a push the remote genuinely refuses, the tool asks where
  // release is and says so, rather than leaving the reader to guess.
  const s = scene(t);
  s.github.lists([ciRun(s.rules.second)]);
  s.rules.release(s.rules.first);             // release exists, one commit behind \u— a forward move
  const hook = path.join(s.rules.url, "hooks", "pre-receive");
  fs.writeFileSync(hook, ["#!/bin/sh", "exit 1", ""].join("\n"));
  fs.chmodSync(hook, 0o755);

  const { code, out } = s.promote([s.rules.second]);
  assert.equal(code, EXIT.UNDECIDED, out);
  assert.match(out, /PUSH REFUSED/, out);
  assert.match(out, new RegExp(`release is still ${s.rules.first}`), out);
  assert.equal(s.rules.releaseAt(), s.rules.first, "the ref really did not move");
});
