import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { PromptOrigin, SessionMessage } from 'claude-code'

import { NO_QUESTION_ROW, RESTORE_ROWS } from '../hooks/answer'
import { earlierFrom, typedQuestions } from '../hooks/questions'
import { WAKE_TEXT } from '../hooks/wake'
import type { LastQuestion } from '../types'
import { band, start } from './account-fixtures'
import type { Ui } from './account-fixtures'
import { answer, COMPOSER, gate, held, KEY, question, session, spin, typed, valueOf } from './answer-fixtures'
import type { Session } from './answer-fixtures'
import { ask, EARLIER_KEY, entries, entry, labels, lastEarlier, opened, Q, recent, uuids } from './answer-recent-fixtures'
import type { Entry } from './answer-recent-fixtures'

// The wake text of 1.8.1 (plan todo/PLAN_agent_models_1_8_1.md, V1 to V13): `продолжай автономно` is never shown as a question,
// also when the owner types it, and a stored value that holds it is replaced by the newest real question. Tests that only assert an
// absence (they pass against 1.8.0 as well): V7a, V7b, V13.

const WAKE_ROW = (uuid = 'uW'): SessionMessage => question(WAKE_TEXT, uuid)
const WAKE_VALUE: Exclude<LastQuestion, null> = { uuid: 'uW', text: WAKE_TEXT }
const PENDING_WAKE: Exclude<LastQuestion, null> = { pending: WAKE_TEXT, previous: 'uC', previousText: 'C' }
/** A transcript with the questions A to D, then the wake text the owner (or the wake) sent. */
const four = (): SessionMessage[] => [Q('A'), answer('a1'), Q('B'), answer('a2'), Q('C'), answer('a3'), Q('D'), answer('a4'), WAKE_ROW(), answer('a5')]
const asked = async ($: Engine, s: Session, ...names: string[]): Promise<void> => {
  for (const name of names) await ask($, s, name)
}
const end = ($: Engine) => $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
/** What the engine holds for `lastQuestion` now, while the band is mounted (the draw reads it). */
const nowHeld = async (ui: Ui, s: Session): Promise<LastQuestion> => {
  await ui.redraw()
  return s.read
}
const wakeEntry: Entry = { uuid: 'uW', text: WAKE_TEXT }
const isSettled = (w: LastQuestion, uuid: string): boolean => w !== null && 'uuid' in w && w.uuid === uuid
/** Closes and opens the list again (each open is a repair chance). */
const reopen = async (ui: Awaited<ReturnType<typeof opened>>): Promise<void> => {
  await ui.press({ key: 'last-answer' })
  await ui.press({ key: 'last-answer' })
  await spin()
  await ui.redraw()
}

test('V1 the owner types the wake text after question C (composer and bridge): lastQuestion stays C, nothing pending', async ($, on) => {
  const s = session(on)
  const r = recent(on)
  await start($)
  await asked($, s, 'A', 'B', 'C')
  const before = [s.writes.length, r.writes.length]
  const origins: PromptOrigin[] = [COMPOSER, { kind: 'bridge' }]
  for (const origin of origins) {
    s.rows = [...s.rows, WAKE_ROW(`uW-${origin.kind}`)]
    await typed($, WAKE_TEXT, origin)
  }
  expect([s.writes.length, r.writes.length], 'nothing was written').toEqual(before)
  expect(await held($, s)).toEqual({ uuid: 'uC', text: 'C' })
  const ui = await opened($)
  expect(await labels(ui)).toEqual(['› C', '› B', '› A'])
  await ui.unmount()
})

test('V2 a session start with a settled wake value and questions A to D: row 1 becomes D, the list C, B, A, the list written first', async ($, on) => {
  const s = session(on, four())
  s.seed = WAKE_VALUE
  const r = recent(on)
  await start($)
  expect(valueOf(s)).toEqual({ uuid: 'uD', text: 'D' })
  expect(lastEarlier(r)).toEqual(entries('C', 'B', 'A'))
  expect(r.log).toEqual(['earlierQuestions', 'lastQuestion'])
})

