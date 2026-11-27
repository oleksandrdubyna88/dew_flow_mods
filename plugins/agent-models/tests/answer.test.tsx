import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { UiScrollArgs, UiScrollResult } from 'claude-code'

import { accountRowCells, questionPress } from '../hooks/answer'
import { runPress } from '../hooks/pins'
import { VIEWER_NOTE, viewerFixedRows } from '../hooks/prompts'
import { tasksLabel } from '../hooks/tasks'
import { BAND, SURFACES, answerWith, MEASURED, text as drawnText, world as limitsWorld } from './limits-fixtures'
import { script, settle, start, world } from './asked-fixtures'

// The `last answer` button (1.5.0, tests T1, T2, T11, T12b, T14) after the questions moved to the transcript file (1.9.0; the questions themselves
// are tested in asked-read.test.tsx and asked.test.tsx). The harness cannot see where a transcript scroll goes, so the press is tested through
// `runPress` with a fake scroll, as the pins are.

type Ui = Mounted<'terminal' | 'desktop', 'AbovePrompt'>
const FULLSCREEN = { columns: 80, rows: 24, isFullscreen: true } as const
const MAIN_SCREEN = { columns: 80, rows: 24, isFullscreen: false } as const
const keysOf = async (ui: Ui) => (await ui.findAll({ type: 'Button' })).map(b => b.key)

// --- the button ---

for (const surface of SURFACES) {
  test(`T1 the band draws a last-answer button after tasks (n), viewer closed and open (${surface})`, async ($, on) => {
    const w = world(on)
    script(w).typed('u1', 'hello')
    w.messages = [{ role: 'user', text: 'hello', toolUses: [], uuid: 'u1' }] // what the messages viewer reads
    await start($)
    const ui = await $.ui.mount({ ...BAND, surface, viewport: FULLSCREEN })
    const closed = await keysOf(ui)
    expect(closed.indexOf('last-answer')).toBeGreaterThan(-1)
    expect(closed.indexOf('last-answer')).toBeGreaterThan(closed.indexOf('my-tasks'))
    expect((await ui.find({ type: 'Button', key: 'last-answer' }))?.props.label).toBe('last answer ▾')
    await ui.press({ key: 'my-messages' })
    await ui.redraw()
    const open = await keysOf(ui)
    expect(open.indexOf('last-answer')).toBeGreaterThan(open.indexOf('my-tasks'))
    expect(open.indexOf('my-tasks')).toBeGreaterThan(-1)
    await ui.press({ key: 'close' })
    await ui.unmount()
  })

  test(`T2 no button on the main screen; a surface that did not measure still draws it (${surface})`, async ($, on) => {
    world(on)
    await start($)
    const main = await $.ui.mount({ ...BAND, surface, viewport: MAIN_SCREEN })
    expect(await keysOf(main)).not.toContain('last-answer')
    await main.unmount()
    const unknown = await $.ui.mount({ ...BAND, surface })
    expect(await keysOf(unknown)).toContain('last-answer')
    await unknown.unmount()
  })
}

// --- the press ---

const fakes = (answer: () => Promise<UiScrollResult> | UiScrollResult = () => ({})) => {
  const scrolls: UiScrollArgs[] = []
  const toasts: string[] = []
  return {
    scrolls,
    toasts,
    scroll: (args: UiScrollArgs): Promise<UiScrollResult> => {
      scrolls.push(args)
      return Promise.resolve().then(answer)
    },
    toast: (text: string) => void toasts.push(text),
  }
}

test('T10 a press on a question row scrolls once, at once, with the requestId and block start', async () => {
  const f = fakes()
  const pressing = runPress(f.scroll, f.toast, questionPress('u1', true))
  expect(f.scrolls, 'the scroll is called before the press yields').toEqual([{ to: { requestId: 'u1' }, block: 'start' }])
  await pressing
  expect(f.scrolls).toHaveLength(1)
  expect(f.toasts).toEqual([])
})

