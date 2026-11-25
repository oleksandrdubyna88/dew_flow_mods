// The pure part of the `last answer` list (hooks/answer.tsx): which transcript rows are the owner's questions, what text the list
// shows for one, and `earlierFrom`, the list of the questions before the last one (1.8.0). Nothing here reads or writes state.
import type { SessionMessage } from 'claude-code'

import type { EarlierQuestion, LastQuestion } from '../types'
import { cutText } from './pins'
import { cleanPrompts } from './prompts'
import { WAKE_TEXT } from './wake'

export const SUMMARY_PREFIX = 'This session is being continued from a previous conversation'
export const EARLIER_MAX = 3 // the questions kept before the last one: the list draws two, the third is for the moment a new question is pending
const PEER_WRAPPER = /^<(?:teammate-message|agent-message)[\s>]/ // another agent's words: `cleanPrompts` drops only the engine's own tags

const isQuestionRow = (m: SessionMessage): m is SessionMessage & { uuid: string } =>
  m.role === 'user' && (m.toolResults?.length ?? 0) === 0 && typeof m.uuid === 'string'

/**
 * The uuid of the NEWEST user row whose clean text is `text`, among the rows newer than the row `notBefore` (that row and the older
 * ones are an earlier question: the same words asked again are not found until they are in the transcript). Rows are scanned newest
 * first and the scan stops at `notBefore`; with no boundary the whole window is scanned. Undefined while there is none.
 */
export function findQuestion(rows: readonly SessionMessage[], text: string, notBefore?: string): string | undefined {
  const wanted = cleanPrompts([text])[0] // both sides are compared clean; a text that is empty when clean matches nothing
  if (wanted === undefined) return undefined
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row === undefined) continue
    if (notBefore !== undefined && row.uuid === notBefore) return undefined
    if (isQuestionRow(row) && cleanPrompts([row.text])[0] === wanted) return row.uuid
  }
  return undefined
}

// The first row's text: the first line of the clean question, spaces collapsed, cut. The owner's own marks stay (it is no markdown block).
const firstLine = (clean: string): string => cutText((clean.split('\n').find(line => line.trim() !== '') ?? '').replace(/\s+/g, ' ').trim())

/** The text the list shows for a question the person typed; undefined when it is empty once clean. */
export function questionText(raw: string): string | undefined {
  const clean = cleanPrompts([raw])[0]
  return clean === undefined ? undefined : firstLine(clean)
}

/**
 * Whether `raw` is the wake text as the list would DRAW it (1.8.1): its shown text (first line, spaces collapsed, cut) is `WAKE_TEXT`.
 * The wake is sent `asUser`, so its transcript row carries no origin and a typed copy cannot be told from it: both are the wake text.
 */
export const isWakeText = (raw: string): boolean => questionText(raw) === WAKE_TEXT

/** Whether a stored first-row value holds the wake text: a settled value's `text`, or a pending value's `pending` (1.8.1). */
export const isWakeValue = (cur: LastQuestion): boolean => cur !== null && ('uuid' in cur ? cur.text === WAKE_TEXT : isWakeText(cur.pending))

/**
 * The questions the person typed in `rows`, newest first (uuid and clean first line): not a tool result, a compaction summary, a
 * notification or peer wrapper (a tag the person typed is fine), and not the wake text (its shown text, `isWakeText`).
 */
export function typedQuestions(rows: readonly SessionMessage[]): EarlierQuestion[] {
  const found: EarlierQuestion[] = []
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row === undefined || !isQuestionRow(row)) continue
    const clean = cleanPrompts([row.text])[0]
    if (clean === undefined || clean.startsWith(SUMMARY_PREFIX) || PEER_WRAPPER.test(row.text.trimStart())) continue
    const text = firstLine(clean)
    if (text === WAKE_TEXT) continue
    found.push({ uuid: row.uuid, text })
  }
  return found
}

/** The newest `count` questions of `rows`, newest first. */
export const newestQuestions = (rows: readonly SessionMessage[], count: number): EarlierQuestion[] => typedQuestions(rows).slice(0, count)

/** The newest question of `rows`. */
export const newestQuestion = (rows: readonly SessionMessage[]): EarlierQuestion | undefined => typedQuestions(rows)[0]

/**
 * The questions before the one `anchor` names, newest first, at most `EARLIER_MAX`: first those of `rows` older than the row `anchor`
 * (none when that row is not in `rows`: they are all newer), then the entries of `kept` (what an older read saw, which a short read
 * cannot see again; an entry that holds the wake text is dropped). A uuid is listed once, and `anchor` never.
 */
export function earlierFrom(rows: readonly SessionMessage[], anchor: string, kept: readonly EarlierQuestion[]): EarlierQuestion[] {
  const at = rows.findIndex(row => row.uuid === anchor)
  const older = at === -1 ? [] : typedQuestions(rows.slice(0, at))
  const seen = new Set<string>([anchor])
  const list: EarlierQuestion[] = []
  for (const question of [...older, ...kept]) {
    if (seen.has(question.uuid) || question.text === WAKE_TEXT) continue
    seen.add(question.uuid)
    list.push(question)
    if (list.length === EARLIER_MAX) break
  }
  return list
}