test('V3 the same state, no session start, the list opens: the same repair; a second open reads no 200 rows', async ($, on) => {
  const s = session(on, four())
  s.seed = WAKE_VALUE
  const r = recent(on)
  const ui = await opened($)
  expect(await labels(ui)).toEqual(['› D', '› C', '› B'])
  expect(valueOf(s)).toEqual({ uuid: 'uD', text: 'D' })
  expect(lastEarlier(r)).toEqual(entries('C', 'B', 'A'))
  const reads = s.reads.length
  await reopen(ui)
  expect(s.reads.slice(reads).filter(read => read.last !== undefined && read.last > 50), 'no repair read the second time').toEqual([])
  expect(await labels(ui)).toEqual(['› D', '› C', '› B'])
  await ui.unmount()
})

test('V4 a pending value whose pending is the wake text: repaired at the list open', async ($, on) => {
  const s = session(on, four())
  s.seed = PENDING_WAKE
  const r = recent(on)
  const ui = await opened($)
  expect(await labels(ui)).toEqual(['› D', '› C', '› B'])
  expect(await nowHeld(ui, s)).toEqual({ uuid: 'uD', text: 'D' })
  expect(lastEarlier(r)).toEqual(entries('C', 'B', 'A'))
  await ui.unmount()
})

test('V4b the same, and retryPending settles the pending wake value during the repair\'s read: row 1 still becomes D', async ($, on) => {
  const s = session(on, four())
  s.seed = PENDING_WAKE
  const r = recent(on)
  const g = gate()
  s.hold = { last: RESTORE_ROWS, wait: g.wait }
  const ui = await band($)
  void ui.press({ key: 'last-answer' })
  await spin()
  expect(s.hold, 'the repair\'s read is held (it was issued)').toBeUndefined()
  await $.turn.start({ text: 'x', turnId: 't2' }) // the pending wake row is in the transcript: it settles to the wake row
  await spin()
  expect(s.writes.some(w => isSettled(w, 'uW')), 'the settle landed during the held read').toBe(true)
  g.release()
  await spin()
  expect(await nowHeld(ui, s)).toEqual({ uuid: 'uD', text: 'D' })
  expect(uuids(lastEarlier(r))).toEqual(['uC', 'uB', 'uA'])
  expect(await labels(ui)).toEqual(['› D', '› C', '› B'])
  await ui.unmount()
})

test('V5 a kept entry whose text is the wake text is dropped by earlierFrom, and a stored list holding one draws without it', async ($, on) => {
  const rows = [Q('C'), answer('a1'), Q('D'), answer('a2')]
  expect(earlierFrom(rows, 'uD', [wakeEntry, entry('B')]), 'the pure rebuild').toEqual(entries('C', 'B'))
  const s = session(on, rows)
  s.seed = { uuid: 'uD', text: 'D' }
  const r = recent(on, { seed: [entry('C'), wakeEntry, entry('B')] })
  const ui = await opened($)
  expect(lastEarlier(r), 'the next rebuild').toEqual(entries('C', 'B'))
  expect(await labels(ui)).toEqual(['› D', '› C', '› B'])
  await ui.unmount()
})

test('V6 a wake value and no typed question in the rows read (session start): lastQuestion becomes null and the list says no question yet', async ($, on) => {
  const s = session(on, [WAKE_ROW(), answer('a1')])
  s.seed = WAKE_VALUE
  recent(on)
  await start($)
  expect(s.writes).toEqual([null])
  const ui = await opened($)
  expect(await ui.find({ type: 'Text', text: NO_QUESTION_ROW })).toBeDefined()
  await ui.unmount()
})

test('V6b the same at the list open, with no session start', async ($, on) => {
  const s = session(on, [WAKE_ROW(), answer('a1')])
  s.seed = WAKE_VALUE
  recent(on)
  const ui = await opened($)
  expect(s.writes).toEqual([null])
  expect(await ui.find({ type: 'Text', text: NO_QUESTION_ROW })).toBeDefined()
  await ui.unmount()
})

// --- V7: races of the repair (absence of writes) ---

test('V7a (absence) a newer submit during the repair\'s read: the repair writes nothing', async ($, on) => {
  const s = session(on, four())
  s.seed = WAKE_VALUE
  const r = recent(on)
  const g = gate()
  s.hold = { last: RESTORE_ROWS, wait: g.wait }
  const ui = await band($)
  void ui.press({ key: 'last-answer' })
  await spin()
  s.rows = [...s.rows, Q('E')]
  await typed($, 'E')
  g.release()
  await spin()
  expect(await nowHeld(ui, s)).toEqual({ uuid: 'uE', text: 'E' })
  expect(s.writes.some(w => isSettled(w, 'uD')), 'row 1 never became D').toBe(false)
  expect(r.writes.some(w => uuids(w)?.join() === 'uC,uB,uA'), 'the repair\'s list was not written').toBe(false)
  expect(uuids(lastEarlier(r))).toEqual(['uD', 'uC', 'uB'])
  expect(await labels(ui)).toEqual(['› E', '› D', '› C'])
  await ui.unmount()
})

