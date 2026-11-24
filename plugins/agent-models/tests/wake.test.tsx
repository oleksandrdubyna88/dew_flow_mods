import { expect, test } from 'claude-code/testing'

import { WAKE_GUARD_TICKS } from '../hooks/wake'
import { COMPOSER, submitOf } from './answer-fixtures'

import {
  advance, gate, H, labelOf, lastWake, mountBand, MIN, ON_TOAST, pressWake, spin, START, TEXT, tick, wakeText, wakeToasts, wakeWorld,
} from './wake-fixtures'

// The wake button (1.7.0): a press arms a timer in the mod; each 2 s tick sends `продолжай автономно` once the due time has come.
// The clock is steered by hand (`w.clk`): a tick moves it and runs one period of the 2 s timer.

const SURFACES = ['terminal', 'desktop'] as const
const ARMED = { nextAt: START + 2 * H, minute: 120 } // what a press at START stores: the due time and the minutes left (1.7.0: the label's own minute)
const SKIP = 'wake: skipped — the last wake still waits for its turn'

// --- the button ---

for (const surface of SURFACES) {
  test(`W1 off: the row draws wake 2h; a press writes nextAt = now + 2h, toasts, and the colour changes (${surface})`, async ($, on) => {
    const w = await wakeWorld($, on)
    const ui = await mountBand($, surface)
    expect(await labelOf(ui)).toBe('wake 2h')
    const off = await wakeText(ui)
    expect(off?.text).toBe('wake 2h')
    expect(off?.props.color).toBeDefined()
    expect(w.writes).toHaveLength(0)
    await pressWake(ui)
    expect(w.writes).toEqual([ARMED])
    expect(wakeToasts(w)).toEqual([ON_TOAST])
    expect(await labelOf(ui)).toBe('wake in 2h 0m')
    const armed = await wakeText(ui)
    expect(armed?.props.color).toBeDefined()
    expect(armed?.props.color, 'the on label has another colour than the off one').not.toBe(off?.props.color)
    await ui.unmount()
  })
}

test('W1b the wake button follows the last answer button in the row', async ($, on) => {
  await wakeWorld($, on)
  const ui = await mountBand($)
  const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key)
  expect(keys.slice(-2)).toEqual(['last-answer', 'wake'])
  await ui.unmount()
})

test('W2 on: the label counts down from the due time; under a minute is <1m; a refused clock at the draw says wake on', async ($, on) => {
  const w = await wakeWorld($, on, { seed: { nextAt: START + 112 * MIN, minute: 112 } })
  const ui = await mountBand($)
  expect(await labelOf(ui)).toBe('wake in 1h 52m')
  w.clk.now = START + 112 * MIN - 30_000
  await ui.redraw()
  expect(await labelOf(ui)).toBe('wake in <1m')
  w.clk.now = START + 112 * MIN - 5 * MIN
  await ui.redraw()
  expect(await labelOf(ui)).toBe('wake in 5m')
  w.clk.isRefused = true
  await ui.redraw()
  expect(await labelOf(ui)).toBe('wake on')
  await ui.unmount()
})

test('W3 a press when on writes null and toasts wake: off', async ($, on) => {
  const w = await wakeWorld($, on, { seed: ARMED })
  const ui = await mountBand($)
  await pressWake(ui)
  expect(lastWake(w)).toBeNull()
  expect(wakeToasts(w)).toEqual(['wake: off'])
  expect(await labelOf(ui)).toBe('wake 2h')
  await ui.unmount()
})

test('W3b a refused state write toasts wake: <reason> and changes nothing', async ($, on) => {
  const w = await wakeWorld($, on)
  w.isWriteRefused = true
  const ui = await mountBand($)
  await pressWake(ui)
  expect(wakeToasts(w)).toHaveLength(1)
  expect(wakeToasts(w)[0]).toMatch(/^wake: .*the store said no/)
  expect(await labelOf(ui)).toBe('wake 2h')
  await ui.unmount()
})

