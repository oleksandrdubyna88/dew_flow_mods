import { expect, test } from 'claude-code/testing'

import { cutLines, walk } from '../hooks/transcript'

// The pure part of the transcript reading (1.9.0, hooks/transcript.ts): the cut of a window into lines with their byte ends (A18), the
// live chain walk (A1-A3). The lines are invented, with Cyrillic where the byte ends matter.

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const lineOf = (o: Record<string, unknown>): string => JSON.stringify(o)
const human = (uuid: string, parent: string | null, text: string) =>
  lineOf({ type: 'user', uuid, parentUuid: parent, isSidechain: false, origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text } })

/** The absolute byte end of every line of `lines` (each with its newline). */
const endsOf = (lines: readonly string[]): number[] => {
  let at = 0
  return lines.map(l => (at += encoder.encode(`${l}\n`).length))
}

test('A18e the byte ends of a window cut anywhere in a Cyrillic line are the file\'s own ends; the cut line is dropped; offset 0 keeps the first line', () => {
  const lines = [human('a', null, 'вопрос один'), human('b', 'a', 'вопрос два, подлиннее'), human('c', 'b', 'третий'), human('d', 'c', 'четвёртый')]
  const bytes = encoder.encode(`${lines.join('\n')}\n`)
  const ends = endsOf(lines)
  expect(cutLines(decoder.decode(bytes), 0, bytes.length).map(l => l.end), 'offset 0: every line').toEqual(ends)
  for (let k = 1; k < (ends[0] ?? 0) + 20; k += 1) {
    const cut = cutLines(decoder.decode(bytes.slice(k)), k, bytes.length)
    const firstEnd = ends.find(e => e > k) ?? 0 // the end of the line that holds byte k (or starts at it): that line is the cut one
    expect(cut.map(l => l.end), `a window from byte ${k}`).toEqual(ends.filter(e => e > firstEnd))
  }
})

test('A18f a last line with no newline is dropped, whatever its bytes', () => {
  const lines = [human('a', null, 'привет'), human('b', 'a', 'мир')]
  const text = `${lines[0]}\n${lines[1]}` // the second is still being written
  expect(cutLines(text, 0, encoder.encode(text).length).map(l => l.end)).toEqual(endsOf([lines[0] ?? '']))
})

test('A1c a line that is not JSON, or has no uuid, is a line the walk does not use; it keeps the byte ends of the others right', () => {
  const lines = [human('a', null, 'one'), 'not json at all {', lineOf({ type: 'summary', note: 'no uuid' }), human('b', 'a', 'two')]
  const text = `${lines.join('\n')}\n`
  const cut = cutLines(text, 0, encoder.encode(text).length)
  expect(cut.map(l => l.end)).toEqual(endsOf(lines))
  expect(cut.map(l => l.uuid)).toEqual(['a', undefined, undefined, 'b'])
})

test('A2c the walk goes from the newest uuid line back by parentUuid, stops at a compaction mark, and lists the questions it passed newest first', () => {
  const lines = [
    human('o1', null, 'old'),
    lineOf({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', parentUuid: null, logicalParentUuid: 'o1', isSidechain: false }),
    human('n1', 'b1', 'new one'),
    lineOf({ type: 'assistant', uuid: 'a1', parentUuid: 'n1', isSidechain: false, message: { role: 'assistant', content: [] } }),
    human('n2', 'a1', 'new two'),
  ]
  const text = `${lines.join('\n')}\n`
  const found = walk(cutLines(text, 0, encoder.encode(text).length), false)
  expect(found.questions.map(q => q.id)).toEqual(['n2', 'n1'])
  expect(found.needsMore, 'a mark ends the walk: nothing more to read').toBe(false)
})

test('A4f a walk that runs out of lines in a window that does not start the file asks for more; at the file\'s start it does not', () => {
  const lines = [human('a', 'gone', 'parent is before the window'), human('b', 'a', 'next')]
  const text = `${lines.join('\n')}\n`
  const cut = cutLines(text, 0, encoder.encode(text).length)
  expect(walk(cut, true).needsMore, 'more of the file is before the window').toBe(true)
  expect(walk(cut, false).needsMore, 'the file starts here').toBe(false)
  expect(walk(cut, true).questions.map(q => q.id)).toEqual(['b', 'a'])
})
