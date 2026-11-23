#!/usr/bin/env node
/**
 * `promote-release.mjs`'s own tests — every way the gate closes, exercised against real repositories.
 *
 * The plan that ordered this tool says why in one sentence: "a gate that has only ever been exercised
 * on its happy path is a gate nobody has seen close." Each case here is named after the GUARANTEE a
 * consumer relies on, and asserts the exit code AND the words a workflow log would show, because a
 * refusal that exits 1 with the wrong reason sends the operator to fix the wrong thing.
 *
 * Real git, no fixtures: the thing under test is a statement about a remote — *is this commit on main,
 * does release move forward to it* — and a directory of files cannot express "a branch tip beside main".
 * So each case builds a bare remote with a `main`, a merged history, an unmerged `topic` and a `stray`
 * branch off an older commit, then clones it the way the workflow's checkout would.
 *
 * GitHub is a scripted double, injected as a FUNCTION. Each case spawns a tiny entry script that
 * imports the tool's own `main` — real argv parsing, real git, real judgement — and hands it a `gh`
 * that answers from a JSON file the test wrote and records every argv it was given. So the happy path
 * asserts not only that release moved but that GitHub was asked about EXACTLY that sha, and the
 * refusals assert GitHub was never asked at all when ancestry already settled it. Production has no
 * environment variable naming the `gh` executable: three reviewers called that a way to forge the
 * very evidence this gate checks, and a function parameter is not something an environment can set.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EXIT, RELEASE_REF, ciRunsFor, judgeRuns, repositorySlug } from "./promote-release.mjs";
import { FORBIDDEN_NAMES, layoutFindings } from "./mods-gate.mjs";
import { ownedDir } from "../.agents/conventions/tools/lib/owned.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tool = path.join(here, "promote-release.mjs");

/** The repository the double answers for; GITHUB_REPOSITORY carries it into the tool, as Actions would. */
const SLUG = "example/conventions";

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 20000, windowsHide: true }).trim();

/**
 * Write files (a null value deletes one; `{ link }` is a symlink; `{ gitlink: true }` a nested repository, which
 * `git add` records as a gitlink), then commit everything. With no files it is an empty commit, as before.
 */
