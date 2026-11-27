# Module: tests

Two harnesses, two kinds of proof. Neither calls a model or needs a Claude login (CI-1): the plugin steps run with an
empty `HOME` and no `ANTHROPIC_*` variable (`env -i`).

| Harness | Command | What it tests | Where it runs in CI |
|---|---|---|---|
| Tools | `npm ci --ignore-scripts`, then `npm test` (`node --test "tools/*.test.mjs"`) | the repository's own tools in `tools/`, against real git repositories and files in a temp folder, removed in teardown | job `mods · tools` |
| Mod | `claude plugin test plugins/agent-models`, with the pinned CLI that `node tools/claude-bin.mjs` finds | the mod's own cases, in `plugins/agent-models/tests/`, run by the engine | job `mods · plugin` |

At this writing: 153 tools tests (agent-models-extract 18, copy-proof 17, type-baseline 11, claude-bin 6, ci-shape 7, promote-release 45 in three files
(argument, ancestry, ci and push 23; parsers and the pager 8; G1-G8 and the dry run 14), mods-gate 8, repo-settings 27, workflows 14) and 441 mod cases in 19 test files. The commands print the current numbers; do not trust this line over them.

## Tools tests (`npm test`)

| Flow | File | Status |
|---|---|---|
| C1 copy proof: an exact copy is green and prints the commit, the keys hashed and the entry count read from git | `tools/copy-proof.test.mjs` | covered |
| C1: a changed installed file, test file or tsconfig; an extra or a missing file; a mode change; a symlink; a file force-added under `.claude-plugin/types/`; an edit not committed | same | covered, each red first |
| C1: the row of the pins table is the source of the files hashed (a tenth key is demanded); a row key in neither tree is a finding | same | covered |
| C1: plugin version above 1.6.0 reads the tag `agent-models--v1.6.0`; an absent tag is red and names the `git fetch`; the fetch line of `ci.yml` is run in a shallow clone and the proof turns green | same | covered |
| C1: a commit that cannot be read, or has no 1.6.0 row, is red, never a skip | same | covered |
| Type baseline T1-T4: equal, a new finding, a finding gone, a count that moved, unparsable input; `--write` never grows the baseline | `tools/type-baseline.test.mjs` | covered |
| claude-bin B1-B3: the stub, a missing file, another version, the pinned version read from `package.json` | `tools/claude-bin.test.mjs` | covered |
| `ci.yml` shape: no re-run instruction, `bin=$(...)` in its own statement, the tag fetch before the copy proof, no SonarCloud workflow and no secret; the shared rules fetched before the tests; the layout gate step | `tools/ci-shape.test.mjs` | covered (text checks) |
| `pr-title.yml`, the actionlint job | none | not covered by a test: the actionlint job is itself the check; the PR title check is an action |
| The sha shape, ancestry, the `ci` run (absent, unfinished, red, another sha), the push, evidence that could not be gathered | `tools/promote-release.test.mjs` (real git repositories, `gh` as a function; the shared fixture is `tools/promote-release.fixture.mjs`, which is not a test file) | covered |
| The parsers (`repositorySlug`, `ciRunsFor`, `judgeRuns`), `total_count`, a red run on page 2, a later page that is empty before the reported total (unreadable: refuse), a refused push that says where `release` is | `tools/promote-release-units.test.mjs` | covered |
| G1, G3, G5-G8, the dry run: only a `push` run of `ci` on `main` counts, the version gate, the tag in one atomic push (a tag refused by the remote moves nothing), no tag when no plugin changed, the verdict lines | `tools/promote-release-gate.test.mjs` | covered, each seen red first and again red by mutation |
| G9 and G5's number rules: every layout defect of `tools/mods-gate.mjs` as `path: reason`, all findings of a commit, the standalone CLI; a version with a leading zero; `Plugins/` and `Package.json` in other letters; a catalog that is JSON `null` or a list (the layout check is split in named checks, each under 50 lines; the cases above cover it) | `tools/mods-gate.test.mjs` | covered |
| Y1-Y4: every workflow file is parsed; `promote-release.yml` is dispatch-only with the main guard, `push` needs `verdict`; no write permission, every action pinned; one environment, the deploy key in that job only and no npm step there; no `pull_request_target`, no input or ref text inside a `run:` | `tools/workflows.test.mjs` | covered |
| Y5-Y7: the summary steps are RUN with stub `node` and `gh`: a hostile reason or sha cannot open an HTML comment or a fence, the verdict comes first, a failed verdict says the push job will not run; the first step of `push` refuses a commit that is not main's tip, before the key is written; Y8: a sha already at `release` gives `moves=false`, the summary says nothing moved and no approval is asked, and `push` needs `moves == 'true'` | same | covered |
| X1-X17: the session-log extractor of the mod (`EXTRACT` in `plugins/agent-models/hooks/prompts.ts`, a `String.raw` template between two marker lines) is read as text and run with node over fixture logs: typed and queued prompts, the origin rules, images, half-written lines, bad bytes, logs over 4 MiB, lookup by session id, exit codes, and no `classic.*` hook in `hooks/`. It was `tools/agent-models-extract.test.mjs` in `dew_flow_conventions` and moved here with the mod; it imports `ownedDir` from the mounted `.agents/conventions/tools/lib/owned.mjs`. Seen red: a mutated copy of the extractor fails X2 and X15, a wrong source file fails X1 | `tools/agent-models-extract.test.mjs` | covered |
| D1-D7: the rulesets and settings data (the exact rule types and an empty exclude per ruleset, `~ALL` in both tag rulesets), the read-back of rulesets, environment, deploy key and Actions settings, a part that cannot be looked at (exit 3), `--apply` and its dry run; the data is in the form GitHub reads back (the two server defaults of the `pull_request` rule, an `update` rule without parameters; the order of a parameter object is not a difference), every one of the five rulesets present, each on its own target and exactly its own ref (`release-fixed` pointed at another branch is refused); the secrets listings read page by page (the key on page 2 is found, a listing short of its count is exit 3); the `gh` launcher stops a timed-out `gh` with every descendant (a fake `gh` that starts a child; POSIX only) | `tools/repo-settings.test.mjs` (`gh` as a function; the launcher test uses a fake `gh` on `PATH`) | covered |

