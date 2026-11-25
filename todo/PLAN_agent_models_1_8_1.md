# PLAN — agent-models mod 1.8.1: the wake text is never a question in the `last answer` list

> Status: **APPROVED 2026-11-25 (epoch 1, by reviewers: coai `proceed` and the Opus plan review); build next.** Scope: `plugins/agent-models/hooks/answer.tsx` and `hooks/questions.ts`, version
> 1.8.1, the mod's own tests, `todo/README.md` (the follow-up row this closes). The release goes the normal way of this repository
> (the promotion with the owner's approval click). Parent: the mod at `170c4f9` (1.8.0,
> `research/PLAN_agent_models_1_8_0.md`).

## Plan changes

> Epoch 1 · approved 2026-11-25 · by reviewers · state: open

  (Accepted in the plan round — coai: the order of the two writes, a refused read changes nothing; the Opus review: one
  test on the shown text, `previousOf` without a wake value, the restore treating a wake value as none (no separate repair),
  the guards, the list kept, the list-open order, tests V1–V13. Rejected with reason: the coai copy-proof finding (the proof
  uses the tag agent-models--v1.6.0 above 1.6.0).)

## Goal (the owner, 2026-11-25)

The follow-up "agent-models: the wake text as a question" (`todo/README.md`), which the owner chose to fix now ("да") after this
explanation: one rule everywhere — the text `продолжай автономно` is never shown as a question, also when the owner types it;
and when the first row holds the wake text, it is replaced by the newest real question.

Not in this plan: the two other 1.8.0 follow-ups (the 50-row read after `/reload-plugins`, `findQuestion` after `/rewind`);
telling a typed wake text from a sent one (a transcript row carries no origin; the owner agreed not to).

## What the code does today (read 2026-11-25 at `170c4f9`)

- `typedQuestions` (`hooks/questions.ts`) skips a row whose clean text equals `WAKE_TEXT` (`hooks/wake.tsx`); `newestQuestions`,
  `newestQuestion` and `earlierFrom` use it for the rows they read. `earlierFrom`'s `kept` entries (the stored list, and in
  `settle` the pending value's `previous` with its `previousText`) are NOT filtered.
- `noteSubmit` (`hooks/answer.tsx`) makes ANY person's prompt (`composer`, `bridge`) the pending `lastQuestion`, the wake text
  typed by the owner too: row 1 then shows it.
- `restoreQuestion` (session start) keeps a stored `lastQuestion` as it is (it only fills `earlierQuestions` via `fillEarlier`).
  1.7.0's restore did not skip the wake text, so a session that ran 1.7.0 can hold a settled `lastQuestion` whose `text` is the
  wake text.
- `toggleAnswerList` runs `refreshEarlier` when it opens the list; it rebuilds only `earlierQuestions`.

## Design

### A. One test for "the wake text" (`hooks/questions.ts`)

- `isWakeText(raw)`: `questionText(raw) === WAKE_TEXT` — the SHOWN text (the first line, spaces collapsed, cut), the same
  text the list stores and draws. So the filter and the row-1 check never disagree. A small change of `typedQuestions`: a
  multi-line question whose first line is the wake text, and `продолжай  автономно` with two spaces, are now skipped too
  (they are drawn as the wake text).
