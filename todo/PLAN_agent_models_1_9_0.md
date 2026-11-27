# PLAN — agent-models mod 1.9.0: the `last answer` list keeps every question in order and drops rows a compaction removed

> Status: **plan only, 2026-11-27; review next.** Scope: `plugins/agent-models/` (where the `last answer` list takes its questions
> from, the press on a pin row, version 1.9.0, the mod's tests), `todo/README.md`, `research/module_tests.md`.
> The release goes the normal way of this repository (the promotion with the owner's approval click). Parent: the mod at
> `bc28b00` (1.8.1; plans `research/PLAN_agent_models_1_8_0.md`, `todo/PLAN_agent_models_1_8_1.md`).

## Goal (the owner's words, 2026-11-27, translated from Russian)

"Last answer: after a long time the rows seem to fall off. Check." Then, after the cause was shown: "That may be it. It must
be fixed. But it also does not see my last messages at all (in long sessions, through tmux)."

Two faults, both measured (§ Probe):

1. **A row from before a compaction does not jump.** The list keeps its id; the engine draws no such row any more.
2. **A question typed while Claude works is never listed.** In a long autonomous session almost every question is typed so.

This plan also closes the two open follow-ups of 1.8.0 (`todo/README.md`): the 50-row read after `/reload-plugins` (the list
is read from the file, not from 50 rows) and `findQuestion` after `/rewind` (no text lookup; a rewound branch is off the
chain). Not in this plan: pins kept across a compaction (a compacted pin is removed at its press, D).

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
  them once the owner scrolled to it. The question of P2 was NOT among them, and its scroll still moved: a live row that
  was not drawn since the load scrolls; `nothing drawn` means the row is gone.
- P5 (`append-probe`): a `session.append` hook gets the uuid of every stored row, but on this machine the engine skipped it:
  the organization's `cc-plugin-sec-default` runs first and sends the event on past other plugins. Not usable.
- P6 (read-only, from the file): an idle question is a `user` line with `origin.kind: human`, `promptSource: typed`; a
  queued one an `attachment` line `queued_command` with `origin.kind: human` and `prompt`; both with `uuid`, `timestamp`,
  `parentUuid`. A compaction is a `system` line `compact_boundary` (three in this file).

## Design

The questions come from the session's transcript FILE, read from its end: the file is the one place that holds both kinds
of question, in order, with the id the screen draws, and it marks compactions and rewinds. The file format is the engine's,
not a documented API (§ F, the fallback).

### A. Reading the questions (`hooks/asked.ts`, new; pure parsing in `hooks/transcript.ts`, new)

1. **The window.** `$.session.info()` → `transcriptPath`; `$.fs.stat` → `size`; `$.fs.read(path, { offset, length })` of the
   last 1 MiB (the first, cut line dropped). When the walk (A2) reaches the window's start before 4 questions and before a
   compaction mark, ONE deeper read of the last 4 MiB (the engine's per-read cap). No more.
2. **The live chain.** From the newest line that has a `uuid` and `isSidechain` false, walk `parentUuid` (or
   `logicalParentUuid`) back through the lines of the window. Stop at a `system` line with `subtype: "compact_boundary"`, at a
   missing parent, or at the window's start. Rows on another branch (a `/rewind`) are not on the chain; rows before the last
   compaction are behind its mark. (Measured on session `fca0c5b7`: the walk from the newest row met the last mark after 802
   steps and held all 5 queued and all 15 typed questions after it.)
3. **A question** is a chain line that is (a) `type: "user"` with `origin.kind: "human"`, `message.content` a string (or text
   blocks with no `tool_result`), not `isMeta`, not `isCompactSummary`, not a slash command (`<command-name>`); text = that
   content; or (b) `type: "attachment"` with `attachment.type: "queued_command"`, `attachment.origin.kind: "human"`,
   `attachment.commandMode: "prompt"`; text = `attachment.prompt`. Its id is the line's `uuid` (what the screen draws: § Probe
   P2, P3). Shown text: `questionText`; the wake text never (`isWakeText`).
4. **The result:** the newest 3 questions on the chain, newest first, and `size` (the file length the read saw).

### B. State and when it is written

- `recent: { questions: readonly { id: string; text: string }[]; size: number }` (newest first, at most 3) and
  `pending: readonly { text: string; from: number }[]` (oldest first, at most 8) in `PluginState['agent-models']`.
- **Submit** (`noteSubmit`): a person's prompt (`composer`, `bridge`; not a slash command, meta, dropped, or the wake text)
  appends `{ text, from }` to `pending`, `from` = the file size from one `$.fs.stat` made first (`recent.size` when the stat
  is refused, 0 when none). No transcript lookup here.
- **Refresh** (`refreshRecent($)`): runs A, then writes `recent`, and drops from `pending` the oldest k entries, k = the
  number of questions on the chain that lie in the file after the oldest entry's `from` (first come, first matched: no text
  is compared, so the same text twice and a paste that the file stores differently both match in order). One refresh at a
  time per module (a guard); a refresh whose read fails changes nothing.
- **Refresh points:** the list open (after its `answerListOpen` write), `turn.start` and `turn.complete` of the main loop,
  session start, and the 2 s tick only while the list is open or `pending` is not empty, and only when `$.fs.stat` shows
  the file grew since `recent.size`.
- `session.end`: `recent`, `pending` cleared; the 1.5.0–1.8.1 atoms `lastQuestion` and `earlierQuestions` cleared too and no
  longer written or read (no migration: a refresh rebuilds the list from the file).

### C. The list (`answerList`)

- Rows: the `pending` entries first (newest first, dim `› <text> (sending…)`, a press toasts `last answer: not in the
  transcript yet`), then `recent.questions`, up to 3 rows in all; a press on a question scrolls to its id before any await,
  as today. Then the separator and the pins, as 1.8.0. With none: `› no question yet`.
- Keys: `answer-pending-<from>-<i>` and `answer-q-<id>`.

### D. Pins after a compaction (`hooks/pins.tsx`)

- A press whose scroll answers the deny `nothing drawn under that requestId` (one constant, the probe's exact text) removes
  that pin and toasts `pin: that answer was compacted away — removed`. Any other deny keeps the pin and toasts as today.
  (§ Probe P2: a live row that was not drawn since the load still scrolls, so this deny means the row is gone.)

### E. Version

- `plugin.json` 1.9.0; the description says the list "shows your last three questions from the transcript, also those
  typed while Claude worked, and none from before a compaction".

### F. The fallback

- When the file cannot be read, or the window parses but holds no line the walk recognises (a changed format), the list
  falls back to the 1.8.1 source for the questions it can see: the newest 3 `typedQuestions` of `$.session.messages`, and a
  one-time toast per session `last answer: transcript format not recognised — showing what the engine lists`.

## Files

| File | Change |
|---|---|
| `plugins/agent-models/hooks/transcript.ts` (new) | pure: cut lines of a window, the chain walk, the question lines (A2–A3) |
| `plugins/agent-models/hooks/asked.ts` (new) | the `recent` and `pending` atoms, the read (A1), `refreshRecent`, submit, the fallback (F) |
| `plugins/agent-models/hooks/answer.tsx` | the list drawn from `recent` and `pending`; the 1.5.0–1.8.1 question code removed |
| `plugins/agent-models/hooks/pins.tsx` | the press removes a compacted pin (D) |
| `plugins/agent-models/hooks/questions.ts` | the pure helpers kept (`questionText`, `isWakeText`, `typedQuestions` for F) |
| `plugins/agent-models/hooks/register.tsx` | the refresh points, the draw reads `recent` and `pending` |
| `plugins/agent-models/types/index.d.ts` | `recent`, `pending`; `lastQuestion`, `earlierQuestions` kept for the clear only |
| `plugins/agent-models/.claude-plugin/plugin.json` | 1.9.0 |
| `plugins/agent-models/tests/` | new tests below; the 1.5.0–1.8.1 question tests that test removed code are replaced by cases on the same behaviour (each named in the PR), never dropped without a replacement |
| `todo/README.md`, `research/module_tests.md` | the plan row; the two follow-ups closed by this plan removed; the catalogue |

## Build order

1. Fixture transcripts (JSONL text) built from the shapes of § Probe P6, with no real session content. Tests A1–A16 written
   first and run RED against 1.8.1.
2. The code; the whole suite GREEN (a red R4 in CI blocks the merge like any red check).
3. The CI set: `plugin validate .`, `validate --json` + `tools/type-baseline.mjs`, `npm test`, `copy-proof`, `mods-gate`,
   `plan-lifecycle`.

## Tests

- A1 the walk: typed and queued questions on the chain, newest first; tool results, meta, summaries, slash commands, task
  notifications and peer messages are not questions.
- A2 the walk stops at the last `compact_boundary`: no question from before it is listed.
- A3 a `/rewind` branch: questions on the abandoned branch are not listed.
- A4 a window that starts mid-line drops the cut line; a walk that reaches the window's start before 4 questions and no mark
  makes ONE deeper read of 4 MiB, not more.
- A5 the list: idle A, queued B, idle C → C, B, A; each press scrolls to its line's uuid before any await.
- A6 a submit adds a pending row (dim, `sending…`, its press toasts); the next refresh that finds a question after its
  `from` removes it and lists the question.
- A7 two quick submits with the SAME text: two pending rows; they settle in order on two different ids.
- A8 the wake text (typed, or sent by the wake button) is never listed and never pending.
- A9 the refresh points: list open, `turn.start`, `turn.complete`, session start; the tick refreshes only while the list is
  open or something is pending, and only when the file grew; one refresh at a time.
- A10 a refused stat or read changes nothing; a file whose lines the walk does not recognise falls back to
  `$.session.messages` (F) with one toast per session.
- A11 session end clears `recent`, `pending` and the old atoms.
- A12 a state from 1.8.1 (`lastQuestion`, `earlierQuestions` set, no `recent`): the list draws from the first refresh; the
  old values are not shown.
- A13 a reload (fresh module) keeps `recent` and `pending`; the next refresh settles a pending one.
- A14 a pin press with the deny `nothing drawn under that requestId` removes the pin and toasts; another deny keeps it.
- A15 the queued question's id after a restart: the same file, the same uuid (the list after a session start lists it).
- A16 a 100,000-character pasted question: the shown text is cut; the parse does not copy whole lines into state.

## Owner checks (after the release reaches this machine)

1. In a long session, type a question while Claude works: it shows in `last answer ▾` (dim `sending…` until the transcript
   holds it, then a jump), and it is still there after a restart.
2. After a compaction, the list holds only questions from after it; an old pin's press says it was compacted away and the
   pin leaves the list.
3. Questions typed while idle still jump as before; pins still work.

## Definition of done

The tests GREEN in CI; the plan and code reviews resolved; the PR merged on green checks; the promotion approved by the
owner; the owner checks recorded; this plan moved to `research/` as IMPLEMENTED.