What the tools tests do not prove: that the workflow runs on a real runner (the first run on a pull request does),
that GitHub serves the tag to a shallow fetch (the test uses a `file://` origin), that GitHub accepts the DeployKey bypass
actor and refuses what the rulesets say (the observations O1-O7 on GitHub, recorded in `research/RESULTS_release_gate.md`
once they are run), that `prevent_self_review` and `can_admins_bypass` behave as the data says, or anything about the mod.
The release tests use an `update` hook on the bare remote for the refused tag, because only a per-ref hook shows what
`--atomic` adds.

## Mod cases (`claude plugin test`)

The 435 cases (as `claude plugin test` reports them) are the mod's own; they cover the band of subagent rows, the account
and limits line (with its ceilings, retries, 5-hour and weekly reset times), tasks, messages, answer pins, the answer
list, the wake and the questions read from the transcript file, and the races between them. The first 391 were copied
byte for byte with the mod; in 1.9.0 the question cases among them were replaced (below).
Since 1.7.0 the mod is developed in this repository, so cases are added with each version. A change under
`plugins/agent-models/` still needs a higher `plugin.json` version.

Two flows were added here. The 1.7.0 wake: W1-W14, in `tests/wake.test.tsx` (its helpers are in `tests/wake-fixtures.tsx`).
The 1.9.0 flow, the questions of the `last answer` list read from the transcript file (plan `todo/PLAN_agent_models_1_9_0.md`;
it replaced the 1.5.0-1.8.1 question cases, which tested code that 1.9.0 removed: the lookup of a submit, `lastQuestion`,
`earlierQuestions`, the settle and its races, the repair of a wake value): A1-A21 with their sub-cases, in
`tests/asked-read.test.tsx` (the live chain, the compaction mark, a rewind, the window and its one deeper read, the byte
ends, the cache, the fallback to the engine's list), `tests/asked.test.tsx` (the rows and the pending row, the refresh
points and the tick, the guard, refusals, the session end, a reload, the expiry of a pending entry), `tests/pins-deny.test.tsx`
(A14: a pin press after a compaction), and `tests/transcript.test.tsx` (the pure cut of a window and the walk). Their helpers
are in `tests/asked-fixtures.tsx` (a transcript file the test owns, built from invented text in the shapes of the engine's
own lines, and the engine calls that reach it). `tests/answer.test.tsx` and `tests/answer-list.test.tsx` keep the button, the
list's rows, the pins in the list and the views closing each other (T1, T2, T10-T12b, T14, L1-L11, Q1-Q2, P9).
The harness cannot see where a transcript scroll goes (no `on('ui.scroll')` hook is reached by a press): a press is seen by
the toast of the engine's rejection, and the target of a row is tested on `questionPress` and `pinPress` with a fake scroll.

Known flake, R4: `tests/account-retry.test.tsx`, "R4 a timer a draw started was refused…", fails about one run in
eight, in the 1.5.0 build too. A red run is a red run and is not re-run to get green. It is traced to the shared state
it races on and fixed in the next mod version built here (`todo/README.md`).

What the mod cases do not prove: that the engine of a later Claude Code version still accepts the mod. The type check is
the engine's own, in `claude plugin validate --json`; `tools/type-baseline.json` holds the 148 findings of the pinned
2.1.330 and can only shrink.

## The other checks of CI

`claude plugin validate .` (the marketplace root), `claude plugin validate --json plugins/agent-models` with
`node tools/type-baseline.mjs`, the family checks (`plan-lifecycle`, `adapter-check`, `pin-check` of the mounted
conventions) and `actionlint`. Each is a command that exits 1 with the finding named.
