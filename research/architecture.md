# Architecture

`dew_flow_mods` is a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`, name `dew-flow-mods`) that serves
one plugin today, `agent-models`. The mod was copied from `dew_flow_conventions` at 1.6.0 and is developed here since
1.6.1. The repository has no service and no runtime of its own: it holds the catalog, the plugin folder, a few node tools
(the copy proof of the 1.6.0 start among them), and CI.

```mermaid
flowchart TB
  subgraph conv["dew_flow_conventions (public)"]
    src["mods/agent-models @ named commit"]
    rules["shared rules, tools, release ref"]
  end
  subgraph mods["dew_flow_mods (this repository)"]
    plugin["plugins/agent-models (byte copy)"]
    cat[".claude-plugin/marketplace.json"]
    tools["tools/*.mjs + tests"]
    mount[".agents/conventions (submodule, tracks release)"]
    ci["ci workflow: tools, plugin, family, actionlint"]
    main["main (pull request only)"]
    rel["release (moved by the gate only)"]
  end
  machine["a machine: ~/.claude settings"]
  src -- "copy once, proved by C1" --> plugin
  rules -- "mounted" --> mount
  mount --> ci
  tools --> ci
  main -- "promote-release: verdict, owner approval, push" --> rel
  rel -- "marketplace add ...#release, auto-update" --> machine
  conv -. "coming: the session step writes the registration" .-> machine
```

## The two refs

`main` is written by pull request only (ruleset `main`). `release` is the one ref that machines load. The design asks that it move only
through `.github/workflows/promote-release.yml`: the owner dispatches it against `main` with a sha; the job `verdict` (no
secret) judges the commit and prints the compare URL; the job `push` (environment `release`, the owner approves) judges it
again and pushes `release` and the tag `<plugin>--v<version>` in one atomic push with the deploy key; the job refuses first
if its commit is not the current tip of `main` (a re-run of an old run). The judgement is the
green `ci` push run of that exact sha, forward only, a layout gate, a version gate and a free tag. Rulesets let only the
deploy key create or move `release` and create any tag, and let nobody rewind or delete either (that is what the data
ASKS of GitHub: nothing has been observed yet). The rules and the settings are data with a read-back: see
[module_marketplace.md](module_marketplace.md). The first promotion (2026-11-23) made the tag `agent-models--v1.6.0`, which the copy
proof reads now that `plugin.json` is above 1.6.0. Tags so far: `agent-models--v1.6.0`, `--v1.6.1` (2026-11-23),
`--v1.7.0` (2026-11-24), `--v1.8.0` (2026-11-25), each promoted with the owner's approval.

What is on `release` runs on every machine with the owner's permissions and outside any sandbox: a change under
`plugins/` needs a higher `plugin.json` version, and a plugin folder holds no `package.json`, lockfile or link that
leaves it.

## How a machine gets the mod

The registration step in `dew_flow_conventions` (`settings/hooks/lib/mods-marketplace.mjs`, release `cd19c17`, in all
consumers since 2026-11-24) writes the marketplace entry and `enabledPlugins` into user settings at session start and
retires the old copy under `~/.claude/mods`. By hand it is `claude plugin marketplace add
https://github.com/oleksandrdubyna88/dew_flow_mods.git#release` and `claude plugin install agent-models@dew-flow-mods`
(HTTPS: SSH to GitHub does not work from every machine). The engine's own auto-update then follows `release`: a new
version arrives after a session has been open for a while and a restart.

## Interaction with dew_flow_conventions

| What | Direction | Status |
|---|---|---|
| The copy source: `mods/agent-models` at the commit named in `tools/copy-proof.mjs` and `ci.yml` | conventions to this repository, once, proved by C1 | built |
| The family mount: `.agents/conventions` (submodule on its `release` branch), the Claude adapter in `.claude/` as byte copies, the three family checks | conventions to this repository, continuous | built |
| The registration step: conventions' session start installs the marketplace entry on every machine | conventions writes the settings that point at this repository | built (conventions release `cd19c17`) |
| The mod versions after 1.6.0 (1.6.1, 1.7.0, 1.8.0) | built here, not in conventions | built |

The registration step retired the old installer in conventions (`mods/agent-models` plus the consumers' pins); this
repository never touched it.

## CI

One workflow `ci` (the release gate reads the push run of an exact sha on `main`; the workflow cancels a superseded run, and
a cancelled run is not green) on `pull_request` and `push` to `main`, never `pull_request_target`, a read-only token, every
action pinned to a full sha, `npm ci --ignore-scripts`, no credential. Four jobs: tools (the tools tests, the layout gate, the
copy proof), plugin, family, actionlint. `pr-title.yml` checks the pull request title. `promote-release.yml` is dispatch-only
and is the one workflow with an environment and a secret. See [module_tests.md](module_tests.md).
SonarCloud is not set up (a follow-up for the owner, `todo/README.md`).
