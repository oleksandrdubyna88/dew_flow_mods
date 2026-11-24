import type { Engine, Mounted } from 'claude-code/testing'
import type { On, PromptSubmitResult } from 'claude-code'

import type { Wake } from '../types'
import { gate } from './answer-fixtures'
import { BAND, ok, ownClock, spin } from './limits-fixtures'
import type { OwnClock } from './limits-fixtures'

// The helpers of the wake tests (wake.test.tsx): a session whose clock the test steers by hand, every state write of the wake,
// every toast and every prompt the wake sent, and a prompt hook the test can hold or make refuse. Not a test file.

export { BAND, gate, spin }
export type Ui = Mounted<'terminal' | 'desktop', 'AbovePrompt'>

export const WAKE_KEY = { plugin: 'agent-models', key: 'wake' } as const
export const MIN = 60_000
export const H = 60 * MIN
export const START = Date.UTC(2026, 10, 24, 10, 0, 10) // 10 s into a clock minute
export const TEXT = 'продолжай автономно'
export const ON_TOAST = 'wake: on — every 2 h, the first at +2h; press again to stop'

export type Sent = { text: string; origin: unknown }
export type WakeWorld = {
  clk: OwnClock
  writes: Wake[] // every state write of the wake, in order
  keys: string[] // the key of every state write of the mod
  toasts: string[]
  sent: Sent[] // every prompt that reached the bottom of the prompt chain
  events: string[] // `write:null` and `end`, in the order they happened
  holds: Record<number, Promise<void>> // the n-th prompt (from 0) waits for this before it settles
  behave: (n: number) => PromptSubmitResult | undefined // undefined: accept (a hook that throws is skipped: the call then rejects, nothing beneath answers)
  afterRead: (() => Promise<void>) | undefined // each read of the wake waits for this after it read (the answer is fixed), until the test unsets it
  isWriteRefused: boolean // the engine refuses a write of the wake
}

/** The newest stored wake: undefined before the first write. */
export const lastWake = (w: WakeWorld): Wake | undefined => w.writes.at(-1)
export const wakeToasts = (w: WakeWorld): string[] => w.toasts.filter(t => t.startsWith('wake'))

/** A started session under the mod with a hand-steered clock (`w.clk`); `seed` is a stored wake the session already holds (a reload kept it). */
export const wakeWorld = async ($: Engine, on: On, o: { now?: number; seed?: Wake } = {}): Promise<WakeWorld> => {
  const clk = ownClock(on, o.now ?? START)
  const w: WakeWorld = { clk, writes: [], keys: [], toasts: [], sent: [], events: [], holds: {}, behave: () => undefined, afterRead: undefined, isWriteRefused: false }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('session.identity', () => ({ value: { deny: 'not a managed mod' } }))
  on('process.run', () => ({ value: ok(JSON.stringify({ loggedIn: false })) }))
  on('session.end', (_, e) => {
    w.events.push('end')
    return { sessionId: e.sessionId }
  })
  on('state.set', (_, e, next) => {
    w.keys.push(e.key)
    if (e.plugin === 'agent-models' && e.key === 'wake') {
      const value: Wake = e.value === null ? null : JSON.parse(JSON.stringify(e.value))
      w.writes.push(value)
      if (value === null) w.events.push('write:null')
    }
    return next(e)
  })
  // hooks beneath the plugins are registered before the first call on `$` (the session start below)
  let isWritten = false
  on('state.set', WAKE_KEY, (_, e, next) => {
    if (w.isWriteRefused) return { deny: 'the store said no' }
    isWritten = true
    return next(e)
  })
  const seed = o.seed
  on('state.get', WAKE_KEY, async (_, e, next) => {
    const answer = seed !== undefined && !isWritten ? { value: { value: seed, version: 0 } } : await next(e)
    await w.afterRead?.()
    return answer
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  let calls = 0
  on('prompt.submit', async (_, e) => {
    const n = calls
    calls += 1
    w.sent.push({ text: e.text, origin: e.origin })
    await w.holds[n]
    return w.behave(n) ?? { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await spin()
  return w
}

/** The clock moves `ms` on and one period of the 2 s timer runs; then time for what the tick started. */
export const advance = async (w: WakeWorld, ms: number): Promise<void> => {
  await w.clk.tick(ms)
  await spin()
}

export const mountBand = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => $.ui.mount({ ...BAND, props: { ...BAND.props, isCollapsed: false }, surface })
export const wakeButton = (ui: Ui) => ui.find({ type: 'Button', key: 'wake' })
export const pressWake = async (ui: Ui) => {
  await ui.press({ key: 'wake' })
  await spin()
  await ui.redraw()
}
/** The label the button draws now. */
export const labelOf = async (ui: Ui): Promise<string | undefined> => {
  const button = await wakeButton(ui)
  const label = button?.props.label
  return typeof label === 'string' ? label : undefined
}
export const wakeText = (ui: Ui) => ui.find({ type: 'Text', text: /^wake / })
