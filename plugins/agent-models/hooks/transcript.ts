// The pure part of reading the questions from the session's transcript FILE (1.9.0): the cut of a window of the file into lines with their
// byte ends, and the walk of the live chain (parentUuid back from the newest line, stopped by a compaction mark). The file's format is the
// engine's own, not a documented API: a line this file does not know is a line it does not use. Nothing here reads or writes state.
import { shownQuestion } from './questions'

/** What the walk needs of a line; `end` is the absolute byte offset after the line's newline. `shown`: the line is a question with this text. */
export type WalkLine = { uuid?: string; parent?: string; side: boolean; mark: boolean; shown?: string; end: number }
export type Found = { id: string; text: string; end: number }
/** `needsMore`: the walk ran out of lines in a window that does not start the file, with no mark seen. */
export type Walk = { questions: Found[]; needsMore: boolean; isRecognised: boolean }

const encoder = new TextEncoder()

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// A string, or the text blocks of a list with no tool result; undefined for anything else.
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  let text = ''
  for (const block of content) {
    if (!isRecord(block) || block.type === 'tool_result') return undefined
    if (block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

// The shown text of a line that is a question: a typed or accepted prompt the person's (`origin.kind` human), or an attachment line of a
// prompt queued while Claude worked. A meta line, a compaction summary, a slash command, a notification and the wake text are not.
function questionOf(j: Record<string, unknown>): string | undefined {
  if (j.type === 'user') {
    if (!isRecord(j.origin) || j.origin.kind !== 'human' || j.isMeta === true || j.isCompactSummary === true || !isRecord(j.message)) return undefined
    const raw = textOf(j.message.content)
    return raw === undefined ? undefined : shownQuestion(raw)
  }
  if (j.type !== 'attachment' || !isRecord(j.attachment)) return undefined
  const a = j.attachment
  if (a.type !== 'queued_command' || a.commandMode !== 'prompt' || !isRecord(a.origin) || a.origin.kind !== 'human') return undefined
  const raw = textOf(a.prompt)
  return raw === undefined ? undefined : shownQuestion(raw)
}

function parseLine(raw: string, end: number): WalkLine {
  try {
    const j: unknown = JSON.parse(raw)
    if (!isRecord(j) || typeof j.uuid !== 'string' || typeof j.type !== 'string') return { side: false, mark: false, end }
    const shown = questionOf(j)
    return {
      uuid: j.uuid,
      ...(typeof j.parentUuid === 'string' ? { parent: j.parentUuid } : {}),
      side: j.isSidechain === true,
      mark: j.type === 'system' && j.subtype === 'compact_boundary',
      ...(shown === undefined ? {} : { shown }),
      end,
    }
  } catch {
    return { side: false, mark: false, end } // a line that is not JSON: no use, but its bytes count
  }
}

/**
 * The lines of `text`, the bytes `offset` to `windowEnd` of the file. Byte ends are counted back from `windowEnd` with `TextEncoder` (a
 * text read gives UTF-16 text: its character counts are not bytes). The first line is dropped when the window may start inside it (`offset` above 0,
 * unless `atLineStart`); a last line with no newline is dropped (it is still being written), and its bytes are counted so the ends before it stay right.
 * Every line has a `uuid` or none; a line that is not JSON has none.
 */
export function cutLines(text: string, offset: number, windowEnd: number, atLineStart: boolean = offset === 0): WalkLine[] {
  const parts = text.split('\n')
  const tail = parts.pop() ?? '' // '' when the text ends on a newline; else the line being written
  let end = windowEnd - encoder.encode(tail).length
  const lines: WalkLine[] = []
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i] ?? ''
    lines.push(parseLine(part, end))
    end -= encoder.encode(part).length + 1
  }
  lines.reverse()
  return atLineStart ? lines : lines.slice(1)
}

/**
 * The live chain: from the newest line that has a `uuid` and is not a sidechain row, `parent` back through `lines`. It stops at a
 * compaction mark (nothing before it is walked), at a line with no parent, and at a parent that is not in `lines`; the last is
 * `needsMore` when `hasMore` (the window does not start the file). A row on another branch (a `/rewind`) is not on the chain.
 * `questions` are the question lines passed, newest first.
 */
export function walk(lines: readonly WalkLine[], hasMore: boolean): Walk {
  const byId = new Map<string, WalkLine>()
  let newest: WalkLine | undefined
  let isRecognised = false
  for (const line of lines) {
    if (line.uuid === undefined) continue
    isRecognised = true
    byId.set(line.uuid, line)
    if (!line.side) newest = line
  }
  const questions: Found[] = []
  const seen = new Set<string>() // a file that loops cannot loop the walk
  let needsMore = false
  for (let cur = newest; cur?.uuid !== undefined && !seen.has(cur.uuid) && !cur.mark; ) {
    seen.add(cur.uuid)
    if (cur.shown !== undefined) questions.push({ id: cur.uuid, text: cur.shown, end: cur.end })
    if (cur.parent === undefined) break
    const next = byId.get(cur.parent)
    if (next === undefined) {
      needsMore = hasMore
      break
    }
    cur = next
  }
  return { questions, needsMore, isRecognised }
}
