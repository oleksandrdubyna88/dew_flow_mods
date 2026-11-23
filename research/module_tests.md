# Module: tests

Two harnesses, two kinds of proof. Neither calls a model or needs a Claude login (CI-1): the plugin steps run with an
empty `HOME` and no `ANTHROPIC_*` variable (`env -i`).

| Harness | Command | What it tests | Where it runs in CI |
|---|---|---|---|
| Tools | `npm ci --ignore-scripts`, then `npm test` (`node --test "tools/*.test.mjs"`) | the repository's own tools in `tools/`, against real git repositories and files in a temp folder, removed in teardown | job `mods · tools` |
| Mod | `claude plugin test plugins/agent-models`, with the pinned CLI that `node tools/claude-bin.mjs` finds | the mod's own cases, in `plugins/agent-models/tests/`, run by the engine | job `mods · plugin` |

At this writing: 38 tools tests (27 in the first build, 11 added by the review fixes) and 391 mod cases in 16 test
files. The commands print the current numbers; do not trust this line over them.

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
| `ci.yml` shape: no re-run instruction, `bin=$(...)` in its own statement, the tag fetch before the copy proof, no SonarCloud workflow and no secret | `tools/ci-shape.test.mjs` | covered (text checks) |
| `pr-title.yml`, the actionlint job | none | not covered by a test: the actionlint job is itself the check; the PR title check is an action |
| The release gate (`promote-release`, rulesets) | none | not covered: it does not exist yet (story 2.2 of the conventions plan) |

What the tools tests do not prove: that the workflow runs on a real runner (the first run on a pull request does),
that GitHub serves the tag to a shallow fetch (the test uses a `file://` origin), or anything about the mod.

## Mod cases (`claude plugin test`)

The 391 cases are the mod's own, copied byte for byte with the mod; they cover the band of subagent rows, the account
and limits line (with its ceilings, retries, 5-hour and weekly reset times), tasks, messages, answer pins and the
answer list, and the races between them. This repository adds no case and may not edit one: a change under
`plugins/agent-models/` needs a higher `plugin.json` version.

Known flake, R4: `tests/account-retry.test.tsx`, "R4 a timer a draw started was refused…", fails about one run in
eight, in the 1.5.0 build too. A red run is a red run and is not re-run to get green. It is traced to the shared state
it races on and fixed in the next mod version built here (`todo/README.md`).

What the mod cases do not prove: that the engine of a later Claude Code version still accepts the mod. The type check is
the engine's own, in `claude plugin validate --json`; `tools/type-baseline.json` holds the 149 findings of the pinned
2.1.330 and can only shrink.

## The other checks of CI

`claude plugin validate .` (the marketplace root), `claude plugin validate --json plugins/agent-models` with
`node tools/type-baseline.mjs`, the family checks (`plan-lifecycle`, `adapter-check`, `pin-check` of the mounted
conventions) and `actionlint`. Each is a command that exits 1 with the finding named.
