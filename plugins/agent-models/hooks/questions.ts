// The pure part of the `last answer` list's questions (hooks/answer.tsx, hooks/asked.ts, hooks/transcript.ts): what text the list shows for
// a question, which text is no question (the engine's own words, a peer's wrapper, a compaction summary, the wake text), and
// `typedQuestions`, the questions of `$.session.messages` rows (the fallback source of 1.9.0). Nothing here reads or writes state.
import type { SessionMessage } from 'claude-code'

import type { EarlierQuestion } from '../types'
import { cutText } from './pins'
import { cleanPrompts } from './prompts'
import { WAKE_TEXT } from './wake'

export const SUMMARY_PREFIX = 'This session is being continued from a previous conversation'
const PEER_WRAPPER = /^<(?:teammate-message|agent-message)[\s>]/ // another agent's words: `cleanPrompts` drops only the engine's own tags

const isQuestionRow = (m: SessionMessage): m is SessionMessage & { uuid: string } =>
  m.role === 'user' && (m.toolResults?.length ?? 0) === 0 && typeof m.uuid === 'string'

// The list's text: the first line of the clean question, spaces collapsed, cut. The owner's own marks stay (it is no markdown block).
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

/**
 * The text the list shows for a prompt the person typed, or undefined when it is no question: empty once clean, an engine wrapper, a
 * notification, a peer's wrapper, a compaction summary, or the wake text (its shown text, `isWakeText`).
 */
export function shownQuestion(raw: string): string | undefined {
  const clean = cleanPrompts([raw])[0]
  if (clean === undefined || clean.startsWith(SUMMARY_PREFIX) || PEER_WRAPPER.test(raw.trimStart())) return undefined
  const shown = firstLine(clean)
  return shown === WAKE_TEXT ? undefined : shown
}

/**
 * The questions the person typed in `rows`, newest first (uuid and clean first line): not a tool result, a compaction summary, a
 * notification or peer wrapper (a tag the person typed is fine), and not the wake text.
 */
export function typedQuestions(rows: readonly SessionMessage[]): EarlierQuestion[] {
  const found: EarlierQuestion[] = []
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row === undefined || !isQuestionRow(row)) continue
    const shown = shownQuestion(row.text)
    if (shown !== undefined) found.push({ uuid: row.uuid, text: shown })
  }
  return found
}