test('V7b (absence) a session end during the repair\'s read: only the clears are written', async ($, on) => {
  const s = session(on, four())
  s.seed = WAKE_VALUE
  const r = recent(on)
  const g = gate()
  s.hold = { last: RESTORE_ROWS, wait: g.wait }
  const ui = await band($)
  void ui.press({ key: 'last-answer' })
  await spin()
  await end($)
  await spin()
  const after = [s.writes.length, r.writes.length]
  g.release()
  await spin()
  expect(s.writes.slice(after[0]).every(w => w === null), 'only null after the end').toBe(true)
  expect(r.writes.slice(after[1]).every(w => w.length === 0), 'only empty lists after the end').toBe(true)
  expect(await nowHeld(ui, s)).toBeNull()
  await ui.unmount()
})

test('V7c a newer submit between the two writes of the repair: no lastQuestion write of the repair, and no question twice in the draw', async ($, on) => {
  const s = session(on, four())
  s.seed = WAKE_VALUE
  const r = recent(on)
  const g = gate()
  let isHeld = false
  on('state.set', KEY, async (_, e, next) => {
    if (!isHeld && isSettled(e.value, 'uD')) {
      isHeld = true
      await g.wait // the repair's lastQuestion write waits; its list write has landed
    }
    return next(e)
  })
  const ui = await band($)
  void ui.press({ key: 'last-answer' })
  await spin()
  expect(uuids(lastEarlier(r)), 'the repair\'s list is written first').toEqual(['uC', 'uB', 'uA'])
  await ui.redraw()
  const between = await labels(ui)
  expect(new Set(between).size, 'between the two writes no question shows twice').toBe(between.length)
  s.rows = [...s.rows, Q('E')]
  await typed($, 'E')
  expect(isHeld, 'the repair\'s lastQuestion write was held').toBe(true)
  g.release()
  await spin()
  expect(await nowHeld(ui, s)).toEqual({ uuid: 'uE', text: 'E' })
  expect(uuids(lastEarlier(r))).toEqual(['uD', 'uC', 'uB'])
  expect(await labels(ui)).toEqual(['› E', '› D', '› C'])
  await ui.unmount()
})

// --- V8: a refused or empty read ---

test('V8 a refused transcript read during the repair: the wake value stays; the next list open repairs it', async ($, on) => {
  const s = session(on, four())
  s.seed = WAKE_VALUE
  recent(on)
  s.isDenied = true
  const ui = await opened($)
  expect(s.writes, 'nothing was written').toEqual([])
  expect(await nowHeld(ui, s)).toEqual(WAKE_VALUE)
  s.isDenied = false
  await reopen(ui)
  expect(await nowHeld(ui, s)).toEqual({ uuid: 'uD', text: 'D' })
  await ui.unmount()
})

test('V8b an empty transcript read during the repair: the wake value stays; the next list open repairs it', async ($, on) => {
  const s = session(on, [])
  s.seed = WAKE_VALUE
  recent(on)
  const ui = await opened($)
  expect(s.writes, 'nothing was written').toEqual([])
  expect(await nowHeld(ui, s)).toEqual(WAKE_VALUE)
  s.rows = four()
  await reopen(ui)
  expect(await nowHeld(ui, s)).toEqual({ uuid: 'uD', text: 'D' })
  await ui.unmount()
})

// --- V9 to V10: the owner types ---

test('V9 a settled wake value, then the owner types a new question before any list open: row 1 never shows the wake text (sending…)', async ($, on) => {
  const s = session(on, four())
  s.seed = WAKE_VALUE
  recent(on)
  await typed($, 'E') // not in the transcript yet
  expect(valueOf(s), 'the wake value is not the question before it').toEqual({ pending: 'E' })
  const ui = await opened($)
  expect((await labels(ui)).join('|')).not.toContain(WAKE_TEXT)
  s.rows = [...s.rows, Q('E')]
  await $.turn.start({ text: 'E', turnId: 't2' })
  await spin()
  expect(await nowHeld(ui, s)).toEqual({ uuid: 'uE', text: 'E' })
  expect((await labels(ui))[0]).toBe('› E')
  await ui.unmount()
})

