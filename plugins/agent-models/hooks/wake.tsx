// The wake button (1.7.0): a press arms a timer that lives in this mod, and every 2 hours it sends `продолжай автономно` to the session,
// so a session that stopped on the 5-hour limit goes on by itself once the limit is back. Nothing here asks the model: the 2 s tick
// (register.tsx) compares the clock with the stored due time and calls `$.prompt.submit`, which the engine holds until the session
// is idle. `$.state` keeps the wake (it survives a hot reload; a session end turns it off). Every function that takes `$` is a function
// declaration (an arrow taking `$` is refused across an import), and this file owns the `wake` atom: the engine's scan reads
// `read($, x)` only for an atom written in the same file, so the draw reads it through `currentWake`. Nothing here throws out of a hook.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Wake } from '../types'
import { limitsClock, MINUTE_MS, minutesLeft, resetText } from './limits'
import { LOGIN_COLOR, reasonLine } from './prompts'
import { submitRefusal } from './tasks'

export const WAKE_MS = 2 * 60 * MINUTE_MS
export const WAKE_TEXT = 'продолжай автономно'
export const WAKE_OFF_LABEL = 'wake 2h'
export const WAKE_OFF_COLOR = '#06b6d4' // cyan
export const WAKE_ON_COLOR = LOGIN_COLOR
const ON_TOAST = 'wake: on — every 2 h, the first at +2h; press again to stop'

const wake = atom({ plugin: 'agent-models', key: 'wake' } as const, null as Wake)

/** The wake now; null (off) when the read is refused or the state was stored before 1.7.0. */
export async function currentWake($: EngineInterface): Promise<Wake> {
  try {
    return (await read($, wake)) ?? null
  } catch {
    return null
  }
}

/**
 * The button's label at `now` (the draw's one clock read, null when it was refused): `wake 2h` while off; `wake in 1h 52m` while on, `wake in <1m`
 * under a minute and also from the due time until the tick claims the fire (never a dash); `wake on` when the clock was refused.
 */
export const wakeLabel = (w: Wake, now: number | null): string => {
  if (w === null) return WAKE_OFF_LABEL
  if (now === null) return 'wake on'
  return now >= w.nextAt ? 'wake in <1m' : `wake in ${resetText(minutesLeft(w.nextAt, now))}`
}

// A toast that is refused is not a failure of the wake.
function say($: EngineInterface, text: string): void {
  try {
    $.ui.toast(text)
  } catch {
    // the surface has no toast
  }
}

// The press: off arms the next fire at now + 2 h; on turns it off. A refused clock or state write toasts the reason and changes nothing.
// A press off does not take back a wake prompt the engine already holds.
async function pressWake($: EngineInterface): Promise<void> {
  try {
    const now = await $.clock.now()
    if (!Number.isFinite(now)) throw new Error('no clock')
    const press = { isOn: false }
    await update($, wake, w => {
      press.isOn = w === null // the change runs again on a version miss: it sets this each time
      return w === null ? { nextAt: now + WAKE_MS, minute: Math.floor(now / MINUTE_MS) } : null
    })
    say($, press.isOn ? ON_TOAST : 'wake: off')
  } catch (error) {
    say($, `wake: ${reasonLine(error)}`)
  }
}

/** The button in the account row; `label` is the one `wakeLabel` made for this draw, so the row cells count what is drawn. */
export function wakeButton($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], label: string, isOn: boolean) {
  const { Button, Text } = $.ui.resolve(e)
  return (
    <Button key="wake" label={label} onPress={() => void pressWake($)}>
      <Text color={isOn ? WAKE_ON_COLOR : WAKE_OFF_COLOR}>{label}</Text>
    </Button>
  )
}

/** At a session end (a `/clear` and a resume end the session too): the wake is off. Never rejects. */
export async function clearWake($: EngineInterface): Promise<void> {
  try {
    await update($, wake, () => null)
  } catch {
    // a refused write: the wake stays; the next session's press turns it off
  }
}

let isTicking = false // this scope's one tick at the wake: a second tick that starts while one is claiming does nothing
let isSending = false // the last wake prompt has not settled: the engine holds it until its turn starts

// One wake prompt. `$.prompt.submit` settles when its turn starts (the engine runs a plugin's prompt once the session is idle), so
// the marker stays set while a long turn runs, and a due time in that time sends nothing new. A drop or a rejection toasts the reason;
// the wake stays on and the next due time sends again.
function send($: EngineInterface): void {
  isSending = true
  void (async () => {
    try {
      const refusal = submitRefusal(await $.prompt.submit({ text: WAKE_TEXT, asUser: true }))
      say($, refusal === undefined ? 'wake: sent' : `wake: ${refusal}`)
    } catch (error) {
      say($, `wake: ${reasonLine(error)}`)
    } finally {
      isSending = false
    }
  })()
}

/**
 * The 2 s tick for the wake; never rejects. Off costs one state read. On: writes the clock minute when it changed (the label counts
 * down), and at the due time CLAIMS the fire with one `update` that moves `nextAt` to now + 2 h; it sends only when this call made that
 * change, so two overlapping ticks, a press off in between or a reload never send twice, and a sleep over several due times sends once.
 */
export async function wakeTick($: EngineInterface): Promise<void> {
  if (isTicking) return
  isTicking = true // before the first await
  try {
    const w = (await read($, wake)) ?? null
    if (w === null) return
    const now = await limitsClock($)
    if (now === null) return
    const minute = Math.floor(now / MINUTE_MS)
    if (minute !== w.minute) await update($, wake, cur => (cur === null ? null : { ...cur, minute }))
    if (now < w.nextAt) return
    const claim = { isMine: false }
    await update($, wake, cur => {
      claim.isMine = cur !== null && now >= cur.nextAt // set again on a version miss
      return cur !== null && claim.isMine ? { ...cur, nextAt: now + WAKE_MS } : cur
    })
    if (claim.isMine && !isSending) send($)
  } catch {
    // a refused state call or clock: the next tick tries again
  } finally {
    isTicking = false
  }
}
