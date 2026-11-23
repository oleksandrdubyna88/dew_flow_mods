# Architecture

`dew_flow_mods` is a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`, name `dew-flow-mods`) that serves
one plugin today, `agent-models`, a copy of the mod that lives in `dew_flow_conventions`. The repository has no service
and no runtime of its own: it holds the catalog, the plugin folder, a few node tools that prove the copy, and CI.

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
    rel["release (coming gate)"]
  end
  machine["a machine: ~/.claude settings"]
  src -- "copy once, proved by C1" --> plugin
  rules -- "mounted" --> mount
  mount --> ci
  tools --> ci
  main -- "promote-release (not built yet)" --> rel
  rel -- "marketplace add ...#release, auto-update" --> machine
  conv -. "coming: the session step writes the registration" .-> machine
```

## The two refs

`main` is written by pull request only. `release` is the one ref that machines load. Today nothing moves `release`: the
gate that does it (`promote-release` from `main` only, the green `ci` run of that exact sha, forward only, a version
gate, a layout gate, a tag `agent-models--v<version>` per promoted version, a deploy key held by a `release`
environment the owner approves) is story 2.2 of the conventions plan, specified in `todo/PLAN_dew_flow_mods_E2_gate.md`
there. Until it exists nothing here is released. The tag `agent-models--v1.6.0` is made by the first promotion; the copy
proof reads it once `plugin.json` goes above 1.6.0 (see [module_marketplace.md](module_marketplace.md)).

What is on `release` runs on every machine with the owner's permissions and outside any sandbox: a change under
`plugins/` needs a higher `plugin.json` version, and a plugin folder holds no `package.json`, lockfile or link that
leaves it.

## How a machine gets the mod

Installed by hand today: `claude plugin marketplace add https://github.com/oleksandrdubyna88/dew_flow_mods.git#release`
and `claude plugin install agent-models@dew-flow-mods` (HTTPS: SSH to GitHub does not work from every machine). The
engine's own auto-update then follows `release`. Not built yet: the registration step in `dew_flow_conventions`, which
writes the marketplace entry and `enabledPlugins` into user settings at session start and retires the old copy under
`~/.claude/mods`.

## Interaction with dew_flow_conventions

| What | Direction | Status |
|---|---|---|
| The copy source: `mods/agent-models` at the commit named in `tools/copy-proof.mjs` and `ci.yml` | conventions to this repository, once, proved by C1 | built |
| The family mount: `.agents/conventions` (submodule on its `release` branch), the Claude adapter in `.claude/` as byte copies, the three family checks | conventions to this repository, continuous | built |
| The registration step: conventions' session start installs the marketplace entry on every machine | conventions writes the settings that point at this repository | coming (the conventions side of the plan, `todo/PLAN_dew_flow_mods.md` § D there) |
| The next mod version (R4 fixed, 1.6.1) | built here, not in conventions | coming |

The old installer in conventions (`mods/agent-models` plus the nine consumers' pins) runs as before until the
registration step retires it; this repository does not touch it.

## CI

One workflow `ci` (the release gate reads the run of an exact sha) on `pull_request` and `push` to `main`, never
`pull_request_target`, a read-only token, every action pinned to a full sha, `npm ci --ignore-scripts`, no credential. Four
jobs: tools, plugin, family, actionlint. `pr-title.yml` checks the pull request title. See [module_tests.md](module_tests.md).
SonarCloud is not set up (a follow-up for the owner, `todo/README.md`).