function commit(work, message, files = {}) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(work, rel);
    if (text === null) { fs.rmSync(file, { force: true }); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (typeof text === "object" && text.link !== undefined) fs.symlinkSync(text.link, file);
    else if (typeof text === "object" && text.gitlink === true) {
      fs.mkdirSync(file, { recursive: true });
      execFileSync("git", ["init", "-q", file], { timeout: 20000 });
      git(file, "-c", "user.name=Nested", "-c", "user.email=nested@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "nested");
    } else fs.writeFileSync(file, text);
  }
  git(work, "add", "-A");
  return git(work, "-c", "user.name=Release test", "-c", "user.email=release@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "-q", "--allow-empty", "-m", message);
}

// ── the tree every commit of the fixture carries (this repository's layout: one catalog, one plugin) ──
const MANIFEST = (name, version) => `${JSON.stringify({ name, version }, null, 2)}\n`;
const CAT_ENTRY = (name) => ({ name, source: `./plugins/${name}`, description: `the ${name} mod` });
const CATALOG = (plugins = [CAT_ENTRY("agent-models")], extra = {}) =>
  `${JSON.stringify({ name: "dew-flow-mods", owner: { name: "owner" }, metadata: { description: "mods" }, plugins, ...extra }, null, 2)}\n`;
const BASE_TREE = () => ({
  "README.md": "a stub\n",
  ".claude-plugin/marketplace.json": CATALOG(),
  "plugins/agent-models/.claude-plugin/plugin.json": MANIFEST("agent-models", "1.6.0"),
  "plugins/agent-models/hooks/hooks.json": "{}\n",
  "plugins/agent-models/hooks/limits.tsx": "export const a = 1;\n",
  "plugins/agent-models/tests/limits.test.tsx": "test\n",
  "tools/x.mjs": "export {};\n",
  ".github/workflows/ci.yml": "name: ci\n",
});
/** A second plugin: its entry is added to the catalog by the caller, its folder comes from here. */
const PLUGIN_TREE = (name, version) => ({
  [`plugins/${name}/.claude-plugin/plugin.json`]: MANIFEST(name, version),
  [`plugins/${name}/hooks/hooks.json`]: "{}\n",
});
const TAG_160 = "refs/tags/agent-models--v1.6.0";

function workspace(t) {
  const root = ownedDir(t, "promote-release");
  return root;
}

/**
 * A bare remote shaped like the conventions repository on a promotion day: `main` two commits deep,
 * `topic` one commit past main that never merged, and `stray` one commit off the OLDER main commit —
 * so there is a sha behind main's tip, one beside it, and one that reaches neither.
 */
function remote(root, name) {
  // Forward slashes: the url is spawned as an argument here, never written into a config file, but
  // `file://` (used by the shallow case) needs them either way.
  const url = path.join(root, `${name}.git`).replaceAll("\\", "/");
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", url], { timeout: 20000 });
  const work = path.join(root, `${name}-work`);
  execFileSync("git", ["clone", "-q", url, work], { timeout: 20000 });
  commit(work, "first — the published version", BASE_TREE());
  const first = git(work, "rev-parse", "HEAD");
  commit(work, "second — written since", { "README.md": "a stub, written since\n" });
  const second = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "-b", "topic");
  commit(work, "on a branch, never merged", { "topic.txt": "topic\n" });
  const topic = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "-b", "stray", first);
  commit(work, "beside main — shares only the first commit with it", { "stray.txt": "stray\n" });
  const stray = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "main");
  git(work, "push", "-q", "origin", "main", "topic", "stray");
  const release = (sha) => git(work, "push", "-q", "origin", `${sha}:${RELEASE_REF}`);
  const releaseAt = () => git(work, "ls-remote", url, RELEASE_REF).split(/\s+/)[0] ?? "";
  const refs = () => git(work, "ls-remote", "--refs", url).split("\n").filter(Boolean).map((l) => l.split(/\s+/)[1]).sort();
  /** The sha a remote ref has, or "" (any ref, a tag in full). */
  const refAt = (ref) => git(work, "ls-remote", url, ref).split(/\s+/)[0] ?? "";
  /** ls-remote's own lines for the ref: a lightweight tag has one, an annotated one has a second `^{}` line. */
  const refLines = (ref) => git(work, "ls-remote", url, ref, `${ref}^{}`).split("\n").filter(Boolean);
  /** A commit on main with these files (null deletes), pushed; the checkout the workflow made fetches it itself. */
  const advance = (files, message = "written later") => {
    git(work, "checkout", "-q", "main");
    commit(work, message, files);
    git(work, "push", "-q", "origin", "main");
    return git(work, "rev-parse", "HEAD");
  };
  /** A tag at a sha, pushed straight to the remote. */
  const tag = (name, sha) => git(work, "push", "-q", "origin", `${sha}:refs/tags/${name}`);
  return { url, work, first, second, topic, stray, release, releaseAt, refs, refAt, refLines, advance, tag };
}

/** The workflow's checkout: a full clone of the remote, which is what the tool runs in. */
function checkout(root, url, ...cloneFlags) {
  const dir = path.join(root, `runner-${cloneFlags.length}`);
  execFileSync("git", ["clone", "-q", ...cloneFlags, url, dir], { timeout: 20000 });
  return dir;
}

/**
 * The entry the tests spawn instead of the tool itself.
 *
 * It is a real process running real argv parsing, real git and the tool's own `main` — but it passes
 * `gh` as a FUNCTION. That matters: the tool used to read an environment variable naming the `gh`
 * executable, and three reviewers called it what it was, a way for an inherited or injected variable
 * on a self-hosted runner to forge the CI evidence the gate exists to check. A function parameter
 * cannot be set by an environment, so the seam the tests need does not exist in production at all.
 */
