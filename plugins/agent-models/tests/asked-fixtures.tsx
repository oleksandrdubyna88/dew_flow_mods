import type { Engine } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On, PromptOrigin, PromptSubmitInput, SessionMessage } from 'claude-code'

import { band as bandOf, base, identities, identityOf, ok, spin, statusRuns } from './account-fixtures'
import type { Ui } from './account-fixtures'
import { BAND } from './limits-fixtures'

// The helpers of the 1.9.0 question tests: a transcript FILE the test owns (JSONL built from invented text, in the shapes the
// engine writes: a typed question, a queued one, a compaction mark), the engine calls that reach it (`session.info`, `fs.stat`,
// `fs.read`, with every call recorded), the state the mod keeps (`recent`, `pending`, the old atoms), the toasts and the scrolls.
// No text here comes from a real session. Not a test file.

export { spin }

export const PATH = '/work/sessions/s1.jsonl'
export const MIB = 1_048_576
export const COMPOSER: PromptOrigin = { kind: 'composer' }
export const SCROLL_REJECTED = 'no implementation for ui.scroll'
export const NOT_DRAWN = 'nothing drawn under that requestId'
type Key = 'recent' | 'pending' | 'lastQuestion' | 'earlierQuestions'

/** A real macrotask wait (the lib has no timer types, so the timer is read off `globalThis` and checked, never cast). */
export const macrotask = (ms: number): Promise<void> =>
  new Promise<void>(resolve => {
    const later: unknown = Reflect.get(globalThis, 'setTimeout')
    if (typeof later === 'function') later(resolve, ms)
    else resolve()
  })

/** A promise the test opens later: a handler that awaits `wait` holds its call until `release()`. */
export const gate = (): { wait: Promise<void>; release: () => void } => {
  let release: () => void = () => undefined
  const wait = new Promise<void>(resolve => {
    release = resolve
  })
  return { wait, release: () => release() }
}

export type ReadCall = { offset: number | undefined; length: number | undefined }
export type Write = { key: Key; value: unknown }
export type Asked = { id: string; text: string }
export type PendingRow = { text: string; from: number; turns: number }

