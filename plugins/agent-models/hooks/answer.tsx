// The `last answer` button (1.5.0) and its list (1.6.0): the button opens a list under the account row whose first row brings the
// owner's last question to the top of the transcript window, so the answer starts right under it. Since 1.8.0 two more rows bring the
// two questions before it, then a separator (only with pins) and the pins (hooks/pins.tsx). The target is the question's transcript
// uuid, kept in `$.state` at the person's submit (the questions before the last one in `earlierQuestions`): the press must call
// `$.ui.scroll` at once (an `await` before it makes the engine refuse the scroll, measured 2026-11-22), and after a hot reload the
// rows drawn earlier are not drawn again, so no list of drawn rows could be searched. Every function that takes `$` is a function
// declaration (an arrow taking `$` is refused across an import). Nothing here throws out of a hook.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, PromptSubmitResult, SessionMessage, UiScrollArgs, UiScrollResult } from 'claude-code'

import type { EarlierQuestion, LastQuestion, Pin } from '../types'
import { BUTTON_COLOR, CLOSE_COLOR, ENTRY_CAP } from './prompts'
import type { ScrollPress } from './pins'
import { PIN_COLOR, PIN_ICON, pinPress, runPress, unpin } from './pins'
import { earlierFrom, EARLIER_MAX, findQuestion, isWakeText, isWakeValue, newestQuestions, questionText } from './questions'

export { findQuestion, newestQuestion, questionText, SUMMARY_PREFIX } from './questions'

export const ANSWER_LABEL = 'last answer'
export const ANSWER_KEY = 'last-answer'
export const LIST_ROW_KEY = 'answer-last' // the list's first row
export const NO_QUESTION_ROW = '› no question yet'
export const OLD_QUESTION = 'last question' // the first row of a question stored by 1.5.0, which kept no text
export const EARLIER_ROW_KEY = 'answer-earlier-' // plus the uuid: the list's second and third rows
export const SEPARATOR_KEY = 'answer-separator'
export const SEPARATOR = '────────' // 8 cells: between the questions and the pins
const EARLIER_SHOWN = 2 // rows after the first one
export const LOOKUP_ROWS = 50 // a submit's lookup: the question is among the newest rows (it was just typed)
export const RESTORE_ROWS = 200 // a session start's lookup reads this many rows first, the engine cap only when none is a question
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge'])
const BUTTON_FRAME = 4 // `[ ` and ` ]` around a Button's label
const GAP = 2

// The engine's scan reads `read($, x)` only for an atom written in the same file: register.tsx reads this one through here.
const lastQuestion = atom({ plugin: 'agent-models', key: 'lastQuestion' } as const, null as LastQuestion)
const earlierQuestions = atom({ plugin: 'agent-models', key: 'earlierQuestions' } as const, [] as readonly EarlierQuestion[])
const answerListOpen = atom({ plugin: 'agent-models', key: 'answerListOpen' } as const, false)

const isEntry = (v: unknown): v is EarlierQuestion => typeof v === 'object' && v !== null && 'uuid' in v && typeof v.uuid === 'string' && 'text' in v && typeof v.text === 'string'
const listOf = (value: unknown): readonly EarlierQuestion[] => (Array.isArray(value) ? value.filter(isEntry) : []) // a state stored before 1.8.0 has none

/** The questions before the last one, newest first; none when the read is refused (the list then draws its first row only). */
export async function currentEarlierQuestions($: EngineInterface): Promise<readonly EarlierQuestion[]> {
  try {
    return listOf(await read($, earlierQuestions))
  } catch {
    return []
  }
}

export async function currentLastQuestion($: EngineInterface): Promise<LastQuestion> {
  return (await read($, lastQuestion)) ?? null // a state stored before 1.5.0 has none
}

export async function currentAnswerListOpen($: EngineInterface): Promise<boolean> {
  return (await read($, answerListOpen)) === true // a state stored before 1.6.0 has none: closed
}

// --- pure (the questions of a transcript: hooks/questions.ts) ---

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

