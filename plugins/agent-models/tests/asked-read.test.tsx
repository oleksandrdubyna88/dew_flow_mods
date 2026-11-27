import { expect, test } from 'claude-code/testing'

import { ids, MIB, pendingOf, recentOf, script, settle, start, turnStart, typedIn, world, writesOf } from './asked-fixtures'
import type { World } from './asked-fixtures'

// The questions come from the transcript FILE (1.9.0, plan todo/PLAN_agent_models_1_9_0.md, A1-A4, A16, A18, A19): the live chain of
// the window read from the file's end, the one deeper read, the byte ends of the lines, the fallback. The file is built here from
// invented text in the shapes of the engine's own lines; the mod reads it through `session.info`, `fs.stat` and `fs.read`.
// Tests that assert an absence also assert what IS listed, so none passes against 1.8.1 by listing nothing: A3, A19b.

const FALLBACK_TOAST = 'last answer: transcript format not recognised — showing what the engine lists'
const textsOf = (w: World): string[] => recentOf(w)?.questions.map(q => q.text) ?? []

test('A1 typed and queued questions on the chain are listed newest first by the id of their own line; tool results, meta, summaries, slash commands, task notifications, peer messages, sent prompts and sidechain lines are not', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'first invented question')
  f.assistant('a1')
  f.toolResult('r1')
  f.queued('qB', 'second one, typed while it worked')
  f.assistant('a2')
  f.meta('m1', 'a meta prompt')
  f.summary('s1', 'This session is being continued from a previous conversation that ran out of context.')
  f.slash('c1', '/clear')
  f.notification('n1')
  f.peer('p1')
  f.peerWrapped('p2')
  f.sent('w1', 'продолжай автономно') // the wake's own line: no origin
  f.typed('qW', 'продолжай автономно') // the same words typed by the person
  f.typed('qC', 'third invented question')
  f.assistant('a3')
  f.side('x1', 'a sidechain line')
  await start($)
  expect(ids(w), 'newest first; the attachment line\'s own uuid, not its source_uuid').toEqual(['qC', 'qB', 'qA'])
  expect(textsOf(w)).toEqual(['third invented question', 'second one, typed while it worked', 'first invented question'])
  expect(recentOf(w)?.size, 'the file length the read saw').toBe(w.size())
})

test('A1b only the newest three are kept; a question that is empty once clean, or starts with a tag the person typed, is as the 1.8.1 list treated it', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('q1', 'one')
  f.typed('q2', 'two')
  f.typed('q3', '<div>mine</div> a tag the person typed')
  f.typed('q4', '<system-reminder>only a reminder</system-reminder>') // empty once clean: no question
  f.typed('q5', '   first line\n\nsecond line')
  await start($)
  expect(ids(w)).toEqual(['q5', 'q3', 'q2'])
  expect(textsOf(w)).toEqual(['first line', '<div>mine</div> a tag the person typed', 'two'])
})

test('A2 the walk stops at the last compact_boundary: no question from before it is listed, and no deeper read is made', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('o0', 'before the first compaction')
  f.boundary('b0')
  f.typed('o1', 'old one')
  f.assistant('oa1')
  f.typed('o2', 'old two')
  f.assistant('oa2')
  f.boundary('b1')
  f.summary('sm1', 'This session is being continued from a previous conversation that ran out of context.')
  f.assistant('pa1')
  f.typed('n1', 'new one')
  f.assistant('na1')
  f.queued('n2', 'new two, typed while it worked')
  f.assistant('na2')
  await start($)
  expect(ids(w)).toEqual(['n2', 'n1'])
  expect(w.reads, 'the whole file is in the window: one read').toHaveLength(1)
})

test('A2b a file whose last line is the compaction mark lists nothing', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('o1', 'old one')
  f.boundary('b1')
  await start($)
  expect(ids(w)).toEqual([])
  expect(w.toasts, 'a file the walk reads is not a format fault').toEqual([])
  expect(recentOf(w), 'the read was made: recent is written').toEqual({ questions: [], size: w.size() })
})

test('A3 a /rewind branch: questions on the abandoned branch are not listed, the live branch\'s are', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'kept question')
  f.assistant('aA')
  f.typed('qB', 'abandoned question')
  f.assistant('aB')
  f.at('aA') // the rewind: the next line hangs on the first answer
  f.typed('qB2', 'question on the live branch')
  f.assistant('aB2')
  await start($)
  expect(ids(w)).toEqual(['qB2', 'qA'])
})

test('A4a a walk that reaches the window start with fewer than three questions and no mark makes ONE deeper read of 4 MiB', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'far one')
  f.typed('qB', 'far two')
  f.typed('qC', 'far three')
  for (let i = 0; i < 14; i += 1) f.big(`big${i}`, 100_000)
  f.assistant('last')
  expect(w.size()).toBeGreaterThan(MIB + 100_000)
  await start($)
  const size = w.size()
  expect(w.reads, 'the 1 MiB window, then the 4 MiB window; no third read').toEqual([
    { offset: size - MIB, length: MIB },
    { offset: 0, length: size },
  ])
  expect(ids(w)).toEqual(['qC', 'qB', 'qA'])
})