export type World = {
  clock: MockClock
  bytes: Uint8Array // the transcript file
  path: string // what `session.info` answers; '' for a session that keeps no file
  isInfoRefused: boolean
  isStatRefused: boolean
  isReadRefused: boolean
  isMessagesBroken: boolean
  messages: SessionMessage[] // what `$.session.messages` answers (the fallback source)
  drop: string | undefined // a prompt with this text is dropped by the engine's own bottom
  infos: number
  stats: number
  reads: ReadCall[]
  messageReads: number
  toasts: string[]
  writes: Write[] // every write of the mod's four atoms, in order
  seeds: Partial<Record<Key, unknown>> // a stored value the session already holds (a reload kept it): read until the first write
  refusedKeys: Set<Key> // a write of this atom is refused
  holdRead: Promise<void> | undefined // the next `fs.read` waits for this (once)
  holdStat: Promise<void> | undefined // the next `fs.stat` waits for this (once)
  append: (line: Record<string, unknown>) => void
  appendRaw: (text: string) => void
  size: () => number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The engine under the mod for the question tests. `$.session.start` is called by the test (`start`). */
export const world = (on: On): World => {
  const clock = base(on)
  const w: World = {
    clock, bytes: new Uint8Array(0), path: PATH, isInfoRefused: false, isStatRefused: false, isReadRefused: false, isMessagesBroken: false,
    messages: [], drop: undefined, infos: 0, stats: 0, reads: [], messageReads: 0, toasts: [], writes: [],
    seeds: {}, refusedKeys: new Set(), holdRead: undefined, holdStat: undefined,
    appendRaw: text => {
      const add = encoder.encode(text)
      const next = new Uint8Array(w.bytes.length + add.length)
      next.set(w.bytes)
      next.set(add, w.bytes.length)
      w.bytes = next
    },
    append: line => w.appendRaw(`${JSON.stringify(line)}\n`),
    size: () => w.bytes.length,
  }
  identities(on, [() => identityOf('dev@example.com')])
  statusRuns(on, () => ok(JSON.stringify({ loggedIn: false })))
  on('prompt.submit', (_, e) => (e.text === w.drop ? { drop: 'refused' } : { text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.info', () => {
    w.infos += 1
    return w.isInfoRefused ? { deny: 'refused' } : { value: { transcriptPath: w.path } }
  })
  on('fs.stat', async () => {
    w.stats += 1
    const held = w.holdStat
    w.holdStat = undefined
    await held
    return w.isStatRefused ? { deny: 'refused' } : { value: { kind: 'file', size: w.bytes.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', async (_, e) => {
    w.reads.push({ offset: e.offset, length: e.length })
    const held = w.holdRead
    w.holdRead = undefined
    await held
    if (w.isReadRefused) return { deny: 'refused' }
    const from = e.offset ?? 0
    const to = e.length === undefined ? w.bytes.length : from + e.length
    return { value: decoder.decode(w.bytes.slice(from, to)) } // a cut character becomes U+FFFD, as the engine's text read gives
  })
  on('session.messages', () => {
    w.messageReads += 1
    if (w.isMessagesBroken) throw new Error('no transcript')
    return { value: w.messages }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  const isWritten = new Set<Key>()
  const seeded = (key: Key): boolean => key in w.seeds && !isWritten.has(key)
  const answer = (key: Key) => ({ value: { value: w.seeds[key], version: 0 } })
  const record = (key: Key, value: unknown): boolean => {
    w.writes.push({ key, value: JSON.parse(JSON.stringify(value)) })
    if (w.refusedKeys.has(key)) return false
    isWritten.add(key)
    return true
  }
  // one pair of hooks per atom (the keyed form: the other helpers' hooks are keyed too, and an unkeyed one would clash with theirs)
  on('state.get', { plugin: 'agent-models', key: 'recent' } as const, (_, e, next) => (seeded('recent') ? answer('recent') : next(e)))
  on('state.set', { plugin: 'agent-models', key: 'recent' } as const, (_, e, next) => (record('recent', e.value) ? next(e) : { deny: 'refused' }))
  on('state.get', { plugin: 'agent-models', key: 'pending' } as const, (_, e, next) => (seeded('pending') ? answer('pending') : next(e)))
  on('state.set', { plugin: 'agent-models', key: 'pending' } as const, (_, e, next) => (record('pending', e.value) ? next(e) : { deny: 'refused' }))
  on('state.get', { plugin: 'agent-models', key: 'lastQuestion' } as const, (_, e, next) => (seeded('lastQuestion') ? answer('lastQuestion') : next(e)))
  on('state.set', { plugin: 'agent-models', key: 'lastQuestion' } as const, (_, e, next) => (record('lastQuestion', e.value) ? next(e) : { deny: 'refused' }))
  on('state.get', { plugin: 'agent-models', key: 'earlierQuestions' } as const, (_, e, next) => (seeded('earlierQuestions') ? answer('earlierQuestions') : next(e)))
  on('state.set', { plugin: 'agent-models', key: 'earlierQuestions' } as const, (_, e, next) => (record('earlierQuestions', e.value) ? next(e) : { deny: 'refused' }))
  return w
}

// --- reading what the mod holds ---

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
/** The newest value of an atom: the last write, else the seed; undefined when it has neither. */
export const stored = (w: World, key: Key): unknown => {
  const written = w.writes.filter(x => x.key === key).at(-1)
  return written === undefined ? w.seeds[key] : written.value
}
export const recentOf = (w: World): { questions: Asked[]; size: number } | undefined => {
  const v = stored(w, 'recent')
  if (!isRecord(v) || !Array.isArray(v.questions) || typeof v.size !== 'number') return undefined
  const questions: Asked[] = []
  for (const q of v.questions) if (isRecord(q) && typeof q.id === 'string' && typeof q.text === 'string') questions.push({ id: q.id, text: q.text })
  return { questions, size: v.size }
}
/** The ids of `recent`, newest first; [] while there is none. */
export const ids = (w: World): string[] => recentOf(w)?.questions.map(q => q.id) ?? []
export const pendingOf = (w: World): PendingRow[] => {
  const v = stored(w, 'pending')
  if (!Array.isArray(v)) return []
  const out: PendingRow[] = []
  for (const p of v) if (isRecord(p) && typeof p.text === 'string' && typeof p.from === 'number' && typeof p.turns === 'number') out.push({ text: p.text, from: p.from, turns: p.turns })
  return out
}
/** The writes of one atom. */
export const writesOf = (w: World, key: Key): unknown[] => w.writes.filter(x => x.key === key).map(x => x.value)

// --- building the transcript file: lines in the shapes of the engine's own, with invented text ---

type Line = Record<string, unknown>
export type Script = ReturnType<typeof script>

/** Appends lines to the world's file; every line's `parentUuid` is the line before it (`at(id)` moves the head: a rewound branch). */
export const script = (w: World) => {
  let head: string | null = null
  let tick = 0
  const put = (uuid: string, extra: Line): string => {
    tick += 1
    w.append({ uuid, parentUuid: head, isSidechain: false, timestamp: new Date(1_700_000_000_000 + tick * 1000).toISOString(), ...extra })
    head = uuid
    return uuid
  }
  const user = (uuid: string, content: unknown, extra: Line = {}): string => put(uuid, { type: 'user', message: { role: 'user', content }, ...extra })
  return {
    /** A question typed while Claude was idle. */
    typed: (uuid: string, text: string): string => user(uuid, text, { origin: { kind: 'human' }, promptSource: 'typed' }),
    /** A question typed while Claude worked: an attachment line of its own. */
    queued: (uuid: string, text: string): string =>
      put(uuid, { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: text, origin: { kind: 'human' }, source_uuid: `${uuid}-src` } }),
    assistant: (uuid: string): string => put(uuid, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] } }),
    /** An assistant line of about `chars` characters (padding that pushes a question out of a window). */
    big: (uuid: string, chars: number, ch = 'x'): string => put(uuid, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ch.repeat(chars) }] } }),
    toolResult: (uuid: string): string => user(uuid, [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }]),
    meta: (uuid: string, text: string): string => user(uuid, text, { origin: { kind: 'human' }, isMeta: true }),
    summary: (uuid: string, text: string): string => user(uuid, text, { isCompactSummary: true }),
    slash: (uuid: string, name: string): string => user(uuid, `<command-name>${name}</command-name>`, { origin: { kind: 'human' } }),
    notification: (uuid: string): string => user(uuid, '<task-notification>a background task ended</task-notification>', { origin: { kind: 'task-notification' } }),
    peer: (uuid: string): string => user(uuid, '<teammate-message from="b">hello there</teammate-message>', { origin: { kind: 'peer' } }),
    /** A peer's wrapper that the file stamps as a human line: the wrapper alone says it is no question. */
    peerWrapped: (uuid: string): string => user(uuid, '<teammate-message from="b">hello there</teammate-message>', { origin: { kind: 'human' }, promptSource: 'typed' }),
    /** A prompt a plugin sent as the user: no origin. */
    sent: (uuid: string, text: string): string => user(uuid, text),
    /** A compaction mark: it starts a new chain (no parent) and names the line before it as its logical parent. */
    boundary: (uuid: string): string => {
      const before = head
      head = null
      return put(uuid, { type: 'system', subtype: 'compact_boundary', logicalParentUuid: before, compactMetadata: { trigger: 'auto', preservedSegment: { headUuid: `${uuid}-p1`, tailUuid: `${uuid}-p2` } } })
    },
    /** A line that is no part of the chain (a sidechain row). */
    side: (uuid: string, text: string): string => user(uuid, text, { origin: { kind: 'human' }, promptSource: 'typed', isSidechain: true }),
    at: (uuid: string | null): void => {
      head = uuid
    },
    head: (): string | null => head,
  }
}

