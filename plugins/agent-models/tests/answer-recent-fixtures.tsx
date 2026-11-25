import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

import { band as bandOf } from './account-fixtures'
import type { Ui } from './account-fixtures'
import { answer, KEY, question, typed } from './answer-fixtures'
import type { Session } from './answer-fixtures'

// The helpers of the recent-questions tests (answer-recent.test.tsx, 1.8.0): the list's second to fourth rows, the stored
// `earlierQuestions`, and every write of it. Not a test file.

export type Entry = { uuid: string; text: string }

/** A transcript row the person typed: its uuid is `u` plus its text, so a test names a question by its text alone. */
export const Q = (name: string): SessionMessage => question(name, `u${name}`)
export const uuidOf = (name: string): string => `u${name}`
export const entry = (name: string): Entry => ({ uuid: uuidOf(name), text: name })
export const entries = (...names: string[]): Entry[] => names.map(entry)

/** The stored `earlierQuestions` as the engine answered it: an unknown value checked field by field, never cast. */
const entriesOf = (v: unknown): Entry[] => {
  if (!Array.isArray(v)) return []
  const out: Entry[] = []
  for (const item of v) {
    if (typeof item === 'object' && item !== null && 'uuid' in item && typeof item.uuid === 'string' && 'text' in item && typeof item.text === 'string') {
      out.push({ uuid: item.uuid, text: item.text })
    }
  }
  return out
}

export type Recent = {
  writes: Entry[][] // every write of `earlierQuestions`, in order
  log: string[] // `lastQuestion` and `earlierQuestions` in the order the mod wrote them
  read: Entry[] // what the newest read of `earlierQuestions` answered
  seed: Entry[] | undefined // a value the session already holds (a reload kept it): read until the first write
}

export const EARLIER_KEY = { plugin: 'agent-models', key: 'earlierQuestions' } as const

/**
 * What a test does to a write of `earlierQuestions` before the engine takes it: `before` is awaited (a gate holds the write), and `put`
 * writes another value in at once, with no version condition (another writer got in between, so the held write then misses).
 */
export type Before = (write: readonly Entry[], put: (value: readonly Entry[]) => Promise<unknown>) => Promise<void> | void

/** Records every write and read of `earlierQuestions` (and the order of its writes among those of `lastQuestion`). */
export const recent = (on: On, o: { seed?: readonly Entry[]; before?: Before } = {}): Recent => {
  const r: Recent = { writes: [], log: [], read: [], seed: o.seed === undefined ? undefined : [...o.seed] }
  on('state.set', KEY, (_, e, next) => {
    r.log.push('lastQuestion')
    return next(e)
  })
  on('state.set', EARLIER_KEY, async (_, e, next) => {
    r.log.push('earlierQuestions')
    r.writes.push(entriesOf(e.value))
    r.seed = undefined
    await o.before?.(entriesOf(e.value), value => next({ ...e, value, ifVersion: undefined }))
    return next(e)
  })
  on('state.get', EARLIER_KEY, async (_, e, next) => {
    const result = r.seed === undefined ? await next(e) : { value: { value: r.seed, version: 0 } }
    r.read = entriesOf(result.value?.value)
    return result
  })
  return r
}

/** The newest `earlierQuestions` the mod wrote; undefined while it wrote none. */
export const lastEarlier = (r: Recent): Entry[] | undefined => r.writes.at(-1)
export const uuids = (list: readonly Entry[] | undefined): string[] | undefined => list?.map(x => x.uuid)

/** The person asks `name` (its row is in the transcript when the submit's lookup reads), then Claude answers. */
export const ask = async ($: Engine, s: Session, name: string): Promise<void> => {
  s.rows = [...s.rows, Q(name)]
  await typed($, name)
  s.rows = [...s.rows, answer(`a${name}`)]
}

/** The band, with the `last answer` list opened by the button. */
export const opened = async ($: Engine): Promise<Ui> => {
  const ui = await bandOf($)
  await ui.press({ key: 'last-answer' })
  await ui.redraw()
  return ui
}

/** The keys the list draws, in the order of the tree: the question rows, the separator, the pins. */
export const listKeys = async (ui: Ui): Promise<string[]> =>
  (await ui.findAll({})).flatMap(node => {
    const key = node.key
    if (key === undefined) return []
    return key === 'answer-last' || key.startsWith('answer-earlier-') || key === 'answer-separator' || key.startsWith('pin-go-') ? [key] : []
  })

/** The questions rows' labels, in order. */
export const labels = async (ui: Ui): Promise<string[]> =>
  (await ui.findAll({ type: 'Button' })).flatMap(node => {
    const key = node.key
    return key !== undefined && (key === 'answer-last' || key.startsWith('answer-earlier-')) ? [String(node.props.label)] : []
  })
