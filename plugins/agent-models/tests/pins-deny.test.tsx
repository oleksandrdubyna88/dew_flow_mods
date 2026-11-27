import { expect, test } from 'claude-code/testing'
import type { UiScrollArgs, UiScrollResult } from 'claude-code'

import { pinPress, runPress } from '../hooks/pins'
import { labels, NOT_DRAWN, opened, settle, start, world } from './asked-fixtures'
import { A, B, pin, SCROLL_REJECTED, seededPins } from './pins-fixtures'

// The press on a pin row after a compaction (1.9.0, D, A14): the engine answers `nothing drawn under that requestId` for a row it no longer
// draws; the toast says so and the pin STAYS (the text is measured in fullscreen only: a removal on a misread deny would delete live pins).

const COMPACTED = 'pin: that answer is not in the transcript any more (compacted?) — press x to remove it'

test('A14 a pin press keeps the pin whatever the scroll answers: the harness rejects the scroll (a toast), and the pins stay in the list', async ($, on) => {
  const w = world(on)
  seededPins(on, [pin(A, 'one'), pin(B, 'two')])
  await start($)
  const ui = await opened($)
  await ui.press({ key: `pin-go-${A}` })
  await settle()
  expect(w.toasts).toEqual([`pin: ${SCROLL_REJECTED}`])
  await ui.redraw()
  const keys = (await ui.findAll({ type: 'Button' })).flatMap(node => (node.key === undefined ? [] : [node.key]))
  expect(keys, 'both pins are still in the list, and their x').toEqual(expect.arrayContaining([`pin-go-${A}`, `pin-x-${A}`, `pin-go-${B}`, `pin-x-${B}`]))
  expect(await labels(ui)).toEqual([])
  await ui.unmount()
})

test('A14b a pin press whose scroll answers the deny `nothing drawn under that requestId` toasts the compacted text and scrolls first; any other deny toasts as before', async () => {
  const scrolls: UiScrollArgs[] = []
  const toasts: string[] = []
  const answers: UiScrollResult[] = [{ deny: NOT_DRAWN }, { deny: `${NOT_DRAWN} (fullscreen)` }, { deny: 'none scrolls in this view' }, { deny: 'refused by policy' }, {}]
  const scroll = (args: UiScrollArgs): Promise<UiScrollResult> => {
    scrolls.push(args)
    return Promise.resolve(answers[scrolls.length - 1] ?? {})
  }
  const first = runPress(scroll, text => toasts.push(text), pinPress(pin(A, 'one')))
  expect(scrolls, 'called before the press yields').toEqual([{ to: { requestId: A }, block: 'start' }])
  await first
  for (let i = 0; i < 4; i += 1) await runPress(scroll, text => toasts.push(text), pinPress(pin(A, 'one')))
  expect(toasts).toEqual([COMPACTED, COMPACTED, 'pin: works in fullscreen only', 'pin: refused by policy'])
})

test('A14c the deny on a question row is told as before, under its own heading (only pins get the compacted text)', async () => {
  const toasts: string[] = []
  await runPress(() => Promise.resolve({ deny: NOT_DRAWN }), text => toasts.push(text), { label: 'earlier question', id: 'qA' })
  expect(toasts).toEqual([`earlier question: ${NOT_DRAWN}`])
})
