import { expect, test } from 'claude-code/testing'

import { wakeTick } from '../hooks/wake'
import { gate, H, lastWake, mountBand, MIN, pressWake, spin, START, wakeWorld, WAKE_KEY } from './wake-fixtures'

const ARMED = { nextAt: START + 2 * H, minute: Math.floor(START / MIN) } // what a press at START stores

// W5 apart from wake.test.tsx: it imports the module a second time. This file's copy of `hooks/wake` is a scope of its own (its guard
// and its in-flight marker are not the mod's), as the scope of a hot reload is; only the stored state joins them.

test('W5 two ticks that both read the due state before either claims send once (a second module copy stands for a reload)', async ($, on) => {
  const w = await wakeWorld($, on)
  const ui = await mountBand($)
  await pressWake(ui)
  w.clk.now = ARMED.nextAt
  const g = gate()
  let held = 0
  on('state.get', WAKE_KEY, async (_, e, next) => {
    const answer = await next(e) // the read is done: the answer is fixed when the hold begins
    if (held < 2) {
      held += 1
      await g.wait
    }
    return answer
  })
  const plugin = w.clk.tick(0) // the mod's own tick
  const other = wakeTick($) // this file's own copy of the module: a second scope, as a hot reload makes
  await spin()
  expect(held, 'both ticks read before either goes on').toBe(2)
  g.release()
  await Promise.all([plugin, other])
  await spin()
  expect(w.sent).toHaveLength(1)
  expect(lastWake(w)?.nextAt).toBe(ARMED.nextAt + 2 * H)
  await ui.unmount()
})