test('V10 the owner types the wake text while question P is pending: P stays pending, settles, and no wake row is in rows 2 and 3', async ($, on) => {
  const s = session(on)
  const r = recent(on)
  await start($)
  await asked($, s, 'A', 'B', 'C')
  await typed($, 'P') // not in the transcript yet
  const pending = valueOf(s)
  expect(pending).toEqual({ pending: 'P', previous: 'uC', previousText: 'C' })
  await typed($, WAKE_TEXT)
  expect(valueOf(s), 'the wake text changed nothing').toEqual(pending)
  s.rows = [...s.rows, Q('P'), WAKE_ROW()]
  await $.turn.start({ text: 'P', turnId: 't2' })
  await spin()
  expect(await held($, s)).toEqual({ uuid: 'uP', text: 'P' })
  expect(uuids(lastEarlier(r))).toEqual(['uC', 'uB', 'uA'])
  const ui = await opened($)
  expect(await labels(ui)).toEqual(['› P', '› C', '› B'])
  await ui.unmount()
})

test('V11 a wake value and only ONE typed question D (and a list that holds D): row 1 becomes D, the list is empty, a later list open is not stopped', async ($, on) => {
  const s = session(on, [Q('D'), answer('a1'), WAKE_ROW(), answer('a2')])
  s.seed = WAKE_VALUE
  const r = recent(on, { seed: entries('D') }) // what 1.8.0's fill left: the questions older than the wake row
  const ui = await opened($)
  expect(await nowHeld(ui, s)).toEqual({ uuid: 'uD', text: 'D' })
  expect(lastEarlier(r), 'the list does not hold the question row 1 presses').toEqual([])
  expect(await labels(ui)).toEqual(['› D'])
  s.rows = [Q('C'), answer('a0'), ...s.rows] // an older question the first read did not see
  await reopen(ui)
  expect(lastEarlier(r)).toEqual(entries('C'))
  expect(await labels(ui)).toEqual(['› D', '› C'])
  await ui.unmount()
})

// --- V12 to V13: what counts as the wake text ---

test('V12 a multi-line question whose first line is the wake text, and the wake text with two spaces: neither is listed or typed as a question', async ($, on) => {
  const multi = question(`${WAKE_TEXT}\nand then the tests`, 'uM')
  const spaced = question('продолжай  автономно', 'uS')
  const rows = [Q('A'), answer('a1'), multi, spaced, answer('a2')]
  expect(typedQuestions(rows)).toEqual([entry('A')])
  const s = session(on, rows)
  const r = recent(on)
  await start($)
  expect(valueOf(s)).toEqual({ uuid: 'uA', text: 'A' })
  const before = [s.writes.length, r.writes.length]
  await typed($, `${WAKE_TEXT}\nand then the tests`)
  await typed($, 'продолжай  автономно')
  expect([s.writes.length, r.writes.length], 'typing them writes nothing').toEqual(before)
})

test('V13 (absence) a question that only contains the wake words is a normal question: listed and typed', async ($, on) => {
  const text = 'продолжай автономно, но сначала тесты'
  expect(typedQuestions([Q('A'), question(text, 'uT')])).toEqual([{ uuid: 'uT', text }, entry('A')])
  const s = session(on)
  const r = recent(on)
  await start($)
  await asked($, s, 'A')
  s.rows = [...s.rows, question(text, 'uT')]
  await typed($, text)
  expect(valueOf(s)).toEqual({ uuid: 'uT', text })
  expect(uuids(lastEarlier(r))).toEqual(['uA'])
})

test('V14 a refused read of earlierQuestions does not stop the session-start restore: lastQuestion becomes D', async ($, on) => {
  const s = session(on, [Q('D'), answer('a1'), WAKE_ROW(), answer('a2')])
  s.seed = WAKE_VALUE
  on('state.get', EARLIER_KEY, () => ({ deny: 'refused' }))
  await start($)
  expect(valueOf(s)).toEqual({ uuid: 'uD', text: 'D' })
})