test('W3c a refused clock at the press toasts wake: <reason> and writes nothing', async ($, on) => {
  const w = await wakeWorld($, on)
  const ui = await mountBand($)
  w.clk.isRefused = true
  await pressWake(ui)
  expect(w.writes).toHaveLength(0)
  expect(wakeToasts(w)).toHaveLength(1)
  expect(wakeToasts(w)[0]).toMatch(/^wake: /)
  await ui.unmount()
})

// --- the fire ---

test('W4 a tick before nextAt sends nothing; the tick at nextAt sends once and moves nextAt before the prompt settles', async ($, on) => {
  const w = await wakeWorld($, on)
  const held = gate()
  w.holds[0] = held.wait
  const ui = await mountBand($)
  await pressWake(ui)
  await advance(w, 2 * H - 4_000)
  expect(w.sent).toHaveLength(0)
  await advance(w, 4_000) // now = nextAt
  expect(w.sent).toHaveLength(1)
  expect(w.sent[0]?.text).toBe(TEXT)
  expect(w.sent[0]?.origin).toMatchObject({ kind: 'plugin', name: 'agent-models', asUser: true })
  expect(lastWake(w)?.nextAt, 'the claim moved the next due time while the prompt still waits').toBe(w.clk.now + 2 * H)
  await advance(w, 2_000)
  expect(w.sent, 'a tick before the next due time sends nothing').toHaveLength(1)
  held.release()
  await spin()
  expect(wakeToasts(w).at(-1)).toBe('wake: sent')
  expect(lastWake(w)).not.toBeNull()
  await ui.unmount()
})

test('W5 two ticks at the same due time, the first still holding the state it read, send once', async ($, on) => {
  const w = await wakeWorld($, on)
  const ui = await mountBand($)
  await pressWake(ui)
  w.clk.now = ARMED.nextAt
  const g = gate()
  w.afterRead = async () => {
    w.afterRead = undefined
    await g.wait // the first tick holds the due state it read
  }
  const first = tick(w, 0)
  await spin()
  await advance(w, 0) // a second tick of the same timer starts while the first one has not claimed
  expect(w.sent).toHaveLength(0)
  g.release()
  await first
  await spin()
  expect(w.sent).toHaveLength(1)
  expect(lastWake(w)?.nextAt).toBe(ARMED.nextAt + 2 * H)
  await ui.unmount()
})

test('W5c a tick whose due state was claimed or re-armed by someone else before its claim sends nothing and moves nothing', async ($, on) => {
  const w = await wakeWorld($, on)
  const ui = await mountBand($)
  await pressWake(ui)
  w.clk.now = ARMED.nextAt
  const g = gate()
  w.afterRead = async () => {
    w.afterRead = undefined
    await g.wait
  }
  const ticking = tick(w, 0)
  await spin()
  await pressWake(ui) // off
  await pressWake(ui) // on again: the due time is now + 2h, as if another scope had claimed this one
  expect(lastWake(w)?.nextAt).toBe(ARMED.nextAt + 2 * H)
  g.release()
  await ticking
  await spin()
  expect(w.sent).toHaveLength(0)
  expect(lastWake(w)?.nextAt).toBe(ARMED.nextAt + 2 * H)
  await ui.unmount()
})

test('W5b a press off between a tick\'s read and its claim gives no send, and the state stays null', async ($, on) => {
  const w = await wakeWorld($, on)
  const ui = await mountBand($)
  await pressWake(ui)
  w.clk.now = ARMED.nextAt
  const g = gate()
  w.afterRead = async () => {
    w.afterRead = undefined
    await g.wait // the tick holds the due state it read; later reads (the press) go through
  }
  const ticking = tick(w, 0)
  await spin()
  await pressWake(ui) // off
  expect(lastWake(w)).toBeNull()
  const after = w.writes.length
  g.release()
  await ticking
  await spin()
  expect(w.sent).toHaveLength(0)
  expect(w.writes.slice(after).every(v => v === null), 'nothing arms the wake again').toBe(true)
  expect(lastWake(w)).toBeNull()
  await ui.unmount()
})

