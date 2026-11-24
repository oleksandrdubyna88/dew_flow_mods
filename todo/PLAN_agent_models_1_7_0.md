# PLAN — agent-models mod 1.7.0: a `wake` button that wakes this session every 2 hours

> Status: **plan only, 2026-11-24; review next.** Scope: `plugins/agent-models/` (a `wake` button in the account row, a new
> `hooks/wake.tsx`, one state value, version 1.7.0, the mod's own tests), `todo/README.md`. The release goes the normal way of
> this repository (the promotion with the owner's approval click; installs update by themselves). Parent: the mod as it is
> at `97fc511` (1.6.1).

## Goal (the owner's words, 2026-11-24, translated from Russian)

"Add another button: set a trigger, every 2 h, which will wake this session and say 'продолжай автономно'. Preferably via a
script, so I can press it when the 5-hour limit is used up, and it sets it, and I know that when the limit returns, the
session wakes up."

"Via a script" is read as: the press arms a timer in the mod's own code, which needs no model turn to arm or to fire. A
`/loop` or a cron tool needs the model to set it up, and the model is not available when the 5-hour limit is used up.

Not in this plan: a wake that outlives the Claude Code process (the timer lives in the open session only), another interval
than 2 h or another text (the owner named both), R4 of the mod tests (the follow-up row in `todo/README.md` stays open).

## What the code and the engine do today (read 2026-11-24 at `97fc511`, Claude Code 2.1.331)

- The account row is `accountRow` (`hooks/register.tsx`): `[ messages ]  <account>  [ login ]  [ tasks (n) ]  [ last answer ▾ ]`.
  The open viewer counts the row's width by `accountRowCells` (`hooks/answer.tsx`) in `viewerFixedRows` (`hooks/prompts.ts`).
- The 2 s tick (`tick` in `register.tsx`, a `$.clock.every(REFRESH_MS)` made at `session.start`, or by a draw on a resume)
  runs `refresh`, `tickLimits` and `retryAccount`; each never rejects. A hot reload starts a fresh module scope; the
  `session.start` that follows makes a new tick; `$.state` stays.
- The limits line redraws as its times run down through `limitsMinute` (`hooks/limits.tsx`): the tick writes the clock
  minute only when it changed, and the draw reads it. `resetText(minutes)` makes `1h 52m`, `5m`, `<1m`.
- `turn.start` and `turn.complete` hooks exist in `register.tsx`; `e.agentId === undefined` is the main loop.
- Engine types (2.1.331): `$.prompt.submit({ text, asUser?: true })` is "a turn of its own, once the session is idle"
  (a plugin's prompt is never delivered into a running turn; it waits). `asUser: true` sends the text bare, without the
  "The <plugin> plugin sent a message" frame; the origin stays `{ kind: 'plugin', name, asUser: true }`.
- `noteSubmit` (`hooks/answer.tsx`) records only the person's own prompts as the last question; a plugin's prompt is not
  recorded.

### Probe (2026-11-24, the throw-away dev mod `wake-probe` in this session, now deleted)

A `$.clock.after(60_000, …)` made at `session.start` called `$.prompt.submit({ text, asUser: true })` while the session
was idle. A new turn started with that text as the prompt, and the model answered it. So a mod timer can wake an idle
session with no model call before the fire. Not probed: a fire while the 5-hour limit is used up (the turn is expected to
end with the limit message, as a typed prompt does; the next fire tries again).

## Design

### A. State (`types/index.d.ts`)

- `wake: Wake` in `PluginState['agent-models']`, `Wake = { nextAt: number; minute: number } | null`. `nextAt`: epoch ms of
  the next fire. `minute`: the clock minute the tick last wrote (only its change matters: it redraws the label). null: off.
  Absent (a state from before 1.7.0) reads as null.
- The atom is declared in `hooks/wake.tsx`, the only file that reads or writes it.

### B. The button (`hooks/wake.tsx`, drawn by `accountRow` after `last answer`, or after `tasks (n)` where `last answer` is not drawn)

- Off: `[ wake 2h ]`. On: `[ wake in 1h 52m ]` (`resetText` of the minutes to `nextAt`; `wake in <1m` under a minute; `wake on`
  when the draw's clock read is refused). The on label has another colour than the off one (the colour is not the only
  sign: the text differs too).
- A press when off: `nextAt = now + 2 h`, toast `wake: on — every 2 h, the first at +2h; press again to stop`. A press when on:
  null, toast `wake: off`. A refused clock or state write: toast `wake: <reason>`, nothing changes.
- `accountRowCells` counts the button at its widest off label (`wake 2h`) plus the on label's extra (`wake in 1h 59m`); the
  estimate only moves the `(scroll for more)` header.

### C. The fire (`wakeTick($)` in `hooks/wake.tsx`, added to `tick`)

- Each 2 s tick: read `wake`; null → done (one state read, no clock). Else read the clock; when the minute changed, write it
  (the label redraws). When `now >= nextAt`:
  1. write `nextAt = now + 2 h` FIRST (so a second tick, a reload or a slow submit never fires twice; after a machine
     sleep past several due times it fires once, not once per missed slot);
  2. if a main-loop turn is running (a module flag set by `turn.start`, cleared by `turn.complete`, both only for
     `e.agentId === undefined`), skip this fire: the session is awake. After a hot reload the flag starts false (a fire
     then waits behind the running turn, which the engine does by itself);
  3. else `void $.prompt.submit({ text: 'продолжай автономно', asUser: true })`, not awaited (the tick is never held);
     its result or rejection makes one toast (`wake: sent` / `wake: <reason>`).
- `session.end` writes null, like the other session values.
- Never rejects; a refused state call or clock waits for the next tick.

### D. Version and text

- `plugin.json` 1.7.0; the description gains "a wake button that sends `продолжай автономно` every 2 hours while the
  session is open".

## Files

| File | Change |
|---|---|
| `plugins/agent-models/hooks/wake.tsx` | new: the atom, `wakeButton`, `pressWake`, `wakeTick`, `clearWake`, the turn flag setters, the label helpers |
| `plugins/agent-models/hooks/register.tsx` | the button in `accountRow`, `wakeTick` in `tick`, the flag in `turn.start`/`turn.complete`, `clearWake` in `session.end`, the read in the draw |
| `plugins/agent-models/hooks/answer.tsx` | `accountRowCells` counts the wake button |
| `plugins/agent-models/types/index.d.ts` | `Wake`, `wake` |
| `plugins/agent-models/.claude-plugin/plugin.json` | 1.7.0, the description |
| `plugins/agent-models/tests/wake.test.tsx`, `wake-fixtures.tsx` | new tests (below) |
| `todo/README.md` | the plan row |

## Build order

1. Tests W1–W9 written first and run RED against 1.6.1.
2. `wake.tsx`, the state type, the register wiring, the row cells; the tests GREEN; the whole mod suite GREEN (R4 flakes
   about one run in eight, known; it is not re-run to get green).
3. `claude plugin validate --json` + `tools/type-baseline.mjs`, `tsc`, `npm test`, `copy-proof`, `mods-gate`.

## Tests (`claude plugin test plugins/agent-models`)

- W1 off: the row draws `wake 2h`; a press writes `nextAt = now + 2h` and toasts.
- W2 on: the label is `wake in 1h 52m` at `nextAt - 112 min`; `<1m`; a refused clock in the draw draws `wake on`.
- W3 a press when on writes null and toasts `wake: off`.
- W4 a tick before `nextAt` submits nothing; a tick at `nextAt` submits `продолжай автономно` with `asUser: true` once and
  moves `nextAt` to now + 2 h before the submit settles.
- W5 two ticks at the same due time (the first submit not settled) submit once.
- W6 a due tick while a main-loop turn runs submits nothing and still moves `nextAt`; a subagent's turn does not count.
- W7 a tick long after `nextAt` (a sleep over three slots) submits once, `nextAt = now + 2h`.
- W8 a rejected submit toasts the reason, stays on, and the next due time fires again.
- W9 a state from before 1.7.0 (no `wake`) draws `wake 2h`; `session.end` writes null; the minute write happens only when
  the minute changes.

## Owner checks (after the release reaches this machine)

1. The row shows `[ wake 2h ]`; a press shows `wake in 1h 59m` and the toast; a second press turns it off.
2. Armed while idle: two hours later the session gets the turn `продолжай автономно` and works on.
3. Armed when the 5-hour limit is used up: a wake before the reset fails like a typed prompt; the first wake after the
   reset works.

## Definition of done

The tests above GREEN in CI; the plan review and the code review resolved; the PR merged on green checks; the promotion
approved by the owner; the owner checks 1–3 recorded; this plan moved to `research/` as IMPLEMENTED.
