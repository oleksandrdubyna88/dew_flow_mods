# PLAN — agent-models mod 1.8.0: the `last answer` list shows the last three questions, then a separator, then the pins

> Status: **plan only, 2026-11-25; review next.** Scope: `plugins/agent-models/` (the list under the `last answer` button,
> one state value, version 1.8.0, the mod's own tests), `todo/README.md`. The release goes the normal way of this repository
> (the promotion with the owner's approval click; installs update by themselves). Parent: the mod at `9b48665` (1.7.0).

## Goal (the owner's words, 2026-11-25, translated from Russian)

"Last answer — it must show a jump to the last, the previous, and the one before the previous message, if they exist. Plus
the pins. The newest is on top, then the previous, then the one before the previous, then a separator, and the pins."

"Message" is read as the owner's own question (what the list's first row is today, 1.5.0/1.6.0), not Claude's answer.

Not in this plan: more than three questions, another order of the pins (oldest first, as today), questions that outlive the
session (`session.end` clears them, as today).

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

- When `noteSubmit` replaces a SETTLED `lastQuestion` (`{ uuid, text }`) with a new pending one, that settled question is put
  at the front of `earlierQuestions` (a uuid already in the list moves to the front, never twice), cut to 3. Same generation
  check as the `lastQuestion` write: older work never writes. A settled value with no `text` (stored by 1.5.0) is put in
  with the text `last question`.
- `restoreQuestion` (a session start with no value): the newest FOUR questions of the same rows (`newestQuestions(rows, 4)`,
  the same filter as `newestQuestion`): the newest is `lastQuestion`, the next three are `earlierQuestions`, written only
  when both are empty and the generation is unchanged.
- `clearQuestion` (`session.end`) writes `[]` too.

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
| `plugins/agent-models/hooks/answer.tsx` | the atom, `currentEarlierQuestions`, `newestQuestions`, the front-insert in `noteSubmit`, `restoreQuestion`, `clearQuestion`, the rows and the separator in `answerList` (the file stays under 400 lines; pure helpers may move to a new `hooks/questions.ts` if needed) |
| `plugins/agent-models/hooks/register.tsx` | the draw reads `currentEarlierQuestions` and passes it to `answerList` |
| `plugins/agent-models/types/index.d.ts` | `EarlierQuestion`, `earlierQuestions` |
| `plugins/agent-models/.claude-plugin/plugin.json` | 1.8.0, the description |
| `plugins/agent-models/tests/answer-recent.test.tsx` (new) and the existing answer tests where the list shape changes | tests below |
| `todo/README.md` | the plan row |

## Build order

1. Tests Q1–Q9 written first and run RED against 1.7.0.
2. The code; the tests GREEN; the whole mod suite GREEN (R4 is the known flake).
3. `claude plugin validate .`, `validate --json` + `tools/type-baseline.mjs`, `npm test`, `copy-proof`, `mods-gate`,
   `plan-lifecycle` — the same set as CI.

## Tests (`claude plugin test plugins/agent-models`)

- Q1 three typed questions A, B, C (each settled): the list is C, B, A, newest first; each press scrolls to its own uuid.
- Q2 four questions: only the newest three are drawn (D, C, B); `earlierQuestions` holds at most 3.
- Q3 one question: one row, no empty rows; no pins: no separator.
- Q4 with pins: the separator is drawn once, between the questions and the pins; with no question: `› no question yet`,
  the separator, the pins.
- Q5 a pending question D (C settled before it): row 1 is `C (sending…)` pressing C; rows 2–3 are B and A (C is not drawn
  twice); after D settles: D, C, B.
- Q6 a plugin prompt (the wake) and a slash command change nothing in the list.
- Q7 a session start with no value restores the newest four questions of the transcript (summary and peer rows skipped):
  `lastQuestion` + three earlier; a reload with values keeps them.
- Q8 `session.end` clears both; a state from before 1.8.0 (no `earlierQuestions`) draws the old one-row list.
- Q9 the same question typed twice: the list holds two rows with two different uuids (each its own transcript row); a uuid
  already in the list is never added twice.

## Owner checks (after the release reaches this machine)

1. Ask three questions; open `last answer ▾`: the three newest, newest on top; each press jumps to its question.
2. Pin an answer: a separator line, then the pin, under the questions.
3. Restart with `/resume`: the list shows the last questions again.

## Definition of done

The tests GREEN in CI; the reviews resolved; the PR merged on green checks; the promotion approved by the owner; the owner
checks recorded; this plan moved to `research/` as IMPLEMENTED.
