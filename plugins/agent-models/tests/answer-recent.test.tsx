import { expect, test } from 'claude-code/testing'
import type { UiScrollArgs, UiScrollResult } from 'claude-code'

import * as answerMod from '../hooks/answer'
import { RESTORE_ROWS } from '../hooks/answer'
import { runPress } from '../hooks/pins'
import type { ScrollPress } from '../hooks/pins'
import { WAKE_TEXT } from '../hooks/wake'
import { band, start } from './account-fixtures'
import { answer, COMPOSER, gate, held, KEY, question, session, spin, SUMMARY, toolRow, typed, valueOf } from './answer-fixtures'
import { ask, entries, entry, heldEarlier, labels, lastEarlier, listKeys, opened, Q, recent, uuidOf, uuids } from './answer-recent-fixtures'
import type { Entry } from './answer-recent-fixtures'
import { A, B, pin, seededList, seededPins, SCROLL_REJECTED } from './pins-fixtures'

// The last answer list of 1.8.0: the last three questions (newest first), a separator, then the pins. `earlierQuestions` keeps the
// questions before the last one (newest first, at most three); it is rebuilt at each settle and at each list open. The harness cannot
// see where a transcript scroll goes (a rejected scroll is a toast), so the target of rows 2 and 3 is tested on `earlierPress`.

const SEPARATOR = 'answer-separator'
const earlierKey = (name: string): string => `answer-earlier-${uuidOf(name)}`
const asked = async ($: Parameters<typeof ask>[0], s: Parameters<typeof ask>[1], ...names: string[]): Promise<void> => {
  for (const name of names) await ask($, s, name)
}
const end = ($: Parameters<typeof ask>[0]) => $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
// `earlierPress` is new in 1.8.0: read off the module, so that against 1.7.0 the test fails by itself and not the whole file.
const earlierPress = (e: Entry): ScrollPress | undefined => {
  const fn: unknown = Reflect.get(answerMod, 'earlierPress')
  return typeof fn === 'function' ? fn(e) : undefined
}

// --- L1 to L4: what the list draws ---

test('L1 three questions A, B, C: the list is C, B, A, newest first; a press on row 2 or 3 scrolls to its own uuid before the first await', async ($, on) => {
  const s = session(on)
  const r = recent(on)
  await start($)
  await asked($, s, 'A', 'B', 'C')
  expect(await heldEarlier($, r), 'kept by the settles, before any list open').toEqual(entries('B', 'A'))
  const ui = await opened($)
  expect(await listKeys(ui)).toEqual(['answer-last', earlierKey('B'), earlierKey('A')])
  expect(await labels(ui)).toEqual(['› C', '› B', '› A'])
  await ui.press({ key: earlierKey('B') })
  await spin()
  expect(s.toasts, 'the press reached the scroll (the harness rejects every scroll), under its own heading').toEqual([`earlier question: ${SCROLL_REJECTED}`])
  for (const name of ['B', 'A']) {
    const press = earlierPress(entry(name))
    expect(press, 'the target of the row is the question\'s uuid').toEqual({ label: 'earlier question', id: uuidOf(name) })
    if (press === undefined) continue
    const scrolls: UiScrollArgs[] = []
    const scroll = (args: UiScrollArgs): Promise<UiScrollResult> => {
      scrolls.push(args)
      return Promise.resolve({})
    }
    const pressing = runPress(scroll, () => undefined, press)
    expect(scrolls, 'the scroll is called before the press yields').toEqual([{ to: { requestId: uuidOf(name) }, block: 'start' }])
    await pressing
  }
  await ui.unmount()
})

test('L2 four questions: only the newest three are drawn (D, C, B); earlierQuestions holds at most three', async ($, on) => {
  const s = session(on)
  const r = recent(on)
  await start($)
  await asked($, s, 'A', 'B', 'C', 'D')
  expect(uuids(lastEarlier(r))).toEqual(['uC', 'uB', 'uA'])
  const ui = await opened($)
  expect(await labels(ui)).toEqual(['› D', '› C', '› B'])
  await ask($, s, 'E')
  expect(uuids(lastEarlier(r)), 'at most three: A is gone').toEqual(['uD', 'uC', 'uB'])
  await ui.redraw()
  expect(await labels(ui)).toEqual(['› E', '› D', '› C'])
  await ui.unmount()
})

