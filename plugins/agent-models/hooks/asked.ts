// The questions of the `last answer` list (1.9.0). They come from the session's transcript FILE, read from its end: the file holds both
// kinds of question (typed while Claude was idle, and typed while it worked), in order, with the id the screen draws, and it marks
// compactions and rewinds (the pure parts: hooks/transcript.ts). A submit the file does not hold yet is a `pending` entry; the first
// refresh that finds a question line after the entry's `from` settles it. This file owns the atoms (the engine's scan reads `read($, x)`
// only for an atom written in the same file), and every function that takes `$` is a function declaration (an arrow taking `$` is
// refused across an import). A draw never writes. Nothing here throws out of a hook.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, PromptSubmitResult, SessionMessage } from 'claude-code'

import type { AskedQuestion, EarlierQuestion, LastQuestion, PendingQuestion, Recent } from '../types'
import { ENTRY_CAP } from './prompts'
import { isWakeText, questionText, typedQuestions } from './questions'
import { cutLines, walk } from './transcript'
import type { Found, Walk, WalkLine } from './transcript'

export const WINDOW = 1_048_576 // the first read: the last 1 MiB of the file
export const DEEP = 4 * 1_048_576 - 16 // the one deeper read: the engine's per-read cap less 16 bytes (a U+FFFD at an edge makes the text longer than the bytes read, and the engine rejects an answer over the cap)
export const RECENT_MAX = 3
export const PENDING_MAX = 8
const EXPIRE_TURNS = 2 // main-loop turn ends a pending entry lives through
const ENGINE_ROWS = 50 // the engine list's newest rows the file's questions are checked against
const FALLBACK_ROWS = 200
export const FALLBACK_TOAST = 'last answer: transcript format not recognised — showing what the engine lists'
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge'])

const recent = atom({ plugin: 'agent-models', key: 'recent' } as const, null as Recent | null)
const pending = atom({ plugin: 'agent-models', key: 'pending' } as const, [] as readonly PendingQuestion[])
// 1.5.0-1.8.1 kept the questions here: nothing reads or writes them any more but the clear at a session end.
const lastQuestion = atom({ plugin: 'agent-models', key: 'lastQuestion' } as const, null as LastQuestion)
const earlierQuestions = atom({ plugin: 'agent-models', key: 'earlierQuestions' } as const, [] as readonly EarlierQuestion[])

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isAsked = (v: unknown): v is AskedQuestion => isRecord(v) && typeof v.id === 'string' && typeof v.text === 'string'
const isPendingEntry = (v: unknown): v is PendingQuestion => isRecord(v) && typeof v.text === 'string' && typeof v.from === 'number' && typeof v.turns === 'number'
const recentOf = (v: unknown): Recent | null => (isRecord(v) && Array.isArray(v.questions) && typeof v.size === 'number' ? { questions: v.questions.filter(isAsked), size: v.size } : null)
const pendingOf = (v: unknown): readonly PendingQuestion[] => (Array.isArray(v) ? v.filter(isPendingEntry) : []) // a state stored before 1.9.0 has none

/** The list's questions now, newest first; none when the read is refused or nothing was read yet. */
export async function currentRecent($: EngineInterface): Promise<readonly AskedQuestion[]> {
  try {
    return recentOf(await read($, recent))?.questions ?? []
  } catch {
    return []
  }
}

/** The submitted questions the file does not hold yet, oldest first; none when the read is refused. */
export async function currentPending($: EngineInterface): Promise<readonly PendingQuestion[]> {
  try {
    return pendingOf(await read($, pending))
  } catch {
    return []
  }
}

// --- the file: a cache of parsed lines, the window, the one deeper read ---

type Cache = { path: string; end: number; hasMore: boolean; isDeep: boolean; lines: WalkLine[] } // `end`: the byte after the last whole line; `hasMore`: the file has bytes before the first line
let cache: Cache | undefined // a reload starts it empty
let isBusy = false // one refresh at a time
let endEpoch = 0 // the session ends this module saw: a refresh or a submit that began before one writes nothing
let isToldFallback = false // one toast per session

