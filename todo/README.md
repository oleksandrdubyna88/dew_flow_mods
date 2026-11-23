# todo — open plans

Plans for work that is not finished. A finished plan moves to `research/` with status `IMPLEMENTED <date>`.
The plan that moved the `agent-models` mod here is kept in `dew_flow_conventions` (`todo/PLAN_dew_flow_mods.md`);
this folder holds this repository's side of it.

## Currently open

| Plan | Status | Scope |
|---|---|---|
| [PLAN_from_conventions.md](PLAN_from_conventions.md) | plan only (2026-11-23) | the stories this repository carries from the move: the copy and its proof (story 2.1), then the release gate and the first promotion (2.2, 2.3) |

## Follow-ups (no plan yet)

| Follow-up | Why | Who decides |
|---|---|---|
| SonarCloud for this repository | Not set up on purpose. The first version ran a job that executed pull request code before the step that receives `SONAR_TOKEN`, and `.agents/PROJECT.md` says "No credential in CI". Two ways remain: SonarCloud's automatic analysis (no job here), or a job that runs on `push` to `main` only and runs no pull request code | the owner |
| R4 (`limits-race`) of the mod tests | It fails about one run in eight. It is traced to the shared state it races on and fixed in the next mod version built here (a change under `plugins/` needs a higher `plugin.json` version). Until then CI shows it red as it is; a red run is not re-run to get green | the next mod version (story 2.3 of the conventions plan) |