test('L3 one question: one row and no empty rows; with no pins there is no separator', async ($, on) => {
  const s = session(on)
  const r = recent(on)
  await start($)
  await asked($, s, 'A')
  const ui = await opened($)
  expect(await listKeys(ui)).toEqual(['answer-last'])
  expect(await labels(ui)).toEqual(['› A'])
  expect(uuids(lastEarlier(r)) ?? [], 'nothing earlier to keep').toEqual([])
  await ui.unmount()
})

test('L4 with pins: the separator is drawn once, between the questions and the pins; with no question: › no question yet, the separator, the pins', async ($, on) => {
  const s = session(on)
  recent(on)
  seededPins(on, [pin(A, 'first pinned answer'), pin(B, 'second pinned answer')])
  await start($)
  await asked($, s, 'A', 'B')
  const ui = await opened($)
  expect(await listKeys(ui)).toEqual(['answer-last', earlierKey('A'), SEPARATOR, `pin-go-${A}`, `pin-go-${B}`])
  expect((await ui.findAll({ key: SEPARATOR })).length, 'drawn once').toBe(1)
  await ui.unmount()
})

test('L4b no question yet, with pins: the dim row, then the separator and the pins', async ($, on) => {
  session(on)
  recent(on)
  seededPins(on, [pin(A, 'first pinned answer')])
  await start($)
  const ui = await opened($)
  expect((await ui.find({ type: 'Text', text: '› no question yet' }))?.props.dimColor).toBe(true)
  expect(await listKeys(ui)).toEqual([SEPARATOR, `pin-go-${A}`])
  await ui.unmount()
})

// --- L5 to L6: pending, and what is not a question ---

test('L5 a pending question D: row 1 is C (sending…) and presses C, rows 2 and 3 are B and A (C is not drawn twice); after D settles: D, C, B', async ($, on) => {
  const s = session(on)
  recent(on)
  await start($)
  await asked($, s, 'A', 'B', 'C')
  const ui = await opened($)
  await typed($, 'D') // not in the transcript yet
  await ui.redraw()
  expect(valueOf(s)).toEqual({ pending: 'D', previous: 'uC', previousText: 'C' })
  expect(await listKeys(ui)).toEqual(['answer-last', earlierKey('B'), earlierKey('A')])
  expect(await labels(ui)).toEqual(['› C (sending…)', '› B', '› A'])
  s.rows = [...s.rows, Q('D')]
  await $.turn.start({ text: 'D', turnId: 't2' })
  await spin()
  await ui.redraw()
  expect(await labels(ui)).toEqual(['› D', '› C', '› B'])
  await ui.unmount()
})

test('L6 a plugin prompt (the wake) and a slash command change nothing in the list', async ($, on) => {
  const s = session(on)
  const r = recent(on)
  await start($)
  await asked($, s, 'A', 'B')
  const before = [s.writes.length, r.writes.length]
  s.rows = [...s.rows, question(WAKE_TEXT, 'uW')] // the wake is sent asUser: its transcript row carries no origin
  await typed($, WAKE_TEXT, { kind: 'plugin', name: 'agent-models' })
  await typed($, '/compact', COMPOSER, { command: { name: 'compact', args: '' } })
  expect([s.writes.length, r.writes.length]).toEqual(before)
  const ui = await opened($)
  expect(await labels(ui)).toEqual(['› B', '› A'])
  await ui.unmount()
})

test('L6b a wake row in the transcript is skipped by the session start restore', async ($, on) => {
  const s = session(on, [Q('A'), answer('a1'), Q('B'), answer('a2'), Q('C'), answer('a3'), question(WAKE_TEXT, 'uW'), answer('a4'), question(WAKE_TEXT, 'uW2')])
  const r = recent(on)
  await start($)
  expect(valueOf(s)).toEqual({ uuid: 'uC', text: 'C' })
  expect(lastEarlier(r)).toEqual(entries('B', 'A'))
})

test('L6c a wake row in the transcript is skipped by the settle rebuild', async ($, on) => {
  const s = session(on, [Q('A'), answer('a1'), Q('B'), answer('a2'), question(WAKE_TEXT, 'uW'), answer('a3')])
  const r = recent(on)
  await start($)
  await ask($, s, 'C')
  expect(valueOf(s)).toEqual({ uuid: 'uC', text: 'C' })
  expect(lastEarlier(r), 'B and A, not the wake').toEqual(entries('B', 'A'))
})