async function textRead($: EngineInterface, path: string, offset: number, length: number): Promise<string> {
  const text = length > 0 ? await $.fs.read(path, { offset, length }) : ''
  if (typeof text !== 'string') throw new Error('the file read gave no text')
  return text
}

async function fresh($: EngineInterface, path: string, size: number, span: number): Promise<Cache> {
  const offset = Math.max(0, size - span)
  const lines = cutLines(await textRead($, path, offset, size - offset), offset, size)
  return { path, end: lines.at(-1)?.end ?? offset, hasMore: offset > 0, isDeep: span === DEEP, lines }
}

// The cache and the new bytes after it (only those); the whole window again when the path changed, the file got smaller or grew by more than a window.
async function load($: EngineInterface, path: string, size: number): Promise<Cache> {
  const c = cache
  if (c === undefined || c.path !== path || size < c.end || size - c.end > WINDOW) return fresh($, path, size, WINDOW)
  if (size === c.end) return c
  const added = cutLines(await textRead($, path, c.end, size - c.end), c.end, size, true)
  const all = [...c.lines, ...added]
  const kept = all.filter(line => line.end > size - DEEP) // the cache keeps no more than the deeper read would
  return { ...c, end: added.at(-1)?.end ?? c.end, hasMore: c.hasMore || kept.length < all.length, lines: kept }
}

async function walked($: EngineInterface, path: string, size: number): Promise<{ walk: Walk; hasLines: boolean }> {
  let c = await load($, path, size)
  cache = c
  let result = walk(c.lines, c.hasMore)
  if (result.needsMore && result.questions.length < RECENT_MAX && !c.isDeep) { // ONE deeper read: the window ended before three questions and no mark
    try {
      const deeper = await fresh($, path, size, DEEP)
      cache = deeper
      c = deeper
      result = walk(c.lines, c.hasMore)
    } catch {
      // a refused deeper read keeps what the window gave
    }
  }
  return { walk: result, hasLines: c.lines.length > 0 }
}

// --- the fallback: what the engine lists (the 1.8.1 source) ---

async function engineRows($: EngineInterface, last: number): Promise<readonly SessionMessage[]> {
  try {
    const rows = await $.session.messages({ last })
    return Array.isArray(rows) ? rows : [] // a deny is no rows
  } catch {
    return []
  }
}

async function fallbackList($: EngineInterface): Promise<AskedQuestion[]> {
  let rows = await engineRows($, FALLBACK_ROWS)
  let found = typedQuestions(rows)
  if (found.length < RECENT_MAX && rows.length >= FALLBACK_ROWS) {
    rows = await engineRows($, ENTRY_CAP)
    found = typedQuestions(rows)
  }
  return found.slice(0, RECENT_MAX).map(q => ({ id: q.uuid, text: q.text }))
}

async function tellFallback($: EngineInterface): Promise<void> {
  if (isToldFallback) return
  isToldFallback = true
  try {
    await $.ui.toast(FALLBACK_TOAST)
  } catch {
    // no toast: the list still shows what the engine lists
  }
}

// --- the refresh ---

/** What a read saw: the list, the file length, and the questions of the whole chain with their line ends (none when the list is the engine's). */
type Seen = { list: AskedQuestion[]; size: number | undefined; chain: readonly Found[] | undefined }

async function engineSeen($: EngineInterface, size: number | undefined): Promise<Seen> {
  const list = await fallbackList($)
  if (list.length > 0) await tellFallback($) // a file with no line of ours yet (a session before its first prompt) and an empty engine list: nothing to say
  return { list, size, chain: undefined }
}

// An engine-listed typed question the walk did not list is a format miss only when the file cannot say why: its line is not in a window that should hold
// it, or it is a user line with no `origin` (an older format). A line the filter rejected for a known reason (a peer's, a skill body, a meta line, a
// command) is no typed question: the next newest row is looked at. The first row the walk did list ends the check.
function isFormatMiss(typed: readonly { uuid: string }[], chain: Walk): boolean {
  if (chain.needsMore) return false // the window may not reach it
  for (const q of typed) {
    if (chain.questions.some(found => found.id === q.uuid)) return false
    const line = chain.byId.get(q.uuid)
    if (line === undefined || line.legacy === true) return true
  }
  return false
}