test('W6 a due time while the last wake prompt has not settled moves nextAt and sends nothing; after it settles the next due time sends', async ($, on) => {
  const w = await wakeWorld($, on)
  const held = gate()
  w.holds[0] = held.wait
  const ui = await mountBand($)
  await pressWake(ui)
  await advance(w, 2 * H)
  expect(w.sent).toHaveLength(1)
  await advance(w, 2 * H) // the next due time: the first prompt still waits behind a long turn
  expect(w.sent, 'nothing piles up behind the unsettled prompt').toHaveLength(1)
  expect(lastWake(w)?.nextAt, 'the due time was claimed').toBe(w.clk.now + 2 * H)
  held.release()
  await spin()
  await advance(w, 2 * H)
  expect(w.sent).toHaveLength(2)
  await ui.unmount()
})

test('W7 a tick long after nextAt (a sleep over three slots) sends once; nextAt = now + 2h', async ($, on) => {
  const w = await wakeWorld($, on)
  const ui = await mountBand($)
  await pressWake(ui)
  await advance(w, 7 * H)
  expect(w.sent).toHaveLength(1)
  expect(lastWake(w)?.nextAt).toBe(w.clk.now + 2 * H)
  await advance(w, 2_000)
  expect(w.sent).toHaveLength(1)
  await ui.unmount()
})

test('W8 a rejected prompt toasts the reason, the wake stays on, and the next due time sends again', async ($, on) => {
  const w = await wakeWorld($, on)
  // no `prompt.submit` answer beneath the plugin: the call rejects, as a refused one does (a hook that throws is skipped)
  w.behave = () => {
    throw new Error('the engine said no')
  }
  const ui = await mountBand($)
  await pressWake(ui)
  await advance(w, 2 * H)
  expect(w.sent).toHaveLength(1)
  expect(wakeToasts(w).at(-1)).toMatch(/^wake: .*no implementation for prompt\.submit/)
  expect(lastWake(w)).not.toBeNull()
  await advance(w, 2 * H)
  expect(w.sent).toHaveLength(2)
  expect(wakeToasts(w).filter(t => /no implementation for prompt\.submit/.test(t))).toHaveLength(2)
  await ui.unmount()
})

test('W8b a dropped prompt toasts the reason, the wake stays on, and the next due time sends again', async ($, on) => {
  const w = await wakeWorld($, on)
  w.behave = () => ({ drop: 'a hook said no' })
  const ui = await mountBand($)
  await pressWake(ui)
  await advance(w, 2 * H)
  expect(w.sent).toHaveLength(1)
  expect(wakeToasts(w).at(-1)).toMatch(/^wake: .*a hook said no/)
  expect(lastWake(w)).not.toBeNull()
  await advance(w, 2 * H)
  expect(w.sent).toHaveLength(2)
  await ui.unmount()
})

// --- state, the end of a session, the minute ---

test('W9 a state from before 1.7.0 (no wake) draws wake 2h and a tick writes nothing', async ($, on) => {
  const w = await wakeWorld($, on)
  const ui = await mountBand($)
  expect(await labelOf(ui)).toBe('wake 2h')
  await advance(w, 2_000)
  await advance(w, 2 * H)
  expect(w.writes).toHaveLength(0)
  expect(w.sent).toHaveLength(0)
  await ui.unmount()
})

test('W9b a session end writes null before the end step', async ($, on) => {
  const w = await wakeWorld($, on, { seed: ARMED })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await spin()
  expect(lastWake(w)).toBeNull()
  expect(w.events).toEqual(['write:null', 'end'])
})

test('W9c the minutes left are written only when they change, at the moment the label turns', async ($, on) => {
  const w = await wakeWorld($, on)
  const ui = await mountBand($)
  await pressWake(ui)
  expect(w.writes).toEqual([ARMED])
  await advance(w, 2_000) // 1h 59m 58s left: the label says 1h 59m
  const turned = { nextAt: ARMED.nextAt, minute: 119 }
  expect(w.writes, 'the label turned at the first tick, not at a clock minute').toEqual([ARMED, turned])
  for (let i = 0; i < 4; i += 1) await advance(w, 2_000) // 10 s in: still 1h 59m
  expect(w.writes, 'no write for the ticks inside one label minute').toEqual([ARMED, turned])
  await advance(w, 60_000) // 1h 58m 50s left
  expect(w.writes).toEqual([ARMED, turned, { nextAt: ARMED.nextAt, minute: 118 }])
  expect(await labelOf(ui)).toBe('wake in 1h 58m')
  await ui.unmount()
})