test('L6d a wake row in the transcript is skipped by the list-open rebuild', async ($, on) => {
  const s = session(on, [Q('A'), answer('a1'), Q('B'), answer('a2'), question(WAKE_TEXT, 'uW'), answer('a3'), Q('C')])
  s.seed = { uuid: 'uC', text: 'C' }
  recent(on)
  const ui = await opened($)
  expect(await labels(ui)).toEqual(['› C', '› B', '› A'])
  await ui.unmount()
})

// --- L7 to L8: the session start, the session end, an older state ---

test('L7 a session start with no value restores the newest four questions (summary, peer and tool rows skipped), the earlier ones written first; a reload keeps them', async ($, on) => {
  const s = session(on, [
    Q('Q1'), answer('a1'), Q('Q2'), answer('a2'), question(SUMMARY, 'uS'), question('<teammate-message from="x">hi</teammate-message>', 'uP'),
    Q('Q3'), toolRow('t1'), Q('Q4'), answer('a4'), Q('Q5'), answer('a5'),
  ])
  const r = recent(on)
  await start($)
  expect(valueOf(s)).toEqual({ uuid: 'uQ5', text: 'Q5' })
  expect(uuids(lastEarlier(r))).toEqual(['uQ4', 'uQ3', 'uQ2'])
  expect(r.log, 'the earlier questions first, then the last one').toEqual(['earlierQuestions', 'lastQuestion'])
  expect(s.reads).toEqual([{ last: RESTORE_ROWS }])
  const writes = [s.writes.length, r.writes.length]
  await start($)
  expect([s.writes.length, r.writes.length], 'a reload with values keeps them').toEqual(writes)
})

test('L7b fewer than four questions in a full 200-row read: the read goes to the engine cap', async ($, on) => {
  const s = session(on, [Q('Q1'), Q('Q2'), ...Array.from({ length: 120 }, (_, i) => answer(`a${i}`)), Q('Q3'), Q('Q4'), ...Array.from({ length: 100 }, (_, i) => answer(`b${i}`))])
  const r = recent(on)
  await start($)
  expect(valueOf(s)).toEqual({ uuid: 'uQ4', text: 'Q4' })
  expect(uuids(lastEarlier(r))).toEqual(['uQ3', 'uQ2', 'uQ1'])
  expect(s.reads).toEqual([{ last: RESTORE_ROWS }, { last: 4096 }])
})

test('L8 session.end clears both values', async ($, on) => {
  const s = session(on)
  const r = recent(on)
  await start($)
  await asked($, s, 'A', 'B')
  expect(uuids(lastEarlier(r))).toEqual(['uA'])
  await end($)
  await spin()
  expect(valueOf(s)).toBeNull()
  expect(lastEarlier(r)).toEqual([])
  expect(await held($, s)).toBeNull()
})

test('L8b a state from before 1.8.0 (no earlierQuestions) draws the one-row list until a list open fills it', async ($, on) => {
  const s = session(on, [Q('A'), answer('a1'), Q('B'), answer('a2')])
  s.seed = { uuid: 'uB', text: 'B' }
  recent(on)
  seededList(on, true) // the list is stored open: the first draw is a draw of the 1.7.0 state
  const ui = await band($)
  expect(await labels(ui)).toEqual(['› B'])
  expect(await listKeys(ui)).toEqual(['answer-last'])
  await ui.press({ key: 'last-answer' }) // closes
  await ui.press({ key: 'last-answer' }) // opens: the rebuild
  await spin()
  await ui.redraw()
  expect(await labels(ui)).toEqual(['› B', '› A'])
  await ui.unmount()
})

// --- L9 to L11: the same words, quick submits, an upgrade ---

test('L9 the same question typed three times: three rows with three different uuids; a uuid is never listed twice', async ($, on) => {
  const s = session(on)
  const r = recent(on)
  await start($)
  for (const id of ['x1', 'x2', 'x3']) {
    s.rows = [...s.rows, question('Q', id)]
    await typed($, 'Q')
    s.rows = [...s.rows, answer(`a-${id}`)]
  }
  expect(valueOf(s)).toEqual({ uuid: 'x3', text: 'Q' })
  expect(uuids(lastEarlier(r))).toEqual(['x2', 'x1'])
  const ui = await opened($)
  expect(await listKeys(ui)).toEqual(['answer-last', 'answer-earlier-x2', 'answer-earlier-x1'])
  expect(await labels(ui)).toEqual(['› Q', '› Q', '› Q'])
  await ui.unmount()
})

