# PLAN — agent-models mod 1.8.0: the `last answer` list shows the last three questions, then a separator, then the pins

> Status: **IMPLEMENTED, 2026-11-25.** Released as 1.8.0 (PR #7, `34d8042`, tag `agent-models--v1.8.0`).
> The owner, after the update reached the machine, 2026-11-25: "работает. супер." ("it works. great."); the owner checks
> were not reported one by one.
> Deviations: ledger 1.1 (a late settle whose anchor is already listed leaves the list alone; the restore also skips the
> wake text). Pure helpers moved to the new `hooks/questions.ts`. Three findings accepted in the code round were NOT
> built, as the plan's one change after approval was used: the 50-row read at list open after `/reload-plugins` from 1.7.0,
> the wake text typed by the owner or stored by 1.7.0 as a question, and `findQuestion` after `/rewind`; they are
> follow-ups in `todo/README.md`. Rejected in the code round: a per-feature module doc, arrow fixtures, a local
> accumulator, a generation token for a settle held past four others.

## Goal (the owner's words, 2026-11-25, translated from Russian)

"Last answer — it must show a jump to the last, the previous, and the one before the previous message, if they exist. Plus
the pins. The newest is on top, then the previous, then the one before the previous, then a separator, and the pins."

"Message" is read as the owner's own question (what the list's first row is today, 1.5.0/1.6.0), not Claude's answer.

Not in this plan: more than three questions, another order of the pins (oldest first, as today), questions that outlive the
session (`session.end` clears them, as today).

## Plan changes

> Epoch 1 · approved 2026-11-25 · by reviewers · state: open

  (Accepted in the plan round — coai: a pending question replaced by a quick second submit, a session from 1.7.0;
  the Opus review: rebuild at each settle and at list open instead of a front-insert, the write order, the run that
  landed, the session-end epoch, wake rows skipped, the deep read, the tests L1–L15. Rejected with reasons: the coai
  copy-proof finding (the proof uses the tag agent-models--v1.6.0 above 1.6.0) and its R4 finding (a recorded follow-up;
  a red R4 blocks the merge like any red check).)
- 1.1 · 2026-11-25 · agent · approach — the build: a late settle whose anchor uuid is already in the stored list leaves the list alone (a newer settle wrote it; test L12b), and the restore at session start also skips the wake text (L6b)

## What the code does today (read 2026-11-25 at `9b48665`)

- `hooks/answer.tsx` keeps ONE question in `$.state` (`lastQuestion`: `{ uuid, text? }` settled, or `{ pending, previous?,
  previousText? }` while the typed question is not in the transcript yet). It is written by `noteSubmit` (a person's
  `prompt.submit`: `composer` or `bridge`), `settle` (via `noteSubmit` and `retryPending` at `turn.start`/`turn.complete`),
  `restoreQuestion` (a session start with no value: `newestQuestion` of the newest 200 rows, the engine cap when none) and
  `clearQuestion` (`session.end`). A module `generation` stops older work from writing.
- The list (`answerList`) draws the first row (`questionRowText`; a pending question says the text of the question before
  it plus `(sending…)` and presses `previous`), then the pins (`pinRow`, oldest first).
- A press must call `$.ui.scroll` before any `await` (`runPress`, `hooks/pins.tsx`): the targets are uuids in state, known
  before the press.
- A plugin's prompt (the 1.7.0 wake) is not a question: `noteSubmit` ignores origins other than `composer`/`bridge`.

## Design

### A. State (`types/index.d.ts`)

- `earlierQuestions: readonly EarlierQuestion[]` in `PluginState['agent-models']`, `EarlierQuestion = { uuid: string; text:
  string }`, newest first, at most 3. Absent (a state from before 1.8.0) reads as `[]`. The atom is declared in
  `hooks/answer.tsx` (the file that writes it), read by the draw through `currentEarlierQuestions($)`.

### B. Keeping it (`hooks/answer.tsx`)

- One pure helper, `earlierFrom(rows, anchor, kept)`: the questions in `rows` OLDER than the row `anchor` (newest first, the
  `newestQuestion` filter, and also skipping a row whose clean text is the 1.7.0 wake text `WAKE_TEXT`: the wake is sent
  `asUser`, and a transcript row carries no origin), then the entries of `kept` (no uuid twice, `anchor` never), cut to 3.
  The `kept` tail keeps older entries when a long tool-heavy turn pushed them past the rows read.
- Rebuilt at each settle: when `settle` writes a uuid (in `noteSubmit` and `retryPending`, which already hold the rows they
  read), `earlierQuestions` becomes `earlierFrom(rows, settledUuid, [the pending value's previous {previous, previousText},
  ...old earlierQuestions])`. No front-insert at the submit: two quick submits (D typed into a running turn, then E) are
  both listed once both are in the transcript (E, D, C).
- Write order: `earlierQuestions` FIRST, then `lastQuestion`. The draw leaves out of rows 2–3 the uuid row 1 presses, so
  every state in between draws right ("C (sending…), B, A", then "D, C, B"). The value written comes from the change
  function's run that landed (the `run.dropped` pattern of `pins.tsx`; `update` may run it again on a version miss). The
  `earlierQuestions` write is guarded by a session-end epoch (as `pins.tsx`), not by the submit generation: a newer settle
  recomputes anyway.
- Rebuilt at list open: `toggleAnswerList`, when it OPENS the list (a press handler: it may await and write; it does not
  scroll), reads the newest `LOOKUP_ROWS` rows and writes `earlierFrom(rows, row-1 target, old earlierQuestions)`. This also
  fills a session from 1.7.0 or one after a reload, and drops nothing that the read cannot see.
