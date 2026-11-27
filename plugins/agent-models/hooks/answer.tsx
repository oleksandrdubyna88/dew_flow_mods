// The `last answer` button (1.5.0) and its list (1.6.0): the button opens a list under the account row. Since 1.9.0 its rows are the last three
// questions of the session (hooks/asked.ts reads them from the transcript file, also those typed while Claude worked, and none from before a
// compaction), newest first, a submitted question the file does not hold yet (dim, `sending…`) before them; then a separator (only with pins)
// and the pins (hooks/pins.tsx). A press on a question scrolls to the uuid of its line, and must call `$.ui.scroll` at once (an `await` before
// it makes the engine refuse the scroll, measured 2026-11-22). Every function that takes `$` is a function declaration (an arrow taking `$` is
// refused across an import). Nothing here throws out of a hook.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { AskedQuestion, Pin, PendingQuestion } from '../types'
import { refreshRecent, RECENT_MAX, tickAsked } from './asked'
import { BUTTON_COLOR, CLOSE_COLOR } from './prompts'
import type { ScrollPress } from './pins'
import { PIN_COLOR, PIN_ICON, pinPress, runPress, unpin } from './pins'

export const ANSWER_LABEL = 'last answer'
export const ANSWER_KEY = 'last-answer'
export const QUESTION_KEY = 'answer-q-' // plus the question line's uuid
export const PENDING_KEY = 'answer-pending-' // plus the file length at the submit and the entry's place
export const NO_QUESTION_ROW = '› no question yet'
export const SEPARATOR_KEY = 'answer-separator'
export const SEPARATOR = '────────' // 8 cells: between the questions and the pins
export const PENDING_TOAST = 'last answer: not in the transcript yet'
const BUTTON_FRAME = 4 // `[ ` and ` ]` around a Button's label
const GAP = 2

// The engine's scan reads `read($, x)` only for an atom written in the same file: register.tsx reads this one through here.
const answerListOpen = atom({ plugin: 'agent-models', key: 'answerListOpen' } as const, false)

export async function currentAnswerListOpen($: EngineInterface): Promise<boolean> {
  return (await read($, answerListOpen)) === true // a state stored before 1.6.0 has none: closed
}

// --- pure ---

/** Whether the button is drawn: not on the terminal's main screen, where the transcript is its own scrollback and no scroll works. */
export const isAnswerShown = (viewport: { isFullscreen?: boolean } | undefined): boolean => viewport?.isFullscreen !== false

/** The button's label: an arrow says the list is closed (down) or open (up). */
export const answerLabel = (isOpen: boolean): string => `${ANSWER_LABEL} ${isOpen ? '▴' : '▾'}`

/** The cells the account row takes when it is drawn without the messages button (the open viewer): what wraps at the band's width. */
export function accountRowCells(row: { account: string; isKnown: boolean; isLoginPending: boolean; tasks: string; wake: string; isAnswerShown: boolean }): number {
  const framed = (label: string): number => label.length + BUTTON_FRAME
  return (
    (row.isKnown ? framed(row.account) : row.account.length) +
    GAP + framed('login') + (row.isLoginPending ? ' logging in…'.length : 0) +
    GAP + framed(row.tasks) +
    (row.isAnswerShown ? GAP + framed(answerLabel(false)) : 0) +
    GAP + framed(row.wake)
  )
}

// --- the press ---

/** The press on a question row: the uuid of its line, never its text; the newest question's heading is `last answer`, the others' `earlier question`. */
export const questionPress = (id: string, isNewest: boolean): ScrollPress => ({ label: isNewest ? 'last answer' : 'earlier question', id })

// The button opens or closes the list. Opening closes the tasks view and the message viewer (`closeOthers`): the three are never open
// together, so the viewer's row count stays what it was. Opening also reads the file again, after the flag is written (the press showed at once).
export async function toggleAnswerList($: EngineInterface, closeOthers: () => Promise<unknown>): Promise<void> {
  try {
    const isOpen = await read($, answerListOpen)
    if (!isOpen) await closeOthers().catch(() => undefined)
    await update($, answerListOpen, cur => !cur)
    if (!isOpen) await refreshRecent($)
  } catch {
    // a refused read or write: the list stays as it was; the next press tries again
  }
}