test('L10 two quick submits D then E before D settles: once both are in the transcript and E settles, the list is E, D, C', async ($, on) => {
  const s = session(on)
  const r = recent(on)
  await start($)
  await asked($, s, 'A', 'B', 'C')
  await typed($, 'D')
  await typed($, 'E')
  expect(valueOf(s)).toEqual({ pending: 'E', previous: 'uC', previousText: 'C' })
  s.rows = [...s.rows, Q('D'), Q('E')]
  await $.turn.start({ text: 'D', turnId: 't2' })
  await spin()
  expect(valueOf(s)).toEqual({ uuid: 'uE', text: 'E' })
  expect(uuids(lastEarlier(r))).toEqual(['uD', 'uC', 'uB'])
  const ui = await opened($)
  expect(await labels(ui)).toEqual(['› E', '› D', '› C'])
  await ui.unmount()
})

test('L11 a 1.7.0 state (a settled lastQuestion, no earlierQuestions) and four questions: a session start fills the three older ones and keeps lastQuestion', async ($, on) => {
  const s = session(on, [Q('A'), answer('a1'), Q('B'), answer('a2'), Q('C'), answer('a3'), Q('D'), answer('a4')])
  s.seed = { uuid: 'uD', text: 'D' }
  const r = recent(on)
  await start($)
  expect(lastEarlier(r)).toEqual(entries('C', 'B', 'A'))
  expect(s.writes, 'lastQuestion is not written').toEqual([])
})

test('L11b the same state: a list open fills the three older ones and keeps lastQuestion', async ($, on) => {
  const s = session(on, [Q('A'), answer('a1'), Q('B'), answer('a2'), Q('C'), answer('a3'), Q('D'), answer('a4')])
  s.seed = { uuid: 'uD', text: 'D' }
  const r = recent(on)
  const ui = await opened($) // no session start: the open is what fills it
  expect(await labels(ui)).toEqual(['› D', '› C', '› B'])
  expect(lastEarlier(r)).toEqual(entries('C', 'B', 'A'))
  expect(s.writes, 'lastQuestion is not written').toEqual([])
  await ui.unmount()
})

// --- L12 to L15: races ---

test('L12 a newer submit between the two writes of a settle: no question is lost', async ($, on) => {
  const s = session(on)
  const r = recent(on)
  const g = gate()
  let isHeld = false
  on('state.set', KEY, async (_, e, next) => {
    if (!isHeld && e.value !== null && 'uuid' in e.value && e.value.uuid === 'uD') {
      isHeld = true
      await g.wait // D's own write of lastQuestion waits; its earlierQuestions write has landed
    }
    return next(e)
  })
  await start($)
  await asked($, s, 'A', 'B', 'C')
  s.rows = [...s.rows, Q('D')]
  await typed($, 'D')
  expect(uuids(lastEarlier(r)), 'the earlier questions of D are written first').toEqual(['uC', 'uB', 'uA'])
  await ask($, s, 'E') // E is typed while D's last write waits
  g.release()
  await spin()
  expect(await held($, s)).toEqual({ uuid: 'uE', text: 'E' })
  expect(uuids(lastEarlier(r))).toEqual(['uD', 'uC', 'uB'])
  const ui = await opened($)
  expect(await labels(ui)).toEqual(['› E', '› D', '› C'])
  await ui.unmount()
})

test('L12b the earlierQuestions write of an older settle lands after a newer settle: it does not take the newer list back', async ($, on) => {
  const s = session(on)
  const g = gate()
  let isHeld = false
  const r = recent(on, {
    meddle: {
      hold: async write => {
        if (!isHeld && write[0]?.uuid === 'uC') {
          isHeld = true
          await g.wait // D's earlier write (C, B, A) waits
        }
      },
    },
  })
  await start($)
  await asked($, s, 'A', 'B', 'C')
  s.rows = [...s.rows, Q('D')]
  await typed($, 'D') // held at its earlier write
  await ask($, s, 'E') // E settles completely
  expect(await held($, s)).toEqual({ uuid: 'uE', text: 'E' })
  g.release()
  await spin()
  expect(await held($, s)).toEqual({ uuid: 'uE', text: 'E' })
  expect(await heldEarlier($, r), 'what the engine holds, before any list open rebuilds it').toEqual(entries('D', 'C', 'B'))
  const ui = await opened($)
  expect(await labels(ui), 'D is not lost').toEqual(['› E', '› D', '› C'])
  await ui.unmount()
})