// --- driving the session ---

export const start = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
}
/** Time for the work a hook left running unawaited: microtasks, then one real macrotask, then microtasks again. */
export const settle = async (): Promise<void> => {
  await spin()
  await macrotask(0)
  await spin()
}
export const submitOf = (text: string, origin: PromptOrigin = COMPOSER, extra: Partial<PromptSubmitInput> = {}): PromptSubmitInput => ({ text, wait: false, origin, ...extra })
/** The person's Enter, then time for the hook's work to end. */
export const typedIn = async ($: Engine, text: string, origin: PromptOrigin = COMPOSER, extra: Partial<PromptSubmitInput> = {}): Promise<void> => {
  await $.prompt.submit(submitOf(text, origin, extra))
  await settle()
}
export const turn = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
export const turnStart = async ($: Engine, extra: { agentId?: string } = {}): Promise<void> => {
  await $.turn.start({ text: 'x', turnId: 't2', ...extra })
  await settle()
}
export const turnComplete = async ($: Engine, extra: { agentId?: string } = {}): Promise<void> => {
  await $.turn.complete({ ...turn, ...extra })
  await settle()
}
export const endSession = async ($: Engine): Promise<void> => {
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await settle()
}
/** Moves the mock clock one tick of the mod's 2 s timer and lets the tick's work end. */
export const tickOnce = async (w: World): Promise<void> => {
  await macrotask(5) // the engine asks for the timer's next period a moment after the last one ran
  await w.clock.advance(2000)
  await settle()
}

// --- the list ---

export const band = async ($: Engine): Promise<Ui> => bandOf($)
/** The band with the `last answer` list opened by the button. */
export const opened = async ($: Engine): Promise<Ui> => {
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, isCollapsed: false }, surface: 'terminal', viewport: { columns: 80, rows: 24, isFullscreen: true } })
  await ui.press({ key: 'last-answer' })
  await settle()
  await ui.redraw()
  return ui
}
/** The keys the list draws, in the order of the tree: the question rows, the separator, the pins. */
export const listKeys = async (ui: Ui): Promise<string[]> =>
  (await ui.findAll({})).flatMap(node => {
    const key = node.key
    if (key === undefined) return []
    return key.startsWith('answer-q-') || key.startsWith('answer-pending-') || key === 'answer-separator' || key.startsWith('pin-go-') ? [key] : []
  })
/** The labels of the question rows, in order. */
export const labels = async (ui: Ui): Promise<string[]> =>
  (await ui.findAll({ type: 'Button' })).flatMap(node => {
    const key = node.key
    return key !== undefined && (key.startsWith('answer-q-') || key.startsWith('answer-pending-')) ? [String(node.props.label)] : []
  })
export const rowKey = (id: string): string => `answer-q-${id}`
