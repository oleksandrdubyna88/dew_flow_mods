import { expect, test } from 'claude-code/testing'
import type { PromptOrigin, UiScrollArgs, UiScrollResult } from 'claude-code'

import * as answerMod from '../hooks/answer'
import type { ScrollPress } from '../hooks/pins'
import { runPress } from '../hooks/pins'
import { WAKE_TEXT } from '../hooks/wake'
import {
  band, endSession, gate, ids, labels, listKeys, opened, PATH, pendingOf, recentOf, script, settle, start, stored, tickOnce, turnComplete, turnStart, typedIn, world, writesOf,
} from './asked-fixtures'
import type { World } from './asked-fixtures'
import { A, pin, SCROLL_REJECTED, seededPins } from './pins-fixtures'

// The last answer list of 1.9.0 (plan todo/PLAN_agent_models_1_9_0.md, A5-A13, A15, A17, A20): the rows, the pending row of a question the
// transcript does not hold yet, the refresh points, the refusals, the session end, a reload. The questions come from the file (see
// asked-read.test.tsx); here the file is built with `script` and grows between the steps, as a real transcript does.
// Tests that assert an absence also assert what IS drawn or written, so none passes against 1.8.1 by doing nothing: A8, A10a, A11b.

const sending = (text: string): string => `› ${text} (sending…)`
const MARK = 'last answer: not in the transcript yet'

// `questionPress` is new in 1.9.0: read off the module, so that against 1.8.1 the test fails by itself and not the whole file.
const questionPress = (id: string, isNewest: boolean): ScrollPress | undefined => {
  const fn: unknown = Reflect.get(answerMod, 'questionPress')
  return typeof fn === 'function' ? fn(id, isNewest) : undefined
}

// How many turns of the microtask queue pass between `fire` and the toast of the engine's rejected scroll (-1: none came). The harness cannot see
// where a transcript scroll goes; a press that calls the scroll at once reaches the toast in as many turns as another press that does, and an
// `await` ahead of the scroll adds a turn.
const turnsToToast = async (w: World, fire: () => unknown): Promise<number> => {
  const before = w.toasts.length
  fire()
  for (let i = 0; i < 1000; i += 1) {
    if (w.toasts.length > before) return i
    await Promise.resolve()
  }
  return -1
}

// --- A5: the list ---

test('A5 idle A, queued B, idle C: the list is C, B, A; each press scrolls to its line\'s uuid before the first await', async ($, on) => {
  const w = world(on)
  const f = script(w)
  seededPins(on, [pin(A, 'a pinned answer')])
  f.typed('qA', 'alpha question')
  f.assistant('a1')
  f.queued('qB', 'bravo question')
  f.assistant('a2')
  f.typed('qC', 'charlie question')
  f.assistant('a3')
  await start($)
  const ui = await opened($)
  expect(await listKeys(ui)).toEqual(['answer-q-qC', 'answer-q-qB', 'answer-q-qA', 'answer-separator', `pin-go-${A}`])
  expect(await labels(ui)).toEqual(['› charlie question', '› bravo question', '› alpha question'])
  const turnsOf = async (key: string): Promise<number> => {
    const turns = await turnsToToast(w, () => void ui.press({ key })) // started and not awaited: `ui.press` itself waits for the handler to settle
    await settle()
    return turns
  }
  const base = await turnsOf(`pin-go-${A}`) // a press known to scroll at once (pins.tsx)
  expect(base).toBeGreaterThanOrEqual(0)
  for (const id of ['qC', 'qB', 'qA']) {
    expect(await turnsOf(`answer-q-${id}`), `the row of ${id} scrolls before it yields`).toBe(base)
  }
  expect(w.toasts, 'every press reached the scroll, the newest row under its own heading').toEqual([
    `pin: ${SCROLL_REJECTED}`, `last answer: ${SCROLL_REJECTED}`, `earlier question: ${SCROLL_REJECTED}`, `earlier question: ${SCROLL_REJECTED}`,
  ])
  await ui.unmount()
})