test('W9d at the due time before the claim the label is wake in <1m, never a dash', async ($, on) => {
  const w = await wakeWorld($, on, { seed: ARMED })
  const ui = await mountBand($)
  w.clk.now = ARMED.nextAt
  await ui.redraw()
  expect(await labelOf(ui)).toBe('wake in <1m')
  w.clk.now = ARMED.nextAt + 3 * H
  await ui.redraw()
  expect(await labelOf(ui)).toBe('wake in <1m')
  await ui.unmount()
})

test('W10 an armed state met by a fresh module scope (a hot reload) fires once at its due time', async ($, on) => {
  const w = await wakeWorld($, on, { seed: { nextAt: START + 20_000, minute: 0 } })
  await advance(w, 10_000)
  expect(w.sent).toHaveLength(0)
  await advance(w, 10_000) // now = nextAt
  expect(w.sent).toHaveLength(1)
  expect(w.sent[0]?.text).toBe(TEXT)
  await advance(w, 2_000)
  expect(w.sent).toHaveLength(1)
  expect(lastWake(w)?.nextAt).toBe(START + 20_000 + 2 * H)
})

test('W11 the wake prompt (origin plugin) is not recorded as the last question', async ($, on) => {
  const w = await wakeWorld($, on)
  const ui = await mountBand($)
  await pressWake(ui)
  await advance(w, 2 * H)
  expect(w.sent).toHaveLength(1)
  expect(w.sent[0]?.origin).toMatchObject({ kind: 'plugin' })
  expect(w.keys, 'noteSubmit wrote no lastQuestion').not.toContain('lastQuestion')
  await $.prompt.submit(submitOf('a question the person typed', COMPOSER)) // the control: the hook does see prompts, and records a person's own
  await spin()
  expect(w.keys, 'a composer prompt IS recorded').toContain('lastQuestion')
  await ui.unmount()
})

// --- a wake that is lost, and a guard that is lost (code review) ---

test('W13 a wake prompt that never settles: the next due time skips with a toast; the one after (4 h) counts it as lost and sends again', async ($, on) => {
  const w = await wakeWorld($, on)
  w.holds[0] = new Promise<void>(() => undefined) // the person removed it from the queue: it never settles
  const ui = await mountBand($)
  await pressWake(ui)
  await advance(w, 2 * H)
  expect(w.sent).toHaveLength(1)
  await advance(w, 2 * H)
  expect(w.sent, 'the first prompt still counts as waiting').toHaveLength(1)
  expect(wakeToasts(w).at(-1)).toBe(SKIP)
  expect(lastWake(w)?.nextAt, 'the due time was claimed').toBe(w.clk.now + 2 * H)
  await advance(w, 2 * H)
  expect(w.sent, 'a marker two intervals old is lost: send again').toHaveLength(2)
  expect(wakeToasts(w).filter(t => t === SKIP)).toHaveLength(1)
  await ui.unmount()
})

test('W14 a tick that holds the guard for 30 more ticks is lost: the next one goes on and sends', async ($, on) => {
  const w = await wakeWorld($, on)
  const ui = await mountBand($)
  await pressWake(ui)
  w.clk.now = ARMED.nextAt
  w.afterRead = async () => {
    w.afterRead = undefined
    await new Promise<void>(() => undefined) // the first tick never comes back from its state read
  }
  await advance(w, 0)
  for (let i = 0; i < WAKE_GUARD_TICKS - 1; i += 1) await advance(w, 0)
  expect(w.sent, 'the guard turned away 29 ticks').toHaveLength(0)
  await advance(w, 0) // the 30th turned away: it goes on
  expect(w.sent).toHaveLength(1)
  expect(lastWake(w)?.nextAt).toBe(ARMED.nextAt + 2 * H)
  await ui.unmount()
})