- Session start: `restoreQuestion` with no value reads the newest rows (200, then the engine cap `ENTRY_CAP` when the read
  was full and fewer than four questions were found) and writes `earlierQuestions` (the next three) then `lastQuestion`
  (the newest). With a value already set and `earlierQuestions` empty or absent (an upgrade from 1.7.0), it fills only
  `earlierQuestions` from the questions older than the row-1 target; `lastQuestion` is not changed.
- `clearQuestion` (`session.end`) writes `[]` too and moves the session-end epoch.
- Rows removed by `/rewind` or a compaction keep their uuids in state (the engine has no rewind event); their press only
  toasts the engine's refusal, as a pin's press does today. Accepted.

### C. The list (`answerList`)

- Row 1: as today (the last question; while pending, the question before it with `(sending…)`).
- Rows 2 and 3: `earlierQuestions` minus the uuid row 1 presses, the first two left, newest first, each `› <text>`,
  pressing `{ label: 'earlier question', id: uuid }` through `runPress` (no `await` before the scroll). Rows that do not
  exist are not drawn (no empty rows).
- Then, ONLY when there is at least one pin: one dim separator row `────────` (a fixed 8 cells), then the pins as today.
- With no question at all: `› no question yet`, as today, then the separator and pins if any.
- Keys: `answer-earlier-<uuid>` for rows 2–3, `answer-separator` for the separator.

### D. Version and text

- `plugin.json` 1.8.0; the description says the list shows "your last three questions, newest first, then the pinned answers".

## Files

| File | Change |
|---|---|
| `plugins/agent-models/hooks/answer.tsx` | the atom, `currentEarlierQuestions`, `newestQuestions`, the front-insert in `noteSubmit`, `restoreQuestion`, `clearQuestion`, the rows and the separator in `answerList` (the file stays under 400 lines; pure helpers may move to a new `hooks/questions.ts` if needed; `WAKE_TEXT` is imported from `hooks/wake.tsx`) |
| `plugins/agent-models/hooks/register.tsx` | the draw reads `currentEarlierQuestions` and passes it to `answerList` |
| `plugins/agent-models/types/index.d.ts` | `EarlierQuestion`, `earlierQuestions` |
| `plugins/agent-models/.claude-plugin/plugin.json` | 1.8.0, the description |
| `plugins/agent-models/tests/answer-recent.test.tsx` (new) and the existing answer tests where the list shape changes | tests below |
| `todo/README.md` | the plan row |

## Build order

1. Tests L1–L15 written first and run RED against 1.7.0.
2. The code; the tests GREEN; the whole mod suite GREEN. R4 (`tests/account-retry.test.tsx`) is the recorded follow-up in
   `todo/README.md`, not in this plan; a red R4 in CI blocks the merge like any red check.
3. `claude plugin validate .`, `validate --json` + `tools/type-baseline.mjs`, `npm test`, `copy-proof`, `mods-gate`,
   `plan-lifecycle` — the same set as CI.

## Tests (`claude plugin test plugins/agent-models`; named L1–L15: the names Q1, Q2 are taken in `answer-list.test.tsx`)

- L1 three typed questions A, B, C (each settled): the list is C, B, A, newest first; each press calls the scroll with its
  own uuid BEFORE the first await (as T10).
- L2 four questions: only the newest three are drawn (D, C, B); `earlierQuestions` holds at most 3.
- L3 one question: one row, no empty rows; no pins: no separator.
- L4 with pins: the separator is drawn once, between the questions and the pins; with no question: `› no question yet`,
  the separator, the pins.
- L5 a pending question D (C settled before it): row 1 is `C (sending…)` pressing C; rows 2–3 are B and A (C is not drawn
  twice); after D settles: D, C, B.
- L6 a plugin prompt (the wake) and a slash command change nothing in the list; wake rows in the transcript are skipped by
  the restore, the settle rebuild and the list-open rebuild.
- L7 a session start with no value restores the newest four questions of the transcript (summary and peer rows skipped):
  `lastQuestion` + three earlier; a reload with values keeps them; fewer than four in a full 200-row read goes to the cap.
- L8 `session.end` clears both; a state from before 1.8.0 (no `earlierQuestions`) draws the one-row list until a session
  start or a list open fills it.
- L9 the same question typed twice: two rows with two different uuids; a uuid is never listed twice.
- L10 two quick submits D then E before D settles (C settled before): once both are in the transcript and E settles, the
  list is E, D, C.
- L11 a 1.7.0 state (a settled `lastQuestion`, no `earlierQuestions`) and a transcript with four questions: a session start
  fills the three older ones and keeps `lastQuestion`; a list open does the same.
- L12 a newer submit between the `earlierQuestions` and the `lastQuestion` writes of a settle, and a session end there:
  no question is lost by the newer submit; nothing is written after the session end (T18/T24 style).
- L13 a long turn: an earlier question more than 50 rows back (`LOOKUP_ROWS`) stays in the list after the next settle.
- L14 the write order: a draw between the two writes of a settle shows no question twice and none missing (L5's middle).
- L15 the change function runs again on a version miss: the written list comes from the run that landed.

## Owner checks (after the release reaches this machine)

1. Ask three questions; open `last answer ▾`: the three newest, newest on top; each press jumps to its question.
2. Pin an answer: a separator line, then the pin, under the questions; with no pins there is no separator.
3. Restart with `/resume`: the list shows the last questions again.

## Definition of done

The tests GREEN in CI; the reviews resolved; the PR merged on green checks; the promotion approved by the owner; the owner
checks recorded; this plan moved to `research/` as IMPLEMENTED.