- Used by `typedQuestions` (so `newestQuestions`, `newestQuestion`, `earlierFrom`'s rows), by `earlierFrom`'s `kept` entries
  (a stored list, or a `previous` that was a wake row, never shows it), by `noteSubmit` (B) and by `isWakeValue`.
- `isWakeValue(cur: LastQuestion)`: a settled value whose `text` is the wake text, or a pending value whose `pending` is.

### B. A typed wake text is not a question (`noteSubmit`)

- After the existing origin checks and BEFORE `generation += 1`: a prompt whose `result.text` `isWakeText` returns, writing
  nothing. Row 1 stays the question before it, and a pending question still in flight is not cancelled (its settle keeps
  its generation).
- `previousOf` returns `{}` for a wake value: a new question typed while row 1 still holds a 1.7.0 wake value does not
  show `продолжай автономно (sending…)`. `findQuestion` then has no `notBefore` boundary, as with no value today.

### C. A stored wake value is replaced (`hooks/answer.tsx`) — the restore treats it as no value

- `restoreQuestion` treats a wake value like null: `if (cur !== null && !isWakeValue(cur)) return fillEarlier(...)`. Else
  it reads as today (`RESTORE_ROWS`, the engine cap when fewer than four questions were found and the read was full) and
  writes `earlierQuestions` first — `earlierFrom(rows, newest.uuid, storedList)`, so nothing a short read cannot see is
  dropped — then `lastQuestion` = the newest question, allowed when the stored value `raw === null || isWakeValue(raw)` and
  the generation is unchanged. No separate repair path.
- When the read returned rows and none is a typed question, a stored wake value becomes null (`› no question yet`). A
  refused or empty read (`recentRows` turns a deny into `[]`) changes nothing: the wake value stays, and the next session
  start or list open tries again.
- Guards: `mine` (the generation) and the session-end epoch are captured before the first await. The list write is guarded
  by both (one `update` sees one atom, so it cannot check `lastQuestion`); the `lastQuestion` write by `isWakeValue` (or
  null) and the generation. Between the two writes, a newer submit refuses the `lastQuestion` write and its own settle
  rebuilds the list (1.8.0); the draw leaves out of rows 2–3 the uuid row 1 presses, so no question shows twice. A session
  end there clears both and moves the epoch.
- At list open: `toggleAnswerList`, AFTER its `answerListOpen` write (the press shows at once), runs the same function when
  the stored value is a wake value, in its own try/catch, then `refreshEarlier` as today. A list open with no wake value
  reads nothing new.

### D. Version

- `plugin.json` 1.8.1; the description is unchanged.

## Files

| File | Change |
|---|---|
| `plugins/agent-models/hooks/questions.ts` | `isWakeText`, `isWakeValue`, the shown-text test in `typedQuestions`, the `kept` filter in `earlierFrom` |
| `plugins/agent-models/hooks/answer.tsx` | the early return in `noteSubmit`, `previousOf`, `restoreQuestion` treating a wake value as none, its call at list open |
| `plugins/agent-models/.claude-plugin/plugin.json` | 1.8.1 |
| `plugins/agent-models/tests/answer-wake-text.test.tsx` (new) | tests below |
| `todo/README.md` | the follow-up row "the wake text as a question" removed (done) |

## Build order

1. Tests V1–V13 written first and run RED against 1.8.0.
2. The code; the tests GREEN; the whole mod suite GREEN (a red R4 in CI blocks the merge like any red check).
3. The CI set: `plugin validate .`, `validate --json` + `tools/type-baseline.mjs`, `npm test`, `copy-proof`, `mods-gate`,
   `plan-lifecycle`.

## Tests

- V1 the owner types `продолжай автономно` after question C, origin `composer` and origin `bridge`: `lastQuestion` stays C,
  nothing pending.
- V2 a session start with a settled `lastQuestion` whose text is the wake text and a transcript with questions A–D: row 1
  becomes D, the list C, B, A.
- V3 the same state, no session start, the list opens: the same repair; a second list open does no transcript read.
- V4 a pending value whose `pending` is the wake text (typed under 1.8.0): repaired the same way at the list open; also
  with `retryPending` settling it during the repair's read.
- V5 `earlierFrom` with a `kept` entry whose text is the wake text drops it; a stored list holding one draws without it after
  the next rebuild.
- V6 a wake value and no typed question in the rows read: `lastQuestion` becomes null and the list says `› no question yet`.
- V7 a newer submit or a session end during the repair's read: no write; between its two writes: no `lastQuestion` write,
  and the draw shows no question twice.
- V8 a refused (deny) or empty transcript read during the repair: the wake value stays; the next list open repairs it.
- V9 a settled 1.7.0 wake value, then the owner types a new question before any list open: row 1 never shows
  `продолжай автономно (sending…)`; after the settle, row 1 is the new question.
- V10 the owner types the wake text while question P is pending: P stays pending, settles, and no wake row is in rows 2–3.
- V11 a wake value and only ONE typed question D in the transcript: row 1 becomes D, the list is empty, and a later list open
  is not stopped by `refreshEarlier`'s guard.
- V12 a multi-line question whose first line is the wake text, and the wake text with two spaces: neither is listed.
- V13 a normal question whose text only contains the wake words (`продолжай автономно, но сначала тесты`) is listed.

## Owner checks (after the release reaches this machine)

1. Type `продолжай автономно` yourself, then open `last answer ▾`: the first row is still your question before it.
2. After a wake sent the text, the list shows only your own questions.

## Definition of done

The tests GREEN in CI; the reviews resolved; the PR merged on green checks; the promotion approved by the owner; the owner
checks recorded; this plan moved to `research/` as IMPLEMENTED.
