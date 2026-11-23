// The shared fixture of the promote-release tests and the layout-gate tests: a bare remote shaped like a promotion day, a
// checkout of it as the workflow makes one, and GitHub as a scripted FUNCTION (see ENTRY). Not a test file itself, and its
// name does not match `tools/*.test.mjs`, so `npm test` loads it only through the files that import it.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RELEASE_REF } from "./promote-release.mjs";
import { ownedDir } from "../.agents/conventions/tools/lib/owned.mjs";


export const here = path.dirname(fileURLToPath(import.meta.url));
export const tool = path.join(here, "promote-release.mjs");

/** The repository the double answers for; GITHUB_REPOSITORY carries it into the tool, as Actions would. */
export const SLUG = "example/conventions";

export const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 20000, windowsHide: true }).trim();

/**
 * Write files (a null value deletes one; `{ link }` is a symlink; `{ gitlink: true }` a nested repository, which
 * `git add` records as a gitlink), then commit everything. With no files it is an empty commit, as before.
 */
export function commit(work, message, files = {}) {
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
export const MANIFEST = (name, version) => `${JSON.stringify({ name, version }, null, 2)}\n`;
export const CAT_ENTRY = (name) => ({ name, source: `./plugins/${name}`, description: `the ${name} mod` });
export const CATALOG = (plugins = [CAT_ENTRY("agent-models")], extra = {}) =>
  `${JSON.stringify({ name: "dew-flow-mods", owner: { name: "owner" }, metadata: { description: "mods" }, plugins, ...extra }, null, 2)}\n`;
export const BASE_TREE = () => ({
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
export const PLUGIN_TREE = (name, version) => ({
  [`plugins/${name}/.claude-plugin/plugin.json`]: MANIFEST(name, version),
  [`plugins/${name}/hooks/hooks.json`]: "{}\n",
});
export const TAG_160 = "refs/tags/agent-models--v1.6.0";

export function workspace(t) {
  const root = ownedDir(t, "promote-release");
  return root;
}

/**
 * A bare remote shaped like the conventions repository on a promotion day: `main` two commits deep,
 * `topic` one commit past main that never merged, and `stray` one commit off the OLDER main commit —
 * so there is a sha behind main's tip, one beside it, and one that reaches neither.
 */
export function remote(root, name) {
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
export function checkout(root, url, ...cloneFlags) {
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
export const ENTRY = (tool) => [
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

export function fakeGitHub(root) {
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
export const ciRun = (sha, overrides = {}) => ({
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
export function run(cwd, args, env) {
  const result = spawnSync(process.execPath, [env.FAKE_GH_ENTRY, ...args], { cwd, encoding: "utf8", timeout: 60000, env });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

/** Remote + double + checkout, and one function that runs the tool in it. */
export function scene(t) {
  const root = workspace(t);
  const rules = remote(root, "conventions");
  const github = fakeGitHub(root);
  const runner = checkout(root, rules.url);
  const env = { ...process.env, GITHUB_REPOSITORY: SLUG, ...github.env };
  return { root, rules, github, runner, env, promote: (args, extra = {}) => run(runner, args, { ...env, ...extra }) };
}

// The ci workflow is asked for ITS OWN runs, not the repository for all of them: the generic
// listing counts every workflow against one sha, so a busy commit looked like a short answer.
export const runsQuery = (sha, page = 1) =>
  ["api", `repos/${SLUG}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100&page=${page}`];


// ── what the gate tests (G1–G9, dry run) add to the fixture ──────────────────────────────────────

export const TAG = (version) => `refs/tags/agent-models--v${version}`;
export const hookChange = (n = 2) => ({ "plugins/agent-models/hooks/limits.tsx": `export const a = ${n};\n` });
export const bump = (version) => ({ "plugins/agent-models/.claude-plugin/plugin.json": MANIFEST("agent-models", version) });
export const tagRefs = (s) => s.rules.refs().filter((r) => r.startsWith("refs/tags/"));
export const MODS_GATE = path.join(here, "mods-gate.mjs");

/** `release` at one of the fixture's commits, main one commit on with these files, and a green ci run for it. */
export function moved(t, files, at = "second") {
  const s = scene(t);
  s.rules.release(s.rules[at]);
  const sha = s.rules.advance(files);
  s.github.lists([ciRun(sha)]);
  return { s, sha };
}