/**
 * The press on the list's first row. With a uuid (or the `previous` of a pending question) it calls `scroll` BEFORE it yields (no `await` ahead of the call), then tells a
 * refusal in a toast; the scroll and the toast are arguments so a test can hand fakes. Never throws.
 */
export async function pressLastAnswer(scroll: (args: UiScrollArgs) => Promise<UiScrollResult>, toast: (text: string) => void, question: LastQuestion): Promise<void> {
  if (question === null) return toast('last answer: no question yet')
  const press = firstRowPress(question)
  if (press === undefined) return toast('last answer: your question is not in the transcript yet')
  return runPress(scroll, toast, press)
}

/** The press on the list's first row: the question's uuid, or (a pending question is not in the transcript yet) the question before it; undefined when there is none. */
export function firstRowPress(question: Exclude<LastQuestion, null>): ScrollPress | undefined {
  const id = 'uuid' in question ? question.uuid : question.previous
  return id === undefined ? undefined : { label: 'last answer', id }
}

/** The press on the list's second or third row: the question's uuid, never its text. */
export const earlierPress = (question: EarlierQuestion): ScrollPress => ({ label: 'earlier question', id: question.uuid })

/** What the first row says: the settled question's text; a pending one's press goes to the question before it, so it says that one's text and that the new one is on its way. */
export function questionRowText(question: Exclude<LastQuestion, null>): string {
  if ('uuid' in question) return question.text ?? OLD_QUESTION
  const before = question.previous === undefined ? questionText(question.pending) : question.previousText
  return `${before ?? OLD_QUESTION} (sending…)`
}