// Undefined: a refused or failed read, which changes nothing. A session that keeps no file, a window the walk does not recognise, and a newest
// typed question of the engine's list that is not on the walked chain (a renamed field, an older file) are the fallback. The engine list is read
// BEFORE the file, so a line the engine already listed is in the file the read saw.
async function look($: EngineInterface, isTick: boolean): Promise<Seen | undefined> {
  let path: string
  let size: number
  try {
    const info = await $.session.info()
    path = info.transcriptPath
    if (typeof path !== 'string') return undefined
    if (path === '') return await engineSeen($, undefined)
    size = (await $.fs.stat(path)).size
    if (typeof size !== 'number') return undefined
  } catch {
    return undefined
  }
  const typed = isTick ? [] : typedQuestions(await engineRows($, ENGINE_ROWS)) // the tick looks at the file only: the engine list is read at the list open, the session start and the turn events
  let seen: { walk: Walk; hasLines: boolean }
  try {
    seen = await walked($, path, size)
  } catch {
    return undefined
  }
  const { walk: chain, hasLines } = seen
  if ((hasLines && !chain.isRecognised) || isFormatMiss(typed, chain)) return engineSeen($, size)
  return { list: chain.questions.slice(0, RECENT_MAX).map(({ id, text }) => ({ id, text })), size, chain: chain.questions }
}

const sameList = (a: readonly PendingQuestion[], b: readonly PendingQuestion[]): boolean => JSON.stringify(a) === JSON.stringify(b)

// What the questions settle of the oldest entry: `count` of them (the questions whose line ends after its `from`; with the engine's list the
// questions new to the list) and `end`, the byte end of the last line they used (0 with the engine's list).
type Settle = (from: number) => { count: number; end: number }

// The entries after a refresh: the oldest k are settled (first come first matched, no text compared). A line settles ONE entry: the entries
// that stay start after the last line used. `ends` turn ends since the last refresh count a turn for the rest, and an entry at two goes.
function settled(cur: readonly PendingQuestion[], settle: Settle, ends: number): readonly PendingQuestion[] {
  const first = cur[0]
  const { count, end } = first === undefined ? { count: 0, end: 0 } : settle(first.from)
  const rest = cur.slice(count).map(p => (p.from < end ? { ...p, from: end } : p))
  return ends > 0 ? rest.map(p => ({ ...p, turns: p.turns + ends })).filter(p => p.turns < EXPIRE_TURNS) : rest
}

let turnEnds = 0 // the main-loop turn ends not yet counted for the pending entries: a refresh that was busy does not lose one

/**
 * Reads the file (or, in the fallback, the engine's list), writes `recent` and settles `pending`. At a turn's end (`isTurnEnd`, main loop) the entries
 * that did not settle count a turn: the turn end is kept in a counter, which this refresh or the next one applies. `isTick`: the engine list is not
 * read. One refresh at a time: one asked while another runs is left (the tick comes again). Never rejects.
 */
