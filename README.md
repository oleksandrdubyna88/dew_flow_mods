# dew_flow_mods

Claude Code mods of the dew_flow family, served as a plugin marketplace.

## Install

```bash
claude plugin marketplace add https://github.com/oleksandrdubyna88/dew_flow_mods.git#release
claude plugin install agent-models@dew-flow-mods
```

## agent-models

The mod in `plugins/agent-models` is the folder `mods/agent-models` of
[dew_flow_conventions](https://github.com/oleksandrdubyna88/dew_flow_conventions) at commit `69adc1e`
(version 1.6.0), copied byte for byte. `node tools/copy-proof.mjs` proves the copy.

Licence: MIT, see [LICENSE](LICENSE).

## The release gate

`release` is the ref every machine loads. The design asks that it move only by the workflow `promote-release`, run from `main` by
the owner. That is what the settings below request; until the observations O1-O7 are run, nothing says GitHub enforces it.
Replace `YOUR_FULL_SHA` with the full 40-character sha of the commit on `main` to publish:

```bash
gh workflow run promote-release.yml --repo oleksandrdubyna88/dew_flow_mods --ref main -f sha=YOUR_FULL_SHA -f reason="what changed"
```

The job `verdict` is a dry run: it prints the compare URL, the plugins that changed and the commit the gate runs at.
When `release` is already the sha, the verdict says so, the job `push` is skipped, and no approval is asked.
The job `push` is set to wait for the owner's approval in the `release` environment (requested, not yet observed), refuses to
run when its commit is not the current tip of `main`, then pushes `release` and the tag `<plugin>--v<version>` in one
atomic push with the deploy key. The judgement ([tools/promote-release.mjs](tools/promote-release.mjs),
[tools/mods-gate.mjs](tools/mods-gate.mjs)): the sha is on `main`, its `ci` push run is green, the move is forward, the
layout of the catalog is exact, and every plugin folder that differs from `release` has a higher `plugin.json` version.
Nothing here has been applied to GitHub or observed there yet: the settings and what they achieve are requests until the
observations are run.

The settings GitHub holds are data: `.github/rulesets/*.json` and `.github/settings.json`.
`node .github/scripts/repo-settings.mjs` reads them back (exit 0 when equal), `--apply --dry-run` prints the calls an
apply makes, `--apply` writes the rulesets and the environment. The deploy key and its secret are the owner's, made in
the owner's own terminal, and the one setting the API may not show is set by hand. See
[research/module_marketplace.md](research/module_marketplace.md).