test('A5a the press of a question row targets the uuid of its line, never its text, and scrolls before the press yields', async () => {
  for (const [id, isNewest, label] of [['qC', true, 'last answer'], ['qB', false, 'earlier question']] as const) {
    const press = questionPress(id, isNewest)
    expect(press).toEqual({ label, id })
    if (press === undefined) continue
    const scrolls: UiScrollArgs[] = []
    const scroll = (args: UiScrollArgs): Promise<UiScrollResult> => {
      scrolls.push(args)
      return Promise.resolve({})
    }
    const pressing = runPress(scroll, () => undefined, press)
    expect(scrolls, 'called before the press yields').toEqual([{ to: { requestId: id }, block: 'start' }])
    await pressing
  }
})

test('A5b a refused scroll of a question row is a toast under its own heading, and nothing throws', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha question')
  f.typed('qB', 'bravo question')
  await start($)
  const ui = await opened($)
  await ui.press({ key: 'answer-q-qB' })
  await ui.press({ key: 'answer-q-qA' })
  await settle()
  expect(w.toasts).toEqual([`last answer: ${SCROLL_REJECTED}`, `earlier question: ${SCROLL_REJECTED}`])
  await ui.unmount()
})

test('A5c four questions: only three rows; with a pending one it is the first of the three (D pending, C, B)', async ($, on) => {
  const w = world(on)
  const f = script(w)
  for (const name of ['A', 'B', 'C']) f.typed(`q${name}`, name)
  await start($)
  await typedIn($, 'D')
  const ui = await opened($)
  expect(await labels(ui)).toEqual([sending('D'), '› C', '› B'])
  await ui.unmount()
})

test('A5d with no question: the dim row; with pins, then the separator and the pins; with one question and no pins no separator', async ($, on) => {
  const w = world(on)
  const f = script(w)
  seededPins(on, [pin(A, 'a pinned answer')])
  await start($)
  const ui = await opened($)
  expect(await listKeys(ui)).toEqual(['answer-separator', `pin-go-${A}`])
  expect(await ui.find({ type: 'Text', text: '› no question yet' })).toBeDefined()
  expect(await labels(ui)).toEqual([])
  f.typed('qA', 'alpha')
  await turnStart($)
  await ui.redraw()
  expect(await labels(ui)).toEqual(['› alpha'])
  expect(await ui.find({ type: 'Text', text: '› no question yet' })).toBeUndefined()
  await ui.unmount()
})

// --- A6, A7: a submit and its pending row ---

test('A6 a submit adds a dim pending row; its press toasts; the next refresh that finds a question after its `from` removes it and lists the question', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha question')
  f.assistant('a1')
  await start($)
  const from = w.size()
  await typedIn($, 'bravo, typed while it works')
  expect(pendingOf(w)).toEqual([{ text: 'bravo, typed while it works', from, turns: 0 }])
  const ui = await opened($)
  expect(await labels(ui)).toEqual([sending('bravo, typed while it works'), '› alpha question'])
  const row = (await ui.findAll({ type: 'Button' })).find(node => node.key?.startsWith('answer-pending-') === true)
  expect(row?.props.dimColor, 'drawn dim').toBe(true)
  await ui.press({ key: row?.key ?? 'none' })
  await settle()
  expect(w.toasts, 'the toast alone: a scroll would add the harness\'s rejection').toEqual([MARK])
    f.assistant('a2')
  f.queued('qB', 'bravo, typed while it works')
  await turnStart($)
  expect(pendingOf(w)).toEqual([])
  expect(ids(w)).toEqual(['qB', 'qA'])
  await ui.redraw()
  expect(await labels(ui)).toEqual(['› bravo, typed while it works', '› alpha question'])
  await ui.unmount()
})

test('A6b a question typed while idle: pending until its turn begins, then its own line; its `from` is taken before the engine stores the line', async ($, on) => {
  const w = world(on)
  const f = script(w)
  await start($)
  w.onSubmit = () => void f.typed('qA', 'typed when idle') // the engine stores the idle prompt's line while the hooks of the submit are still working
  await typedIn($, 'typed when idle')
  expect(pendingOf(w), 'the offset is the file length before the line').toEqual([{ text: 'typed when idle', from: 0, turns: 0 }])
  await turnStart($)
  expect(pendingOf(w)).toEqual([])
  expect(ids(w)).toEqual(['qA'])
})

test('A6c a bridge question is pending like a composer one; a refresh that finds nothing new keeps it', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  await start($)
  await typedIn($, 'from the phone', { kind: 'bridge' })
  expect(pendingOf(w).map(p => p.text)).toEqual(['from the phone'])
  await turnStart($)
  expect(pendingOf(w).map(p => p.text), 'no line after its from: still pending').toEqual(['from the phone'])
  expect(ids(w)).toEqual(['qA'])
})

