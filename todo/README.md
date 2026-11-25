# todo — open plans

Plans for work that is not finished. A finished plan moves to `research/` with status `IMPLEMENTED <date>`.
The plan that moved the `agent-models` mod here is kept in `dew_flow_conventions` (`todo/PLAN_dew_flow_mods.md`);
this folder holds this repository's side of it.

## Currently open

| Plan | Status | Scope |
|---|---|---|
| [PLAN_from_conventions.md](PLAN_from_conventions.md) | plan only (2026-11-23) | the stories this repository carries from the move: the copy and its proof (story 2.1), then the release gate and the first promotion (2.2, 2.3) |
| [PLAN_agent_models_1_8_1.md](PLAN_agent_models_1_8_1.md) | approved (2026-11-25), building | mod 1.8.1: the wake text `продолжай автономно` is never a question in the `last answer` list (the owner, 2026-11-25) |

## Follow-ups (no plan yet)

| Follow-up | Why | Who decides |
|---|---|---|
| SonarCloud for this repository | Not set up on purpose. The first version ran a job that executed pull request code before the step that receives `SONAR_TOKEN`, and `.agents/PROJECT.md` says "No credential in CI". Two ways remain: SonarCloud's automatic analysis (no job here), or a job that runs on `push` to `main` only and runs no pull request code | the owner |
| R4 of the mod tests (`tests/account-retry.test.tsx`, "a timer a draw started was refused") | It fails about one run in eight (the review brief named it `limits-race`; the test file that holds the title R4 is `account-retry`, as the conventions plan `PLAN_agent_models_1_6_0.md` says). It is traced to the shared state it races on and fixed in the next mod version built here (a change under `plugins/` needs a higher `plugin.json` version). Until then CI shows it red as it is; a red run is not re-run to get green | the next mod version (story 2.3 of the conventions plan) |
| agent-models: the `last answer` list after `/reload-plugins` from 1.7.0 | Accepted in the 1.8.0 code round (coai and Opus), not built there: the plan's change budget was used. The list-open rebuild reads 50 rows; when the last question is further back, a session reloaded from 1.7.0 (no session start) shows only row 1 until later questions settle. A restart is not affected: the session start reads deeper | the next mod version |
| agent-models: `findQuestion` after `/rewind` | From the 1.8.0 Opus code review, older than 1.8.0: when `previous` was removed by a rewind, the scan reads the whole window, and a new question with the same text as an older one can settle on the older row | the next mod version |