test('T11 a refused or failed scroll is told in a toast under the row\'s heading and never thrown', async () => {
  for (const [isNewest, heading] of [[true, 'last answer'], [false, 'earlier question']] as const) {
    const none = fakes(() => ({ deny: 'none scrolls' }))
    await runPress(none.scroll, none.toast, questionPress('u1', isNewest))
    expect(none.toasts).toEqual([`${heading}: works in fullscreen only`])
    const other = fakes(() => ({ deny: 'not person-initiated' }))
    await runPress(other.scroll, other.toast, questionPress('u1', isNewest))
    expect(other.toasts).toEqual([`${heading}: not person-initiated`])
    const broken = fakes(() => {
      throw new Error('boom')
    })
    await runPress(broken.scroll, broken.toast, questionPress('u1', isNewest))
    expect(broken.toasts).toEqual([`${heading}: boom`])
  }
})

for (const surface of SURFACES) {
  test(`T12b the drawn button opens a list that says there is no question yet, and toasts nothing (${surface})`, async ($, on) => {
    const w = world(on)
    await start($)
    const ui = await $.ui.mount({ ...BAND, surface, viewport: FULLSCREEN })
    await ui.press({ key: 'last-answer' })
    await settle()
    await ui.redraw()
    expect((await ui.find({ type: 'Text', text: '› no question yet' }))?.props.dimColor).toBe(true)
    expect(w.toasts).toEqual([])
    await ui.unmount()
  })
}

// --- the viewer counts a wrapped account row ---

const LONG = `${'long.nam.'.repeat(10)}@example.com` // 102 characters: with the other buttons it wraps to two rows at 80 columns, not three

test('T14 the viewer counts the account row wrapped at its width, not as one row', () => {
  const short = accountRowCells({ account: 'dev@example.com', isKnown: true, isLoginPending: false, tasks: tasksLabel(0), wake: 'wake 2h', isAnswerShown: true })
  // [ dev@example.com ]  [ login ]  [ tasks (0) ]  [ last answer ▾ ]
  expect(short).toBe(19 + 2 + 9 + 2 + 13 + 2 + 17 + 2 + 11) // 1.7.0: + the gap and `[ wake 2h ]`
  expect(viewerFixedRows(80, false, undefined, undefined, VIEWER_NOTE, short)).toBe(viewerFixedRows(80, false, undefined))
  const long = accountRowCells({ account: LONG, isKnown: true, isLoginPending: false, tasks: tasksLabel(0), wake: 'wake 2h', isAnswerShown: true })
  expect(long).toBe(LONG.length + 4 + 2 + 9 + 2 + 13 + 2 + 17 + 2 + 11)
  expect(viewerFixedRows(80, false, undefined, undefined, VIEWER_NOTE, long)).toBe(viewerFixedRows(80, false, undefined) + 2) // 164 cells: three rows at 80
  const hidden = accountRowCells({ account: LONG, isKnown: true, isLoginPending: false, tasks: tasksLabel(0), wake: 'wake 2h', isAnswerShown: false })
  expect(hidden).toBe(long - 19) // no last answer button, no gap; the wake button stays
  expect(accountRowCells({ account: 'account ?', isKnown: false, isLoginPending: true, tasks: tasksLabel(3), wake: 'wake 2h', isAnswerShown: false }))
    .toBe('account ?'.length + 2 + 9 + ' logging in…'.length + 2 + 13 + 2 + 11)
})

// agents 0 + fixed (2 + the account row 3: 1.7.0, with the wake button 164 cells) + the note (118 characters at 80: 2 rows) + `hello` 1 = 8; one row less would say 7
for (const [maxRows, header] of [[8, 'Message 1 / 1'], [7, 'Message 1 / 1 (scroll for more)']] as const) {
  test(`T14b a long email wraps the account row: at ${maxRows} rows the header says "${header}"`, async ($, on) => {
    on('session.messages', () => ({ value: [{ role: 'user', text: 'hello', toolUses: [] }] }))
    await limitsWorld($, on, answerWith(200, MEASURED), undefined, { email: LONG })
    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 80, maxRows }, surface: 'terminal', viewport: FULLSCREEN })
    await ui.press({ key: 'my-messages' })
    await ui.redraw()
    expect((await drawnText(ui, /^Message /))?.text).toBe(header)
    await ui.press({ key: 'close' })
    await ui.unmount()
  })
}