test('A4b three questions in the window: no deeper read, though older ones exist', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('old', 'older than the window')
  for (let i = 0; i < 12; i += 1) f.big(`big${i}`, 100_000)
  f.typed('q1', 'one')
  f.typed('q2', 'two')
  f.typed('q3', 'three')
  await start($)
  expect(w.reads).toHaveLength(1)
  expect(ids(w)).toEqual(['q3', 'q2', 'q1'])
})

test('A4c a compaction mark in the window before three questions: no deeper read', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('behind', 'behind the mark')
  for (let i = 0; i < 12; i += 1) f.big(`big${i}`, 100_000)
  f.boundary('b1')
  f.typed('q1', 'only one after the mark')
  await start($)
  expect(w.reads).toHaveLength(1)
  expect(ids(w)).toEqual(['q1'])
})

test('A4d the deeper read is ONE: a file of more than 4 MiB with one question at its end reads twice and lists the one', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('far', 'beyond the deeper window')
  for (let i = 0; i < 50; i += 1) f.big(`big${i}`, 100_000)
  f.typed('near', 'the one question in the windows')
  await start($)
  const size = w.size()
  expect(size).toBeGreaterThan(4 * MIB)
  expect(w.reads).toEqual([
    { offset: size - MIB, length: MIB },
    { offset: size - 4 * MIB, length: 4 * MIB },
  ])
  expect(ids(w)).toEqual(['near'])
})

test('A4e after the deeper read a refresh reads only the bytes after what it parsed, and makes no deeper read again', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'far one')
  for (let i = 0; i < 14; i += 1) f.big(`big${i}`, 100_000)
  await start($)
  expect(w.reads).toHaveLength(2)
  const before = w.size()
  f.typed('qB', 'a newer question')
  await turnStart($)
  expect(w.reads.slice(2), 'only the new bytes').toEqual([{ offset: before, length: w.size() - before }])
  expect(ids(w)).toEqual(['qB', 'qA'])
})

test('A16 a 100,000-character pasted question: the shown text is cut and nothing in state holds the whole line', async ($, on) => {
  const w = world(on)
  const f = script(w)
  const pasted = `first line of the paste ${'p'.repeat(100_000)}`
  f.typed('qP', pasted)
  await start($)
  const [shown] = textsOf(w)
  expect(shown?.startsWith('first line of the paste')).toBe(true)
  expect(shown?.length).toBeLessThanOrEqual(60)
  await typedIn($, pasted) // the submit keeps the shown text too
  expect(pendingOf(w)[0]?.text.length).toBeLessThanOrEqual(60)
  for (const write of w.writes) expect(JSON.stringify(write.value).length, `${write.key} stays small`).toBeLessThan(2000)
})

test('A18a a window of Cyrillic lines cut in the middle of a character: the cut line is dropped, the rest is read, the file length is the recent size', async ($, on) => {
  const w = world(on)
  const f = script(w)
  for (let i = 0; i < 4; i += 1) f.typed(`old${i}`, `вопрос номер ${i} с длинным хвостом ${'я'.repeat(80)}`)
  for (let i = 0; i < 12; i += 1) f.big(`big${i}`, 60_000, 'я') // 120 KB of two-byte characters each
  f.typed('qA', 'первый вопрос')
  f.typed('qB', 'второй вопрос')
  f.typed('qC', 'третий вопрос')
  for (let k = 1; (w.bytes[w.size() - MIB] ?? 0) >> 6 !== 2 && k < 40; k += 1) w.appendRaw(`{"p":"${'я'.repeat(k)}"}\n`) // until the window starts inside a two-byte character
  expect((w.bytes[w.size() - MIB] ?? 0) >> 6, 'the window starts on a continuation byte').toBe(2)
  await start($)
  expect(ids(w)).toEqual(['qC', 'qB', 'qA'])
  expect(textsOf(w)).toEqual(['третий вопрос', 'второй вопрос', 'первый вопрос'])
  expect(recentOf(w)?.size).toBe(w.size())
})

test('A18b a last line with no newline is still being written: it is not listed; with its newline it is', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'complete one')
  await start($)
  expect(ids(w)).toEqual(['qA'])
  const partial = JSON.stringify({ type: 'user', uuid: 'qB', parentUuid: 'qA', isSidechain: false, origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: 'being written' } })
  w.appendRaw(partial) // a whole JSON text, and no newline yet
  await turnStart($)
  expect(ids(w), 'the line is not finished').toEqual(['qA'])
  expect(recentOf(w)?.size, 'the size is what the stat saw: its growth is what the tick looks for').toBe(w.size())
  w.appendRaw('\n')
  await turnStart($)
  expect(ids(w)).toEqual(['qB', 'qA'])
})

