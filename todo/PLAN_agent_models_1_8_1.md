# PLAN — agent-models mod 1.8.1: the wake text is never a question in the `last answer` list

> Status: **plan only, 2026-11-25; review next.** Scope: `plugins/agent-models/hooks/answer.tsx` and `hooks/questions.ts`, version
> 1.8.1, the mod's own tests, `todo/README.md` (the follow-up row this closes). The release goes the normal way of this repository
> (the promotion with the owner's approval click). Parent: the mod at `170c4f9` (1.8.0,
> `research/PLAN_agent_models_1_8_0.md`).

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

- `isWakeText(raw)`: the clean text of `raw` (`cleanPrompts`, trimmed) equals `WAKE_TEXT`. `typedQuestions` uses it (no change
  of behaviour), and:
- `earlierFrom` drops `kept` entries whose `text` is the wake text (so a stored list, or a `previous` that was a wake row, never
  shows it).
- `isWakeValue(cur: LastQuestion)`: a settled value whose `text` is the wake text, or a pending value whose `pending` is.

### B. A typed wake text is not a question (`noteSubmit`)

- A person's prompt whose text `isWakeText` changes nothing (returns before the pending write, like a slash command): row 1
  stays the question before it.

### C. A stored wake value is replaced (`hooks/answer.tsx`)

- `repairWake($)`: when `lastQuestion` `isWakeValue`: read the newest rows (`RESTORE_ROWS`, the engine cap when fewer than
  four questions were found and the read was full), and write — `earlierQuestions` first, then `lastQuestion` — the newest four
  typed questions as in a restore (the newest is row 1, the next three the list); with none, `lastQuestion` becomes null
  (`› no question yet`). Each write only while the stored value is still a wake value and the generation and session-end
  epoch are unchanged (a newer submit or a session end owns the value).
- Called at session start (`restoreQuestion`, before `fillEarlier`) and at list open (`toggleAnswerList`, before
  `refreshEarlier`).

### D. Version

- `plugin.json` 1.8.1; the description is unchanged.

## Files

| File | Change |
|---|---|
| `plugins/agent-models/hooks/questions.ts` | `isWakeText`, `isWakeValue`, the `kept` filter in `earlierFrom` |
| `plugins/agent-models/hooks/answer.tsx` | the early return in `noteSubmit`, `repairWake`, its two calls |
| `plugins/agent-models/.claude-plugin/plugin.json` | 1.8.1 |
| `plugins/agent-models/tests/answer-wake-text.test.tsx` (new) | tests below |
| `todo/README.md` | the follow-up row "the wake text as a question" removed (done) |

## Build order

1. Tests V1–V7 written first and run RED against 1.8.0.
2. The code; the tests GREEN; the whole mod suite GREEN (a red R4 in CI blocks the merge like any red check).
3. The CI set: `plugin validate .`, `validate --json` + `tools/type-baseline.mjs`, `npm test`, `copy-proof`, `mods-gate`,
   `plan-lifecycle`.

## Tests

- V1 the owner types `продолжай автономно` (origin `composer`) after question C: `lastQuestion` stays C, nothing pending.
- V2 a session start with a settled `lastQuestion` whose text is the wake text and a transcript with questions A–D: row 1
  becomes D, the list C, B, A.
- V3 the same state, no session start, the list opens: the same repair.
- V4 a pending value whose `pending` is the wake text (typed under 1.8.0): repaired the same way at the list open.
- V5 `earlierFrom` with a `kept` entry whose text is the wake text drops it; a stored list holding one draws without it after
  the next rebuild.
- V6 a wake value and no typed question in the transcript: `lastQuestion` becomes null and the list says `› no question yet`.
- V7 a newer submit or a session end during the repair's read: the repair writes nothing.

## Owner checks (after the release reaches this machine)

1. Type `продолжай автономно` yourself, then open `last answer ▾`: the first row is still your question before it.
2. After a wake sent the text, the list shows only your own questions.

## Definition of done

The tests GREEN in CI; the reviews resolved; the PR merged on green checks; the promotion approved by the owner; the owner
checks recorded; this plan moved to `research/` as IMPLEMENTED.
