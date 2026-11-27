# PLAN — agent-models mod 1.9.0: the `last answer` list keeps every question in order and drops rows a compaction removed

> Status: **plan only, 2026-11-27; review next.** Scope: `plugins/agent-models/` (the question model behind the `last answer`
> list, the press on a list row and on a pin row, version 1.9.0, the mod's tests), `todo/README.md`, `research/module_tests.md`.
> The release goes the normal way of this repository (the promotion with the owner's approval click). Parent: the mod at
> `bc28b00` (1.8.1; plans `research/PLAN_agent_models_1_8_0.md`, `todo/PLAN_agent_models_1_8_1.md`).

## Goal (the owner's words, 2026-11-27, translated from Russian)

"Last answer: after a long time the rows seem to fall off. Check." Then, after the cause was shown: "That may be it. It must
be fixed. But it also does not see my last messages at all (in long sessions, through tmux)."

Two faults, both measured (§ Probe):

1. **A row from before a compaction does not jump.** The list keeps its id; the engine draws no such row any more.
2. **A question typed while Claude works is never listed.** In a long autonomous session almost every question is typed so.

Not in this plan: the follow-up "50-row read after `/reload-plugins` from 1.7.0" and "`findQuestion` after `/rewind`" stay
open (`todo/README.md`); this plan replaces the code they are about, and its review says whether they are closed by it.

## What the code and the engine do today (read 2026-11-27 at `bc28b00`, Claude Code 2.1.332)

- `hooks/answer.tsx` keeps `lastQuestion` (one value: settled `{ uuid, text }` or `{ pending, previous, previousText }`) and
  `earlierQuestions` (at most 3), rebuilt from `$.session.messages` at each settle, list open and session start. A question
  settles when `findQuestion` finds a transcript row (role `user`, no tool results) with the same clean text.
- `$.session.messages` (types): "the last compaction's summary in place of what it replaced"; `{ after: uuid }` denies "a row
  cleared, rewound or left behind the last compaction".
- `ui.render` on `UserMessage` (types): `e.requestId`, `e.props.text` ("the prompt as typed"), `e.props.origin` ("as
  `prompt.submit` named it"), `onScreen`. A draw may not write `$.state`.
- `$.ui.scroll({ to: { requestId } })` answers `{ deny }` when it cannot move (§ Probe: `nothing drawn under that requestId`).
- The pins (`hooks/pins.tsx`) keep `requestId`s of `AssistantMessage` blocks; a press scrolls the same way.

### Probe (2026-11-27, the throw-away dev mod `jump-probe` in session `fca0c5b7`, fullscreen, deleted after)

The session log had compactions at lines 499, 6318 and 7635 and a restart after them.

- P1 a question from before the last compaction (`1a36f23f…`): scroll → `deny: nothing drawn under that requestId`.
- P2 a question after it (`d75074e7…`, typed while idle): scroll → moved.
- P3 a question typed while a turn ran ("и дай мне ссылку на гитхаб репо"): the log stores it as an `attachment` row
  (`queued_command`, `origin.kind: human`, its own `uuid` `68849452…`, a `source_uuid` `0606dcf3…`); the model gets it inside
  a tool result. `$.session.messages({ last: 4096 })` (529 rows) returned NO row with its text. Its screen row is a
  `UserMessage` with `origin.kind: composer` and `requestId` = the attachment's uuid: scroll to `68849452…` → moved; to the
  `source_uuid` → `nothing drawn`.
- P4 `UserMessage` rows draw when shown: 15 rows were drawn after the probe loaded, each 1–3 times, the queued one among
  them once the owner scrolled to it.

## Design

### A. One list of asked questions (`hooks/asked.ts`, new; `types/index.d.ts`)

- State `asked: readonly Asked[]`, newest first, at most 8. `Asked = { text: string; at: number; id?: string; source?:
  'row' | 'drawn' }`: `text` the shown text (`questionText`, wake text never: `isWakeText`); `at` an order key; `id` the
  scroll target once known; `source` where the id came from (`row`: a transcript uuid; `drawn`: a `UserMessage` requestId).
  An entry without `id` is pending.
- `at`: written inside the `update` that adds the entry, as `max(now, newest.at + 1)` (`now` the clock read made before the
  write, or the newest `at` + 1 when the clock is refused): the order of the writes, which is the order of the submits.
- `lastQuestion` and `earlierQuestions` are read once, as the migration (B5), then no longer written; their atoms stay in
  the contract for one version (read-only) and `session.end` clears them.

### B. Writing it

1. **Submit** (`noteSubmit`): a person's prompt (`composer`, `bridge`; not a slash command, meta, dropped or wake text) adds
   `{ text, at }` at the front. No `previous` logic: every submit is its own entry, so two quick submits are two entries.
2. **Drawn rows** (a `ui.render` hook on `UserMessage`, in `register.tsx`, body in `asked.ts`): a row with `origin.kind`
   `composer` or `bridge` whose shown text is not the wake text is recorded in MODULE memory (`requestId`, shown text,
   draw order), at most 200; the hook returns `next(e)` unchanged and writes no state.
3. **Settle** (an entry gets its `id`), run from `noteSubmit` after its write, `turn.start`, `turn.complete`, the 2 s tick
   and the list open: pending entries, oldest first, each take the newest candidate with the same shown text that no other
   entry holds — candidates are the drawn rows (module memory, no read) and, at `noteSubmit`/`turn.*`/list open only, the
   newest `LOOKUP_ROWS` transcript question rows (`typedQuestions`). A drawn candidate wins over a transcript one for the
   same text (it is the row the screen shows). The tick never reads the transcript.
4. **Restore** (session start with `asked` empty or absent and no migration value): the newest 4 transcript questions
   (`RESTORE_ROWS`, the engine cap when fewer were found and the read was full), `at` = −1…−4, `source: 'row'`.
5. **Migration** (session start or first list open with `asked` absent and a 1.8.x value): a settled `lastQuestion` and
   `earlierQuestions` become entries in their order (`at` = −1…−4, `source: 'row'`), a pending one an entry without `id`;
   a wake value is skipped (1.8.1 rule).
6. **Session end**: `asked` = `[]` (and the old atoms cleared), with the session-end epoch as today.

### C. A row a compaction removed (both lists)

1. **On a press** (a question row or a pin row): when the scroll answers a deny that says nothing is drawn under the id,
   that entry is removed (a question from `asked`, a pin from `pins`) and a toast says `<label>: that message was
   compacted away — removed`. Any other deny keeps the entry and toasts as today.
2. **At list open**: entries with `source: 'row'` are checked with `$.session.messages({ after: id })`; a deny removes the
   entry (a refused read keeps it). `drawn` entries are not checked this way (an attachment uuid may not anchor; the press
   rule covers them). Pins are not checked at open (their ids are block ids, not row uuids).
3. After removals, when fewer than 3 entries with an `id` are left, the list is filled from the transcript with questions
   older than the oldest kept `row` entry (or the newest ones when none is kept), `at` below the oldest kept.

### D. The list (`answerList`)

- Rows 1–3: the three newest entries of `asked`. One with an `id`: `› <text>`, a press scrolls to it (before any await, as
  today). One without: dim `› <text> (sending…)`, a press toasts `last answer: not in the transcript yet`. Then the
  separator and the pins, as 1.8.0.
- The `last answer` button and its keys stay as they are.

### E. Version

- `plugin.json` 1.9.0; the description says the list "keeps the questions you typed while Claude worked, and drops rows a
  compaction removed".

## Files

| File | Change |
|---|---|
| `plugins/agent-models/hooks/asked.ts` (new) | the `asked` atom, submit, drawn-row memory, settle, restore, migration, compaction checks |
| `plugins/agent-models/hooks/answer.tsx` | the list drawn from `asked`; the old question code removed; the press with the compaction rule |
| `plugins/agent-models/hooks/pins.tsx` | the press removes a compacted pin |
| `plugins/agent-models/hooks/questions.ts` | pure helpers kept (`questionText`, `isWakeText`, `typedQuestions`) |
| `plugins/agent-models/hooks/register.tsx` | the `UserMessage` hook, settle in tick and turn hooks, the draw reads `asked` |
| `plugins/agent-models/types/index.d.ts` | `Asked`, `asked`; the old types marked read-only for the migration |
| `plugins/agent-models/.claude-plugin/plugin.json` | 1.9.0 |
| `plugins/agent-models/tests/` | new tests below; the 1.5.0–1.8.1 question tests rewritten to the new model where they test removed code, each change listed in the PR |
| `todo/README.md`, `research/module_tests.md` | the plan row; the catalogue |

## Build order

1. Tests A1–A16 written first and run RED against 1.8.1.
2. The code; the old question tests that test removed internals are rewritten to the same behaviour on `asked` (never
   deleted without a replacement case); the whole suite GREEN (a red R4 in CI blocks the merge like any red check).
3. The CI set: `plugin validate .`, `validate --json` + `tools/type-baseline.mjs`, `npm test`, `copy-proof`, `mods-gate`,
   `plan-lifecycle`.

## Tests

- A1 three questions typed while idle: the list is C, B, A; each press scrolls to its transcript uuid before any await.
- A2 a question typed while a turn runs (no transcript row; a drawn `UserMessage` row, origin `composer`, its own
  requestId): the entry settles on the drawn requestId at the next tick; the press scrolls to it.
- A3 two quick submits D, E while a turn runs: two entries in order E, D; each settles on its own drawn row.
- A4 order with mixed kinds: idle A, queued B, idle C → C, B, A.
- A5 a pending entry draws dim with `(sending…)`; its press toasts and does not scroll.
- A6 the same text typed twice: two entries, two different ids; no id is held twice.
- A7 the wake text (typed, or sent by the wake button, origin `plugin`) never adds an entry.
- A8 a press whose scroll answers `nothing drawn under that requestId` removes that question and toasts; another deny keeps
  it.
- A9 the same for a pin.
- A10 at list open, a `row` entry whose `after` read denies is removed; a refused read keeps it; a `drawn` entry is not
  checked.
- A11 after removals, the list is filled with older transcript questions, in order, below the kept ones.
- A12 restore at session start: the newest 4 transcript questions, wake and summary rows skipped.
- A13 migration from a 1.8.1 state (settled `lastQuestion`, 3 `earlierQuestions`; and a pending one; and a wake value).
- A14 session end clears `asked` and the old atoms; work in flight writes nothing after it.
- A15 a reload (fresh module memory) keeps `asked`; a pending entry settles from the transcript or a later draw.
- A16 the tick does no transcript read; a `UserMessage` draw writes no state.

## Owner checks (after the release reaches this machine)

1. In a long session, type a question while Claude works: it is in `last answer ▾` (dim `sending…` until its row shows, then
   a jump).
2. After a compaction, press an old row: it says it was compacted away and leaves the list; the list fills with what is left.
3. Questions typed while idle still jump as before; pins still work.

## Definition of done

The tests GREEN in CI; the plan and code reviews resolved; the PR merged on green checks; the promotion approved by the
owner; the owner checks recorded; this plan moved to `research/` as IMPLEMENTED.