test('L12c a session end while a settle\'s lastQuestion write waits: nothing is written after it', async ($, on) => {
  const s = session(on)
  const r = recent(on)
  const g = gate()
  let isHeld = false
  on('state.set', KEY, async (_, e, next) => {
    if (!isHeld && e.value !== null && 'uuid' in e.value && e.value.uuid === 'uD') {
      isHeld = true
      await g.wait
    }
    return next(e)
  })
  await start($)
  await asked($, s, 'A', 'B', 'C')
  s.rows = [...s.rows, Q('D')]
  await typed($, 'D')
  await end($)
  await spin()
  expect(valueOf(s)).toBeNull()
  expect(lastEarlier(r)).toEqual([])
  const after = [s.writes.length, r.writes.length]
  g.release()
  await spin()
  expect(s.writes.slice(after[0]).every(w => w === null), 'only null after the end').toBe(true)
  expect(r.writes.slice(after[1]).every(w => w.length === 0), 'only empty lists after the end').toBe(true)
  expect(valueOf(s)).toBeNull()
  expect(lastEarlier(r)).toEqual([])
})

test('L12d a session end while a settle\'s earlierQuestions write waits: the list stays empty', async ($, on) => {
  const s = session(on)
  const g = gate()
  let isHeld = false
  const r = recent(on, {
    meddle: {
      hold: async write => {
        if (!isHeld && write[0]?.uuid === 'uC') {
          isHeld = true
          await g.wait
        }
      },
    },
  })
  await start($)
  await asked($, s, 'A', 'B', 'C')
  s.rows = [...s.rows, Q('D')]
  await typed($, 'D')
  await end($)
  await spin()
  expect(lastEarlier(r)).toEqual([])
  const after = [s.writes.length, r.writes.length]
  g.release()
  await spin()
  expect(s.writes.slice(after[0]).every(w => w === null), 'only null after the end').toBe(true)
  expect(r.writes.slice(after[1]).every(w => w.length === 0), 'only empty lists after the end').toBe(true)
  expect(await held($, s)).toBeNull()
})

test('L13 a long turn: an earlier question more than 50 rows back stays in the list after the next settle', async ($, on) => {
  const s = session(on)
  const r = recent(on)
  await start($)
  await asked($, s, 'A', 'B', 'C')
  s.rows = [...s.rows, ...Array.from({ length: 60 }, (_, i) => answer(`long${i}`))]
  await ask($, s, 'D') // the lookup reads the newest 50 rows: B and A are past them
  expect(valueOf(s)).toEqual({ uuid: 'uD', text: 'D' })
  expect(uuids(lastEarlier(r))).toEqual(['uC', 'uB', 'uA'])
  const ui = await opened($)
  expect(await labels(ui)).toEqual(['› D', '› C', '› B'])
  await ui.unmount()
})

test('L14 a draw between the two writes of a settle shows no question twice and none missing', async ($, on) => {
  const s = session(on)
  recent(on)
  const g = gate()
  let isHeld = false
  on('state.set', KEY, async (_, e, next) => {
    if (!isHeld && e.value !== null && 'uuid' in e.value && e.value.uuid === 'uD') {
      isHeld = true
      await g.wait
    }
    return next(e)
  })
  await start($)
  await asked($, s, 'A', 'B', 'C')
  const ui = await opened($)
  s.rows = [...s.rows, Q('D')]
  await typed($, 'D') // earlierQuestions is written (C, B, A); lastQuestion still says pending
  await ui.redraw()
  expect(s.read, 'what the engine holds').toEqual({ pending: 'D', previous: 'uC', previousText: 'C' })
  expect(await labels(ui), 'C once, B, A').toEqual(['› C (sending…)', '› B', '› A'])
  g.release()
  await spin()
  await ui.redraw()
  expect(await labels(ui)).toEqual(['› D', '› C', '› B'])
  await ui.unmount()
})

test('L15 the change function runs again on a version miss: the written list comes from the run that landed', async ($, on) => {
  const s = session(on)
  const other: Entry[] = [{ uuid: 'uZ', text: 'Z' }]
  let misses = 0
  const r = recent(on, {
    meddle: {
      miss: () => {
        if (misses > 0) return undefined
        misses = 1
        return other // another write landed between the read and this write: this one misses and the change function runs again on it
      },
    },
  })
  await start($)
  await asked($, s, 'A', 'B')
  expect(misses).toBe(1)
  expect(uuids(lastEarlier(r)), 'the list of the run that landed: it holds what the other write left (Z)').toEqual(['uA', 'uZ'])
})