test('A7 two quick submits with the SAME text: two pending rows, which settle in order on two different ids', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  await start($)
  await typedIn($, 'same words')
  await typedIn($, 'same words')
  expect(pendingOf(w)).toHaveLength(2)
  const ui = await opened($)
  expect(await labels(ui)).toEqual([sending('same words'), sending('same words'), '› alpha'])
  const keys = await listKeys(ui)
  expect(new Set(keys).size, 'the two rows have two keys').toBe(keys.length)
  f.queued('s1', 'same words')
  await turnStart($)
  expect(pendingOf(w)).toHaveLength(1)
  expect(ids(w)).toEqual(['s1', 'qA'])
  f.queued('s2', 'same words')
  await turnStart($)
  expect(pendingOf(w)).toEqual([])
  expect(ids(w)).toEqual(['s2', 's1', 'qA'])
  await ui.unmount()
})

test('A7d one line settles ONE entry: the line of A lands after the from of B; the next refresh does not count it again for B', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('q0', 'zero')
  await start($)
  await typedIn($, 'A')
  f.big('g1', 2000) // the file grows while Claude works
  await typedIn($, 'B')
  expect(pendingOf(w).map(p => p.text)).toEqual(['A', 'B'])
  f.queued('qA', 'A') // its line ends after B's from
  await turnStart($)
  expect(pendingOf(w).map(p => p.text)).toEqual(['B'])
  expect(pendingOf(w)[0]?.from, 'B starts after the line that settled A').toBe(w.size())
  await turnStart($)
  expect(pendingOf(w).map(p => p.text), 'the line of A is not counted again').toEqual(['B'])
  f.queued('qB', 'B')
  await turnStart($)
  expect(pendingOf(w)).toEqual([])
  expect(ids(w)).toEqual(['qB', 'qA', 'q0'])
})

test('A7b non-person submits (a notification, a peer, a plugin, a meta prompt, a slash command, a dropped prompt) add no pending row and write nothing', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  await start($)
  const before = w.writes.length
  w.drop = 'dropme'
  const others: [string, PromptOrigin, Parameters<typeof typedIn>[3]][] = [
    ['note', { kind: 'task-notification' }, {}],
    ['peer', { kind: 'peer' }, {}],
    ['plug', { kind: 'plugin', name: 'tasks' }, {}],
    ['meta', { kind: 'composer' }, { isMeta: true }],
    ['/compact', { kind: 'composer' }, { command: { name: 'compact', args: '' } }],
    ['dropme', { kind: 'composer' }, {}],
  ]
  for (const [text, origin, extra] of others) await typedIn($, text, origin, extra)
  expect(w.writes).toHaveLength(before)
  expect(pendingOf(w)).toEqual([])
  expect(ids(w)).toEqual(['qA'])
})

test('A7c at most eight pending rows are kept, oldest first', async ($, on) => {
  const w = world(on)
  await start($)
  for (let i = 0; i < 10; i += 1) await typedIn($, `question ${i}`)
  expect(pendingOf(w).map(p => p.text)).toEqual(Array.from({ length: 8 }, (_, i) => `question ${i + 2}`))
})

// --- A8: the wake text ---

test('A8 the wake text, typed, sent by the wake or found in the file, is never listed and never pending; words that only contain it are a question', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  f.sent('w1', WAKE_TEXT)
  f.typed('qW', WAKE_TEXT)
  await start($)
  expect(ids(w)).toEqual(['qA'])
  const before = w.writes.length
  await typedIn($, WAKE_TEXT)
  await typedIn($, WAKE_TEXT, { kind: 'bridge' })
  await typedIn($, 'продолжай  автономно') // two spaces: the list would draw the same text
  await typedIn($, `${WAKE_TEXT}\nand a second line`)
  await typedIn($, WAKE_TEXT, { kind: 'plugin', name: 'wake' }) // what the wake button's own send looks like to the hook
  expect(w.writes, 'nothing was written').toHaveLength(before)
  const ui = await opened($)
  expect(await labels(ui)).toEqual(['› alpha'])
  await typedIn($, `please ${WAKE_TEXT} when you can`)
  expect(pendingOf(w).map(p => p.text)).toEqual([`please ${WAKE_TEXT} when you can`])
  await ui.unmount()
})

