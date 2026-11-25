# todo — open plans

Plans for work that is not finished. A finished plan moves to `research/` with status `IMPLEMENTED <date>`.
The plan that moved the `agent-models` mod here is kept in `dew_flow_conventions` (`todo/PLAN_dew_flow_mods.md`);
this folder holds this repository's side of it.

## Currently open

| Plan | Status | Scope |
|---|---|---|
| [PLAN_from_conventions.md](PLAN_from_conventions.md) | plan only (2026-11-23) | the stories this repository carries from the move: the copy and its proof (story 2.1), then the release gate and the first promotion (2.2, 2.3) |
| [PLAN_agent_models_1_7_0.md](PLAN_agent_models_1_7_0.md) | approved (2026-11-24), building | mod 1.7.0: a `wake` button that sends `продолжай автономно` every 2 hours while the session is open (the owner, 2026-11-24) |
| [PLAN_agent_models_1_8_0.md](PLAN_agent_models_1_8_0.md) | plan only (2026-11-25) | mod 1.8.0: the `last answer` list shows the last three questions, newest first, then a separator, then the pins (the owner, 2026-11-25) |

## Follow-ups (no plan yet)

| Follow-up | Why | Who decides |
|---|---|---|
| SonarCloud for this repository | Not set up on purpose. The first version ran a job that executed pull request code before the step that receives `SONAR_TOKEN`, and `.agents/PROJECT.md` says "No credential in CI". Two ways remain: SonarCloud's automatic analysis (no job here), or a job that runs on `push` to `main` only and runs no pull request code | the owner |
| R4 of the mod tests (`tests/account-retry.test.tsx`, "a timer a draw started was refused") | It fails about one run in eight (the review brief named it `limits-race`; the test file that holds the title R4 is `account-retry`, as the conventions plan `PLAN_agent_models_1_6_0.md` says). It is traced to the shared state it races on and fixed in the next mod version built here (a change under `plugins/` needs a higher `plugin.json` version). Until then CI shows it red as it is; a red run is not re-run to get green | the next mod version (story 2.3 of the conventions plan) |