/** The 2 s tick's part: the file is looked at only while the list is open or a question is pending (hooks/asked.ts). Never rejects. */
export async function tickAnswer($: EngineInterface): Promise<void> {
  await tickAsked($, await currentAnswerListOpen($).catch(() => false))
}

/** Another view is opening: the list closes (a write only when it is open). Never rejects. */
export async function closeAnswerList($: EngineInterface): Promise<void> {
  try {
    if (await read($, answerListOpen)) await update($, answerListOpen, () => false)
  } catch {
    // the next press of the button repairs it
  }
}

/** At a session end: the list is closed. Never rejects. */
export async function clearAnswerList($: EngineInterface): Promise<void> {
  try {
    await update($, answerListOpen, () => false)
  } catch {
    // a refused write: the list stays; the pins it showed are gone
  }
}

type RenderEvent = Parameters<EngineInterface['ui']['resolve']>[0]

export function answerButton($: EngineInterface, e: RenderEvent, isOpen: boolean, closeOthers: () => Promise<unknown>) {
  const { Button, Text } = $.ui.resolve(e)
  const label = answerLabel(isOpen)
  return (
    <Button key={ANSWER_KEY} label={label} onPress={() => void toggleAnswerList($, closeOthers)}>
      <Text color={BUTTON_COLOR}>{label}</Text>
    </Button>
  )
}

function pinRow($: EngineInterface, e: RenderEvent, pin: Pin) {
  const { Box, Button, Text } = $.ui.resolve(e)
  return (
    <Box key={`pin-row-${pin.id}`}>
      <Button key={`pin-go-${pin.id}`} label={`${PIN_ICON} ${pin.text}`} onPress={() => void runPress(args => $.ui.scroll(args), text => $.ui.toast(text), pinPress(pin))}>
        <Text color={PIN_COLOR}>{PIN_ICON}</Text>
        <Text color={BUTTON_COLOR}>{` ${pin.text}`}</Text>
      </Button>
      <Text>{'  '}</Text>
      <Button key={`pin-x-${pin.id}`} label="unpin" onPress={() => void unpin($, pin.id)}>
        <Text color={CLOSE_COLOR}>x</Text>
      </Button>
    </Box>
  )
}

// A question the file does not hold yet: dim, its press only says so (there is no row to scroll to).
function pendingRow($: EngineInterface, e: RenderEvent, entry: PendingQuestion, place: number) {
  const { Button, Text } = $.ui.resolve(e)
  const label = `› ${entry.text} (sending…)`
  return (
    <Button key={`${PENDING_KEY}${entry.from}-${place}`} label={label} dimColor onPress={() => void tell($, PENDING_TOAST)}>
      <Text dimColor>{label}</Text>
    </Button>
  )
}

async function tell($: EngineInterface, text: string): Promise<void> {
  try {
    await $.ui.toast(text)
  } catch {
    // the toast is refused: nothing is left to tell
  }
}

function questionRow($: EngineInterface, e: RenderEvent, question: AskedQuestion, isNewest: boolean) {
  const { Button, Text } = $.ui.resolve(e)
  const label = `› ${question.text}`
  return (
    <Button key={`${QUESTION_KEY}${question.id}`} label={label} onPress={() => void runPress(args => $.ui.scroll(args), text => $.ui.toast(text), questionPress(question.id, isNewest))}>
      <Text color={BUTTON_COLOR}>{label}</Text>
    </Button>
  )
}

/**
 * The open list: up to three question rows (the pending entries first, newest first, then the questions of the file, newest first), then
 * (only with pins) a separator and the pins oldest first (the band scrolls a list taller than its room).
 */
export function answerList($: EngineInterface, e: RenderEvent, questions: readonly AskedQuestion[], entries: readonly PendingQuestion[], pins: readonly Pin[]) {
  const { Box, Text } = $.ui.resolve(e)
  const rows = [
    ...entries.map((entry, place) => pendingRow($, e, entry, place)).reverse(),
    ...questions.map((question, place) => questionRow($, e, question, place === 0)),
  ].slice(0, RECENT_MAX)
  return (
    <Box flexDirection="column">
      {rows.length === 0 ? <Text dimColor>{NO_QUESTION_ROW}</Text> : rows}
      {pins.length > 0 ? <Box key={SEPARATOR_KEY}><Text dimColor>{SEPARATOR}</Text></Box> : null}
      {pins.map(pin => pinRow($, e, pin))}
    </Box>
  )
}