// --- A9: the refresh points ---

test('A9a the refresh points: the list open, turn.start and turn.complete of the main loop, the session start; a subagent\'s turn never refreshes', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  const ui = await band($) // no session.start: nothing has read the file
  expect(w.reads).toHaveLength(0)
  await ui.press({ key: 'last-answer' })
  await settle()
  expect(ids(w), 'the list open refreshes').toEqual(['qA'])
  expect(w.reads).toHaveLength(1)
  f.typed('qB', 'bravo')
  await turnStart($, { agentId: 'sub-1' })
  await turnComplete($, { agentId: 'sub-1' })
  expect(ids(w), 'a subagent\'s turn.start and turn.complete never refresh').toEqual(['qA'])
  await turnStart($)
  expect(ids(w), 'turn.start').toEqual(['qB', 'qA'])
  f.typed('qC', 'charlie')
  await turnComplete($)
  expect(ids(w), 'turn.complete').toEqual(['qC', 'qB', 'qA'])
  f.typed('qD', 'delta')
  await start($)
  expect(ids(w), 'session start').toEqual(['qD', 'qC', 'qB'])
  await ui.unmount()
})

test('A9b the tick refreshes only while the list is open or something is pending, and only when the file grew', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  await start($)
  const stats = w.stats
  const reads = w.reads.length
  await tickOnce(w)
  await tickOnce(w)
  expect(w.stats, 'list closed, nothing pending: the tick looks at nothing').toBe(stats)
  f.typed('qB', 'bravo') // the file grows; nobody looks
  await tickOnce(w)
  expect(ids(w)).toEqual(['qA'])
  const ui = await opened($) // the open refreshes at once
  expect(ids(w)).toEqual(['qB', 'qA'])
  const open = { stats: w.stats, reads: w.reads.length }
  expect(open.reads).toBeGreaterThan(reads)
  await tickOnce(w)
  expect(w.stats, 'the list is open: the tick stats the file').toBeGreaterThan(open.stats)
  expect(w.reads, 'the file did not grow: no read').toHaveLength(open.reads)
  f.typed('qC', 'charlie')
  await tickOnce(w)
  expect(ids(w), 'it grew: a refresh').toEqual(['qC', 'qB', 'qA'])
  await ui.press({ key: 'last-answer' }) // closed again
  await settle()
  await typedIn($, 'ghost') // pending: the tick looks again
  const pendingStats = w.stats
  await tickOnce(w)
  expect(w.stats, 'something is pending: the tick stats the file').toBeGreaterThan(pendingStats)
  const pendingReads = w.reads.length
  f.typed('qD', 'ghost')
  await tickOnce(w)
  expect(w.reads.length).toBeGreaterThan(pendingReads)
  expect(pendingOf(w)).toEqual([])
  expect(ids(w)).toEqual(['qD', 'qC', 'qB'])
  await ui.unmount()
})

test('A9e the engine list is read for the fallback check at the list open, the session start and the turn events, not on the tick', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  await start($)
  const ui = await opened($)
  const reads = w.messageReads
  expect(reads).toBeGreaterThan(0)
  f.typed('qB', 'bravo')
  await tickOnce(w)
  await tickOnce(w)
  expect(ids(w), 'the tick did refresh').toEqual(['qB', 'qA'])
  expect(w.messageReads, 'and read no engine list').toBe(reads)
  f.typed('qC', 'charlie')
  await turnStart($)
  expect(w.messageReads).toBeGreaterThan(reads)
  await ui.unmount()
})

test('A9c one refresh at a time: a refresh asked while another reads makes no call; the next one after it works', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  const hold = gate()
  w.holdRead = hold.wait
  await start($) // its refresh waits at the read
  expect(w.reads).toHaveLength(1)
  const infos = w.infos
  await turnStart($)
  await turnComplete($)
  expect(w.infos, 'the asks while it ran were left at the guard').toBe(infos)
  hold.release()
  await settle()
  expect(ids(w)).toEqual(['qA'])
  f.typed('qB', 'bravo')
  await turnStart($)
  expect(ids(w), 'the guard is free again').toEqual(['qB', 'qA'])
})