const ENTRY = (tool) => [
  'import * as fs from "node:fs";',
  `import { main } from ${JSON.stringify(pathToFileURL(tool).href)};`,
  'const calls = () => {',
  '  try { return fs.readFileSync(process.env.FAKE_GH_LOG, "utf8").split("\\n").filter(Boolean).length; }',
  '  catch { return 0; }',
  '};',
  'const gh = async (...args) => {',
  '  // The answer file is one spec, or a list of them to hand out in order — which is how the pager',
  '  // can be given a full first page and a failing second one. Past the end, the last spec repeats.',
  '  const nth = calls();',
  '  fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");',
  '  const written = JSON.parse(fs.readFileSync(process.env.FAKE_GH_ANSWER, "utf8"));',
  '  const list = Array.isArray(written) ? written : [written];',
  '  const answer = list[Math.min(nth, list.length - 1)];',
  '  if ((answer.exitCode ?? 0) !== 0) throw new Error(answer.stderr ?? `gh exited ${answer.exitCode}`);',
  '  return answer.stdout ?? "";',
  '};',
  'process.exitCode = await main(process.argv.slice(2), process.env, console.log, console.error, gh);',
  "",
].join("\n");

function fakeGitHub(root) {
  const entry = path.join(root, "entry.mjs");
  fs.writeFileSync(entry, ENTRY(tool));
  const answerFile = path.join(root, "gh-answer.json");
  const logFile = path.join(root, "gh-calls.log");
  const github = {
    env: { FAKE_GH_ENTRY: entry, FAKE_GH_ANSWER: answerFile, FAKE_GH_LOG: logFile },
    answers(spec) { fs.writeFileSync(answerFile, JSON.stringify(spec)); },
    /** Hand out one spec per call, in order; the last repeats once the list runs out. */
    answersInOrder(specs) { fs.writeFileSync(answerFile, JSON.stringify(specs)); },
    lists(runs) { github.answers({ stdout: JSON.stringify({ total_count: runs.length, workflow_runs: runs }) }); },
    calls() {
      return fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
  };
  github.lists([]);
  return github;
}

/** A run as the REST listing describes one; overrides make it the in-progress / failed / foreign case. */
const ciRun = (sha, overrides = {}) => ({
  id: 4242,
  name: "ci",
  path: ".github/workflows/ci.yml",
  head_sha: sha,
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/example/conventions/actions/runs/4242",
  ...overrides,
});

/** Run the real tool in a checkout, the way the workflow's step runs it. */
function run(cwd, args, env) {
  const result = spawnSync(process.execPath, [env.FAKE_GH_ENTRY, ...args], { cwd, encoding: "utf8", timeout: 60000, env });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

/** Remote + double + checkout, and one function that runs the tool in it. */
function scene(t) {
  const root = workspace(t);
  const rules = remote(root, "conventions");
  const github = fakeGitHub(root);
  const runner = checkout(root, rules.url);
  const env = { ...process.env, GITHUB_REPOSITORY: SLUG, ...github.env };
  return { root, rules, github, runner, env, promote: (args, extra = {}) => run(runner, args, { ...env, ...extra }) };
}

// The ci workflow is asked for ITS OWN runs, not the repository for all of them: the generic
// listing counts every workflow against one sha, so a busy commit looked like a short answer.
const runsQuery = (sha, page = 1) =>
  ["api", `repos/${SLUG}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100&page=${page}`];

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

// ══ story 2.2 of the move: this repository's gate. G1–G9 and the dry run (the workflows are tools/workflows.test.mjs) ══

const TAG = (version) => `refs/tags/agent-models--v${version}`;
const hookChange = (n = 2) => ({ "plugins/agent-models/hooks/limits.tsx": `export const a = ${n};\n` });
const bump = (version) => ({ "plugins/agent-models/.claude-plugin/plugin.json": MANIFEST("agent-models", version) });
const tagRefs = (s) => s.rules.refs().filter((r) => r.startsWith("refs/tags/"));
const MODS_GATE = path.join(here, "mods-gate.mjs");

/** `release` at one of the fixture's commits, main one commit on with these files, and a green ci run for it. */
function moved(t, files, at = "second") {
  const s = scene(t);
  s.rules.release(s.rules[at]);
  const sha = s.rules.advance(files);
  s.github.lists([ciRun(sha)]);
  return { s, sha };
}

test("the fixture's first commit is a valid layout: the layout findings of a good tree are none", (t) => {
  const rules = remote(workspace(t), "layout-good");
  assert.deepEqual(layoutFindings({ git: (...args) => git(rules.work, ...args), rev: rules.first }), []);
  assert.deepEqual(layoutFindings({ git: (...args) => git(rules.work, ...args), rev: rules.second }), []);
});

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
