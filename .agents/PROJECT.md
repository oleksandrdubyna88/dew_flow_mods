---
requires: ["README.md"]
---
# Project instructions — dew_flow_mods

Shared family rules are mounted at `.agents/conventions` (the `dew_flow_conventions` submodule,
tracking its `release` branch) and apply here exactly as local rules would. Fresh clone:
`git submodule update --init .agents/conventions` and
`npm ci --ignore-scripts --prefix .agents/conventions`.

## What this repository is

**dew_flow_mods** is a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`, name
`dew-flow-mods`). It serves one plugin today, `agent-models` (`plugins/agent-models/`), a copy of the mod
that lives in `dew_flow_conventions`. The plan is in `todo/PLAN_from_conventions.md`.

## Commands

```bash
npm ci --ignore-scripts                                         # the pinned Claude Code CLI; never run an install script
npm test                                                        # node --test over tools/*.test.mjs
node tools/copy-proof.mjs                                       # C1: the plugin folder equals the named conventions commit
node tools/mods-gate.mjs                                        # the layout gate of HEAD (the promotion runs the same one)
node .github/scripts/repo-settings.mjs                          # the rulesets, environment, deploy key and Actions settings equal their data (needs the owner's gh login)
CLAUDE=$(node tools/claude-bin.mjs)                             # the native binary that --ignore-scripts leaves
"$CLAUDE" plugin validate .                                     # the marketplace root
"$CLAUDE" plugin validate --json plugins/agent-models > v.json && node tools/type-baseline.mjs v.json
"$CLAUDE" plugin test plugins/agent-models                      # the mod's own tests, run by the engine
node .agents/conventions/tools/plan-lifecycle.mjs
node .agents/conventions/tools/adapter-check.mjs
node .agents/conventions/tools/pin-check.mjs
```

## Non-negotiables

- **What is on `release` runs on every machine**, with the owner's permissions and outside any sandbox, in every
  interactive Claude Code session. A change under `plugins/` needs a higher `plugin.json` version; never edit
  `plugins/agent-models/` without one.
- **No install script, no dependency in a plugin.** CI runs `npm ci --ignore-scripts`; a plugin folder holds no
  `package.json`, lockfile or link that leaves it.
- **CI runs on `pull_request`, never `pull_request_target`**, with a read-only token and every action pinned to a
  full commit sha.
- **No credential in CI, with ONE approved exception: the release deploy key.** `RELEASE_DEPLOY_KEY` is held only by the
  job `push` of `promote-release.yml`, which runs in the `release` environment (the owner approves each run); no other job,
  workflow or step names it. This is the owner-approved design (parent plan `PLAN_dew_flow_mods.md` § B and Q2 in
  `dew_flow_conventions`), and `tools/workflows.test.mjs` Y3 keeps it to that one job. If any other step needs a login,
  stop and ask the owner.