test('A9d a submit while a refresh reads is not lost: its pending row stays after the refresh writes', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  const hold = gate()
  w.holdRead = hold.wait
  await start($)
  await typedIn($, 'typed during the read')
  expect(pendingOf(w).map(p => p.text)).toEqual(['typed during the read'])
  hold.release()
  await settle()
  expect(ids(w)).toEqual(['qA'])
  expect(pendingOf(w).map(p => p.text), 'the refresh did not take it back').toEqual(['typed during the read'])
})

// --- A10: refusals ---

test('A10a a refused session.info, stat or read changes nothing: no write, no toast; the next working refresh recovers', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  w.seeds.recent = { questions: [{ id: 'old', text: 'kept from before' }], size: 5 }
  w.isInfoRefused = true
  await start($)
  w.isInfoRefused = false
  w.isStatRefused = true
  await turnStart($)
  w.isStatRefused = false
  w.isReadRefused = true
  await turnStart($)
  await turnComplete($)
  expect(w.writes, 'nothing was written').toEqual([])
  expect(w.toasts).toEqual([])
  w.isReadRefused = false
  await turnStart($)
  expect(ids(w), 'recovered').toEqual(['qA'])
})

test('A10c a session that keeps no transcript file (an empty path) shows what the engine lists, with the one toast', async ($, on) => {
  const w = world(on)
  w.path = ''
  w.messages = [{ role: 'user', text: 'an invented question', toolUses: [], uuid: 'e1' }]
  await start($)
  expect(ids(w)).toEqual(['e1'])
  expect(w.toasts).toEqual(['last answer: transcript format not recognised — showing what the engine lists'])
  expect(w.stats, 'no file to look at').toBe(0)
})

test('A10d the engine list is broken too: nothing is written, nothing throws', async ($, on) => {
  const w = world(on)
  w.path = ''
  w.isMessagesBroken = true
  await start($)
  await turnStart($)
  await turnComplete($)
  expect(ids(w)).toEqual([])
  w.isMessagesBroken = false
  w.path = PATH // the session keeps its file again, and the next refresh reads it
  script(w).typed('qA', 'alpha')
  await turnStart($)
  expect(ids(w)).toEqual(['qA'])
})

test('A10e a refused write of pending breaks nothing and the row is not drawn; a refused write of recent leaves the list as it was', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  w.refusedKeys.add('pending')
  w.refusedKeys.add('recent')
  await start($)
  await typedIn($, 'bravo')
  await turnComplete($)
  expect(w.writes.length, 'the hooks did try to write').toBeGreaterThan(0)
  const ui = await opened($)
  expect(await labels(ui), 'every write was refused: the held values are still empty').toEqual([])
  w.refusedKeys.clear()
  await turnStart($)
  await ui.redraw()
  expect(await labels(ui), 'the writes go through again').toEqual(['› alpha'])
  await ui.unmount()
})

// --- A11: the session end ---

test('A11 the session end clears recent, pending and the atoms of 1.5.0-1.8.1', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  w.seeds.lastQuestion = { uuid: 'old', text: 'old' }
  w.seeds.earlierQuestions = [{ uuid: 'o2', text: 'older' }]
  await start($)
  await typedIn($, 'bravo')
  expect(ids(w)).toEqual(['qA'])
  expect(pendingOf(w)).toHaveLength(1)
  await endSession($)
  expect(stored(w, 'recent')).toBeNull()
  expect(stored(w, 'pending')).toEqual([])
  expect(stored(w, 'lastQuestion')).toBeNull()
  expect(stored(w, 'earlierQuestions')).toEqual([])
})

test('A11b a refresh still reading when the session ends writes nothing after the end', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  const hold = gate()
  w.holdRead = hold.wait
  await start($)
  await endSession($)
  const writes = w.writes.length
  hold.release()
  await settle()
  expect(w.writes, 'the late refresh is no writer').toHaveLength(writes)
  expect(stored(w, 'recent')).toBeNull()
  expect(w.reads).toHaveLength(1)
})

test('A11c a submit whose stat is still pending when the session ends adds no pending row afterwards', async ($, on) => {
  const w = world(on)
  await start($)
  const hold = gate()
  w.holdStat = hold.wait
  const submitting = $.prompt.submit({ text: 'typed at the end', wait: false, origin: { kind: 'composer' } })
  await settle()
  await endSession($)
  hold.release()
  await submitting
  await settle()
  expect(stored(w, 'pending')).toEqual([])
  expect(pendingOf(w)).toEqual([])
})

// --- A12, A13, A15 ---