// The button opens or closes the list. Opening closes the tasks view and the message viewer (`closeOthers`): the three are never open
// together, so the viewer's row count stays what it was.
export async function toggleAnswerList($: EngineInterface, closeOthers: () => Promise<unknown>): Promise<void> {
  try {
    const isOpen = await read($, answerListOpen)
    if (!isOpen) await closeOthers().catch(() => undefined)
    await update($, answerListOpen, cur => !cur)
    if (!isOpen) {
      try { // the list is open (the press showed at once): a stored wake value is replaced by the newest question, as at a session start
        if (isWakeValue(await currentLastQuestion($))) await restoreQuestion($)
      } catch {
        // the next open tries again
      }
      await refreshEarlier($) // what a session from 1.7.0 or a reload did not fill is read from the transcript now
    }
  } catch {
    // a refused read or write: the list stays as it was; the next press tries again
  }
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

function earlierRow($: EngineInterface, e: RenderEvent, question: EarlierQuestion) {
  const { Button, Text } = $.ui.resolve(e)
  return (
    <Button key={`${EARLIER_ROW_KEY}${question.uuid}`} label={`› ${question.text}`} onPress={() => void runPress(args => $.ui.scroll(args), text => $.ui.toast(text), earlierPress(question))}>
      <Text color={BUTTON_COLOR}>{`› ${question.text}`}</Text>
    </Button>
  )
}

/** The questions the list draws after its first row: `earlier` without the one the first row presses (a pending question's row goes to the one before it), the first two. */
export function earlierShown(question: LastQuestion, earlier: readonly EarlierQuestion[]): EarlierQuestion[] {
  const first = question === null ? undefined : firstRowPress(question)?.id
  return question === null ? [] : earlier.filter(q => q.uuid !== first).slice(0, EARLIER_SHOWN)
}

/**
 * The open list: the last question first, then the two before it (newest first), then (only with pins) a separator and the pins
 * oldest first (the band scrolls a list taller than its room).
 */
export function answerList($: EngineInterface, e: RenderEvent, question: LastQuestion, earlier: readonly EarlierQuestion[], pins: readonly Pin[]) {
  const { Box, Button, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="column">
      {question === null ? (
        <Text dimColor>{NO_QUESTION_ROW}</Text>
      ) : (
        <Button key={LIST_ROW_KEY} label={`› ${questionRowText(question)}`} onPress={() => void pressLastAnswer(args => $.ui.scroll(args), text => $.ui.toast(text), question)}>
          <Text color={BUTTON_COLOR}>{`› ${questionRowText(question)}`}</Text>
        </Button>
      )}
      {earlierShown(question, earlier).map(q => earlierRow($, e, q))}
      {pins.length > 0 ? <Box key={SEPARATOR_KEY}><Text dimColor>{SEPARATOR}</Text></Box> : null}
      {pins.map(pin => pinRow($, e, pin))}
    </Box>
  )
}

// --- knowing the question before any press ---

let generation = 0 // the newest person's submit (or session end) this module saw: older work stops being the value's writer
let endEpoch = 0 // the session ends this module saw: work that began before one stops writing `earlierQuestions` (as pins.tsx's `generation`)

async function recentRows($: EngineInterface, last: number): Promise<readonly SessionMessage[]> {
  const rows = await $.session.messages({ last })
  return Array.isArray(rows) ? rows : [] // a deny is no rows
}

// What a new pending question keeps of the value before it: the uuid of the question it replaces (`previous`) and its text.
const previousOf = (cur: LastQuestion): { previous?: string; previousText?: string } => {
  if (cur === null || isWakeValue(cur)) return {} // a wake value (stored by 1.7.0 or 1.8.0) is no question to go back to
  if ('uuid' in cur) return { previous: cur.uuid, ...(cur.text === undefined ? {} : { previousText: cur.text }) }
  if (cur.previous === undefined) return {}
  return { previous: cur.previous, ...(cur.previousText === undefined ? {} : { previousText: cur.previousText }) }
}

const textPart = (text: string | undefined): { text?: string } => (text === undefined ? {} : { text })

type Pending = { pending: string; previous?: string; previousText?: string }

/** The uuid the list's first row presses (the last question, or the one before a pending question): the row the earlier questions are older than. */
const anchorOf = (cur: LastQuestion): string | undefined => (cur === null ? undefined : firstRowPress(cur)?.id)

const sameList = (a: readonly EarlierQuestion[], b: readonly EarlierQuestion[]): boolean =>
  a.length === b.length && a.every((q, i) => q.uuid === b[i]?.uuid && q.text === b[i]?.text)

// `next` makes the new list from the one that stands, INSIDE the change function: `update` runs it again on a version miss, and the list
// written is the one of the run that landed. A run after a session end returns the list as it is. A list that already holds `anchor` was
// written by a newer settle (a list never holds the question it is older than): an older settle that lands late leaves it alone.
async function writeEarlier($: EngineInterface, epoch: number, anchor: string | undefined, next: (cur: readonly EarlierQuestion[]) => readonly EarlierQuestion[]): Promise<void> {
  await update($, earlierQuestions, raw => {
    const cur = listOf(raw)
    if (epoch !== endEpoch || (anchor !== undefined && cur.some(q => q.uuid === anchor))) return cur
    return next(cur)
  })
}

// The pending question becomes its uuid, only while it is still that pending question (same text, same `previous`; a stored `queued`
// of a 1.5.0 candidate is ignored) and `mine` is still the newest generation (a session end or a newer submit owns the value).
// `earlierQuestions` is written FIRST, from the rows the lookup read plus what is kept (the question before it, the old list): the
// list draws every row but the one the first row presses, so every state between the two writes draws right. It does not wait for
// `mine`: a newer settle recomputes it from its own rows and what stands. The session-end epoch stops it after a session end.
async function settle($: EngineInterface, pending: Pending, uuid: string, mine: number, epoch: number, rows: readonly SessionMessage[]): Promise<void> {
  const before: EarlierQuestion[] = pending.previous === undefined ? [] : [{ uuid: pending.previous, text: pending.previousText ?? OLD_QUESTION }]
  await writeEarlier($, epoch, uuid, cur => earlierFrom(rows, uuid, [...before, ...cur]))
  await update($, lastQuestion, cur => (
    mine === generation && cur !== null && 'pending' in cur && cur.pending === pending.pending && cur.previous === pending.previous ? { uuid, ...textPart(questionText(pending.pending)) } : cur
  ))
}

/**
 * After `next(e)` of a `prompt.submit`: a prompt the person typed (here or through the bridge) becomes the last question. A
 * notification, a peer, a plugin, a meta prompt, a slash command, the wake text (1.8.1) and a dropped prompt leave the value as it is. The value is
 * `pending` (with the question before it as `previous`) while the text is not in the transcript (queued behind a running turn,
 * or typed into one). The pending write is the first thing here, with no `await` before it, so submits start in their order;
 * the writes may land out of order, and the value is still the newest submit's: the change function checks the generation, and
 * `update` runs it again on a version miss. Never rejects.
 */
export async function noteSubmit($: EngineInterface, e: PromptSubmitInput, result: PromptSubmitResult): Promise<void> {
  try {
    if (result.drop !== undefined || e.command !== undefined || e.isMeta === true || !PERSON_ORIGINS.has(e.origin.kind)) return
    const entered = result.text
    if (isWakeText(entered)) return // the wake text is never a question, typed or sent: row 1 stays, a pending question stays pending
    const mine = (generation += 1)
    const epoch = endEpoch
    const written = await update($, lastQuestion, cur => (mine === generation ? { pending: entered, ...previousOf(cur) } : cur))
    if (mine !== generation || written === null || !('pending' in written)) return // a newer submit (or a session end) owns the value
    const rows = await recentRows($, LOOKUP_ROWS)
    const uuid = findQuestion(rows, entered, written.previous)
    if (uuid !== undefined && mine === generation) await settle($, written, uuid, mine, epoch, rows)
  } catch {
    // a refused read or write: the value stays as it was; the next submit or turn tries again
  }
}

/**
 * At `turn.start` and `turn.complete`: a pending question (it was queued) is looked for again, never at or before its `previous`. A lookup
 * that began before a session end or a newer submit writes nothing (the module generation, as in `noteSubmit` and `restoreQuestion`).
 * `isDeep` (the turn's end): when the newest rows do not hold it and do not reach back to `previous` (a long answer is in between),
 * a longer read reaches the engine cap. Never rejects.
 */
export async function retryPending($: EngineInterface, isDeep: boolean): Promise<void> {
  const mine = generation // a session end (or a newer submit) during the reads below owns the value
  const epoch = endEpoch
  try {
    const cur = await read($, lastQuestion)
    if (cur === null || !('pending' in cur)) return
    let rows = await recentRows($, LOOKUP_ROWS)
    let uuid = findQuestion(rows, cur.pending, cur.previous)
    // a longer read only when the newest rows may hide the question: they do not reach back to `previous`
    const reachesPrevious = cur.previous !== undefined && rows.some(row => row.uuid === cur.previous)
    if (uuid === undefined && isDeep && rows.length >= LOOKUP_ROWS && !reachesPrevious) {
      rows = await recentRows($, ENTRY_CAP)
      uuid = findQuestion(rows, cur.pending, cur.previous)
    }
    if (uuid !== undefined && mine === generation) await settle($, cur, uuid, mine, epoch, rows)
  } catch {
    // the next turn tries again
  }
}

/**
 * At a session start. With no value (a resume, or a session from before 1.5.0): the newest four questions of the transcript; the list
 * (the older ones merged with the stored list by `earlierFrom`) is written first, then the newest. With a value and no `earlierQuestions`
 * (a session from 1.7.0): only the list is filled from the questions older than the first row's. A stored wake value (1.7.0 kept it,
 * 1.8.0 let the owner type it) counts as no value (1.8.1): the newest question replaces it, null when the rows hold none; a refused or empty read changes nothing. Never rejects.
 */
export async function restoreQuestion($: EngineInterface): Promise<void> {
  const mine = generation // a session end (or a submit) during the reads below owns the value
  const epoch = endEpoch
  try {
    const cur = await read($, lastQuestion)
    if (cur !== null && !isWakeValue(cur)) return await fillEarlier($, cur, mine) // a reload keeps the session: the value stays
    const wanted = EARLIER_MAX + 1
    let rows = await recentRows($, RESTORE_ROWS)
    let found = newestQuestions(rows, wanted)
    if (found.length < wanted && rows.length >= RESTORE_ROWS) {
      rows = await recentRows($, ENTRY_CAP)
      found = newestQuestions(rows, wanted)
    }
    const [newest] = found
    if (newest === undefined) { // rows were read and none is a question: a stored wake value goes (an empty or refused read leaves it for the next try)
      if (cur !== null && rows.length > 0) await update($, lastQuestion, raw => (mine === generation && raw !== null && isWakeValue(raw) ? null : raw))
      return
    }
    // The list first, from the rows plus what stands. Not `writeEarlier`: its anchor test would stop a list that holds the question row 1 is about to press.
    const stored = await currentEarlierQuestions($) // a refused read of the list is no list: the restore goes on
    if (!sameList(stored, earlierFrom(rows, newest.uuid, stored))) {
      await update($, earlierQuestions, raw => (mine === generation && epoch === endEpoch ? earlierFrom(rows, newest.uuid, listOf(raw)) : listOf(raw)))
    }
    const restored = { uuid: newest.uuid, text: newest.text }
    await update($, lastQuestion, raw => ((raw === null || isWakeValue(raw)) && mine === generation ? restored : raw))
  } catch {
    // the transcript is not readable yet; the first submit sets the value
  }
}

// A value stored by 1.7.0 and no list: the questions older than the first row's are read (the engine cap when the newest rows hold fewer than the list keeps).
async function fillEarlier($: EngineInterface, cur: Exclude<LastQuestion, null>, mine: number): Promise<void> {
  const anchor = anchorOf(cur)
  if (anchor === undefined || listOf(await read($, earlierQuestions)).length > 0) return
  let rows = await recentRows($, RESTORE_ROWS)
  let list = earlierFrom(rows, anchor, [])
  if (list.length < EARLIER_MAX && rows.length >= RESTORE_ROWS) {
    rows = await recentRows($, ENTRY_CAP)
    list = earlierFrom(rows, anchor, [])
  }
  if (list.length > 0) await update($, earlierQuestions, raw => (mine === generation && listOf(raw).length === 0 ? list : listOf(raw)))
}

/**
 * When the list opens: `earlierQuestions` is made again from the newest rows and what stands (a session from 1.7.0 or a reload may hold
 * none; nothing the read cannot see is dropped). A write only when the list changes. Repeats when the first row's question changed
 * during it (a settle landed), at most three times. Never rejects.
 */
async function refreshEarlier($: EngineInterface): Promise<void> {
  const epoch = endEpoch
  try {
    for (let round = 0; round < 3; round += 1) {
      const anchor = anchorOf(await read($, lastQuestion))
      if (anchor === undefined) return
      const rows = await recentRows($, LOOKUP_ROWS)
      const old = listOf(await read($, earlierQuestions))
      if (old.some(q => q.uuid === anchor)) return // a settle is between its two writes: it owns the list
      const next = earlierFrom(rows, anchor, old)
      if (!sameList(old, next)) await writeEarlier($, epoch, anchor, cur => earlierFrom(rows, anchor, cur))
      if (anchorOf(await read($, lastQuestion)) === anchor) return
    }
  } catch {
    // the list stays as it was; the next open tries again
  }
}

async function swallow(write: Promise<unknown>): Promise<void> {
  try {
    await write
  } catch {
    // a refused write: the next session's first submit replaces the value
  }
}

/** At a session end (a `/clear` raises no `session.start`): both values are cleared, and work still in flight stops writing. Never rejects. */
export async function clearQuestion($: EngineInterface): Promise<void> {
  generation += 1
  endEpoch += 1
  await Promise.all([swallow(update($, earlierQuestions, () => [])), swallow(update($, lastQuestion, () => null))])
}