export async function refreshRecent($: EngineInterface, opts: { isTurnEnd?: boolean; isTick?: boolean } = {}): Promise<void> {
  if (opts.isTurnEnd === true) turnEnds += 1
  if (isBusy) return
  isBusy = true
  const epoch = endEpoch
  try {
    const seen = await look($, opts.isTick === true)
    if (seen === undefined || epoch !== endEpoch) return
    const prior = recentOf(await read($, recent))
    const next: Recent = { questions: seen.list, size: seen.size ?? prior?.size ?? 0 }
    if (JSON.stringify(prior) !== JSON.stringify(next)) await update($, recent, cur => (epoch === endEpoch ? next : cur))
    const known = new Set(prior?.questions.map(q => q.id))
    const chain = seen.chain
    const settle: Settle = from => {
      if (chain === undefined) return { count: seen.list.filter(q => !known.has(q.id)).length, end: 0 }
      const used = chain.filter(q => q.end > from)
      return { count: used.length, end: Math.max(0, ...used.map(q => q.end)) }
    }
    const held = pendingOf(await read($, pending))
    const ends = turnEnds
    if (epoch === endEpoch && !sameList(held, settled(held, settle, ends))) {
      turnEnds -= ends
      try {
        await update($, pending, cur => (epoch === endEpoch ? settled(pendingOf(cur), settle, ends) : cur))
      } catch (error) {
        turnEnds += ends // the write was refused: the turn ends are still to count
        throw error
      }
    } else if (held.length === 0) turnEnds = 0 // nothing pending: no entry to count them for
  } catch {
    // a refused read or write: what stands stays; the next refresh tries again
  } finally {
    isBusy = false
  }
}

// The file's length now: from a stat; the last read's when the stat is refused; undefined when neither is known.
async function sizeNow($: EngineInterface): Promise<number | undefined> {
  try {
    const { transcriptPath } = await $.session.info()
    const { size } = await $.fs.stat(transcriptPath)
    if (typeof size === 'number') return size
  } catch {
    // the stat is refused: the last read's size stands in
  }
  try {
    return recentOf(await read($, recent))?.size
  } catch {
    return undefined
  }
}

/** The file's length, asked BEFORE the engine's bottom of a `prompt.submit` runs: an idle prompt's line can be in the file by the time the hook returns. Never rejects. */
export function submitSize($: EngineInterface): Promise<number | undefined> {
  return sizeNow($)
}

/**
 * After `next(e)` of a `prompt.submit` (`at`: `submitSize`, asked before it): a prompt the person typed (here or through the bridge) is a `pending` entry until the file holds
 * its line. A notification, a peer, a plugin, a meta prompt, a slash command, the wake text and a dropped prompt are none. Never rejects.
 */
export async function noteSubmit($: EngineInterface, e: PromptSubmitInput, result: PromptSubmitResult, at: Promise<number | undefined>): Promise<void> {
  try {
    if (result.drop !== undefined || e.command !== undefined || e.isMeta === true || !PERSON_ORIGINS.has(e.origin.kind)) return
    const text = questionText(result.text)
    if (text === undefined || isWakeText(result.text)) return // the wake text is never a question, typed or sent
    const epoch = endEpoch
    const from = await at
    if (from === undefined || epoch !== endEpoch) return // no size known: no entry (it could never be settled)
    await update($, pending, cur => (epoch === endEpoch ? [...pendingOf(cur), { text, from, turns: 0 }].slice(-PENDING_MAX) : cur))
  } catch {
    // a refused read or write: no entry; the question shows when the file holds it
  }
}

/** The 2 s tick: a look at the file while the list is open or something is pending, and a refresh only when the file grew. Never rejects. */
export async function tickAsked($: EngineInterface, isListOpen: boolean): Promise<void> {
  try {
    if (!isListOpen && pendingOf(await read($, pending)).length === 0) return
    const size = (await $.fs.stat((await $.session.info()).transcriptPath)).size
    const prior = recentOf(await read($, recent))
    if (prior === null || prior.size !== size) await refreshRecent($, { isTick: true })
  } catch {
    // the next tick looks again
  }
}

async function swallow(write: Promise<unknown>): Promise<void> {
  try {
    await write
  } catch {
    // a refused write: the next session's refresh replaces the value
  }
}

/** At a session end (a `/clear` raises no `session.start`): the list, the pending entries and the atoms of 1.5.0-1.8.1 are cleared, and work in flight stops writing. Never rejects. */
export async function clearAsked($: EngineInterface): Promise<void> {
  endEpoch += 1
  cache = undefined
  isToldFallback = false
  turnEnds = 0
  await Promise.all([
    swallow(update($, recent, () => null)),
    swallow(update($, pending, () => [])),
    swallow(update($, lastQuestion, () => null)),
    swallow(update($, earlierQuestions, () => [])),
  ])
}