test('A12 a state of 1.8.1 (lastQuestion and earlierQuestions set, no recent): the list draws from the first refresh, with none of the old values', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  f.typed('qB', 'bravo')
  w.seeds.lastQuestion = { uuid: 'old', text: 'an old question of 1.8.1' }
  w.seeds.earlierQuestions = [{ uuid: 'o2', text: 'older still' }]
  const ui = await opened($) // no session start: the list open is the first refresh
  expect(await labels(ui)).toEqual(['› bravo', '› alpha'])
  expect(w.writes.filter(x => x.key === 'lastQuestion' || x.key === 'earlierQuestions'), 'the old atoms are no longer written').toEqual([])
  await ui.unmount()
})

test('A13 a reload keeps recent and pending; the next refresh (a fresh module cache: the whole window) settles the pending one', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  const from = w.size()
  f.typed('qB', 'bravo')
  w.seeds.recent = { questions: [{ id: 'qA', text: 'alpha' }], size: from }
  w.seeds.pending = [{ text: 'bravo', from, turns: 0 }]
  w.isReadRefused = true
  await start($)
  expect(w.writes, 'a refresh that cannot read keeps what stands').toEqual([])
  expect(pendingOf(w)).toHaveLength(1)
  w.isReadRefused = false
  w.reads.length = 0
  await turnStart($)
  expect(w.reads, 'no cache after a reload: the whole window').toEqual([{ offset: 0, length: w.size() }])
  expect(pendingOf(w)).toEqual([])
  expect(ids(w)).toEqual(['qB', 'qA'])
})

test('A15 a question typed while Claude worked is listed again after a restart by the uuid of its line', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  f.assistant('a1')
  f.queued('qB', 'bravo, queued')
  f.assistant('a2')
  await start($) // a fresh session start over a file that already holds the queued line
  expect(ids(w)).toEqual(['qB', 'qA'])
  const ui = await opened($)
  expect((await listKeys(ui))[0]).toBe('answer-q-qB')
  await ui.unmount()
})

// --- A17, A20 ---

test('A17 a pending entry with no line is dropped at its second turn.complete; the next question settles the next entry, not the stuck one', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  await start($)
  await typedIn($, 'ghost: a prompt that never became a line')
  await turnComplete($, { agentId: 'sub-1' })
  expect(pendingOf(w).map(p => p.turns), 'a subagent\'s turn.complete does not count').toEqual([0])
  await turnComplete($)
  expect(pendingOf(w).map(p => p.turns)).toEqual([1])
  await turnComplete($)
  expect(pendingOf(w), 'dropped at the second').toEqual([])
  await typedIn($, 'a real question')
  f.typed('qR', 'a real question')
  await turnStart($)
  expect(pendingOf(w)).toEqual([])
  expect(ids(w)).toEqual(['qR', 'qA'])
})

test('A17b a turn end while a refresh is busy is not lost: the running or the next refresh counts it', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  const hold = gate()
  w.holdRead = hold.wait
  await start($) // its refresh waits at the read
  await typedIn($, 'ghost: a prompt that never became a line')
  await turnComplete($) // asked while the refresh runs
  hold.release()
  await settle()
  expect(pendingOf(w).map(p => p.turns), 'counted once').toEqual([1])
  await turnComplete($)
  expect(pendingOf(w), 'the second turn end drops it').toEqual([])
})

test('A20 a refused stat: with no recent no pending row is added; with a recent its size is the `from`', async ($, on) => {
  const w = world(on)
  w.isStatRefused = true
  await start($) // the session start's refresh cannot stat either: no recent
  await typedIn($, 'nowhere to put it')
  expect(w.writes.filter(x => x.key === 'pending')).toEqual([])
  expect(pendingOf(w)).toEqual([])
  w.seeds.recent = { questions: [], size: 77 }
  await typedIn($, 'with a size known')
  expect(pendingOf(w)).toEqual([{ text: 'with a size known', from: 77, turns: 0 }])
  expect(recentOf(w)).toEqual({ questions: [], size: 77 })
})

// the writes of one atom are made only when its value changes
test('A21 a refresh that finds nothing new writes nothing', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'alpha')
  await start($)
  const writes = w.writes.length
  await turnStart($)
  await turnComplete($)
  expect(w.writes).toHaveLength(writes)
  expect(writesOf(w, 'recent')).toHaveLength(1)
})