test('A18c offset 0 keeps the first line of the file', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qFirst', 'the very first line of the file')
  await start($)
  expect(w.reads).toEqual([{ offset: 0, length: w.size() }])
  expect(ids(w)).toEqual(['qFirst'])
})

test('A18d the cache reads only the bytes after its end; a file that got smaller, or another path, is read whole again', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'one')
  f.typed('qB', 'two')
  await start($)
  const first = w.size()
  f.typed('qC', 'three')
  await turnStart($)
  expect(w.reads.at(-1), 'only the new bytes').toEqual({ offset: first, length: w.size() - first })
  expect(ids(w)).toEqual(['qC', 'qB', 'qA'])
  // the file is replaced by a shorter one (a new session in the same process)
  w.bytes = new Uint8Array(0)
  const g = script(w)
  g.typed('qX', 'new file')
  expect(w.size()).toBeLessThan(first)
  await turnStart($)
  expect(w.reads.at(-1), 'the whole window again').toEqual({ offset: 0, length: w.size() })
  expect(ids(w)).toEqual(['qX'])
  // the same bytes under another path are read whole as well
  w.path = '/work/sessions/s2.jsonl'
  g.typed('qY', 'after the path changed')
  await turnStart($)
  expect(w.reads.at(-1)).toEqual({ offset: 0, length: w.size() })
  expect(ids(w)).toEqual(['qY', 'qX'])
})

test('A19a the fallback also when the newest typed question the engine lists is not on the walked chain (a file whose lines carry no origin); one toast per session', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.sent('l1', 'an invented question of an older file')
  f.assistant('la1')
  f.sent('l2', 'another invented question')
  f.assistant('la2')
  w.messages = [
    { role: 'user', text: 'an invented question of an older file', toolUses: [], uuid: 'l1' },
    { role: 'assistant', text: 'an answer', toolUses: [], uuid: 'la1' },
    { role: 'user', text: 'another invented question', toolUses: [], uuid: 'l2' },
    { role: 'user', text: '', toolUses: [], uuid: 'r9', toolResults: [{ tool_use_id: 't', text: 'done', isError: false }] },
  ]
  await start($)
  expect(ids(w), 'what the engine lists, newest first').toEqual(['l2', 'l1'])
  expect(w.toasts).toEqual([FALLBACK_TOAST])
  await turnStart($)
  expect(w.toasts, 'one toast per session').toEqual([FALLBACK_TOAST])
})

test('A19b a newest engine-listed question that IS on the chain is no fallback; the chain is the source', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('qA', 'first')
  f.typed('qB', 'second')
  w.messages = [
    { role: 'user', text: 'first', toolUses: [], uuid: 'qA' },
    { role: 'user', text: 'second', toolUses: [], uuid: 'qB' },
  ]
  await start($)
  expect(ids(w)).toEqual(['qB', 'qA'])
  expect(w.toasts).toEqual([])
  expect(w.messageReads, 'the engine list was looked at').toBeGreaterThan(0)
})

test('A19c a preserved segment of a compaction yields no question: what is behind the mark is not walked into', async ($, on) => {
  const w = world(on)
  const f = script(w)
  f.typed('before', 'a question before the compaction')
  f.assistant('beforeA')
  f.boundary('b1')
  f.assistant('b1-p1') // the preserved segment: answers and tool results, never a question
  f.toolResult('b1-t1')
  f.assistant('b1-p2')
  await start($)
  expect(ids(w)).toEqual([])
  expect(recentOf(w)).toEqual({ questions: [], size: w.size() })
  expect(w.toasts).toEqual([])
})

test('A10b a window that parses but holds no line the walk recognises falls back to the engine list with one toast per session', async ($, on) => {
  const w = world(on)
  for (let i = 0; i < 3; i += 1) w.append({ kind: 'unknown', id: `x${i}`, body: 'invented' }) // lines with no uuid and no type
  w.messages = [{ role: 'user', text: 'an invented question', toolUses: [], uuid: 'e1' }]
  await start($)
  expect(ids(w)).toEqual(['e1'])
  expect(w.toasts).toEqual([FALLBACK_TOAST])
  await turnStart($)
  expect(w.toasts).toEqual([FALLBACK_TOAST])
  expect(writesOf(w, 'recent').length, 'the same fallback is not written twice').toBe(1)
})

test('A10f a file with only lines that carry no uuid (a session before its first prompt) and an engine list with no question: nothing to show, so no toast', async ($, on) => {
  const w = world(on)
  w.append({ type: 'file-history-snapshot', messageId: 'm1', snapshot: {} })
  await start($)
  expect(w.messageReads, 'the engine list was looked at').toBeGreaterThan(0)
  expect(w.toasts).toEqual([])
  expect(ids(w)).toEqual([])
  const f = script(w)
  f.typed('qA', 'the first prompt')
  await turnStart($)
  expect(ids(w), 'the file now holds a line the walk knows').toEqual(['qA'])
  expect(w.toasts).toEqual([])
})
