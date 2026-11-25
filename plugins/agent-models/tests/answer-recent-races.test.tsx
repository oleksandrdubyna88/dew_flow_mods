import { expect, test } from 'claude-code/testing'

import { start } from './account-fixtures'
import { answer, gate, held, KEY, session, spin, typed, valueOf } from './answer-fixtures'
import { ask, entries, heldEarlier, labels, lastEarlier, opened, Q, recent, uuids } from './answer-recent-fixtures'
import type { Entry } from './answer-recent-fixtures'

// The races of the 1.8.0 list (L12 to L15; the draw and the rebuilds are in answer-recent.test.tsx): a newer submit, a late write, a
// session end and a version miss, each at the moment one of the two writes of a settle waits.

const asked = async ($: Parameters<typeof ask>[0], s: Parameters<typeof ask>[1], ...names: string[]): Promise<void> => {
  for (const name of names) await ask($, s, name)
}
const end = ($: Parameters<typeof ask>[0]) => $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })

// --- L12 to L15: races ---

test('L12 a newer submit between the two writes of a settle: no question is lost', async ($, on) => {
  const s = session(on)
  const r = recent(on)
  const g = gate()
  let isHeld = false
  on('state.set', KEY, async (_, e, next) => {
    if (!isHeld && e.value !== null && 'uuid' in e.value && e.value.uuid === 'uD') {
      isHeld = true
      await g.wait // D's own write of lastQuestion waits; its earlierQuestions write has landed
    }
    return next(e)
  })
  await start($)
  await asked($, s, 'A', 'B', 'C')
  s.rows = [...s.rows, Q('D')]
  await typed($, 'D')
  expect(uuids(lastEarlier(r)), 'the earlier questions of D are written first').toEqual(['uC', 'uB', 'uA'])
  await ask($, s, 'E') // E is typed while D's last write waits
  g.release()
  await spin()
  expect(await held($, s)).toEqual({ uuid: 'uE', text: 'E' })
  expect(uuids(lastEarlier(r))).toEqual(['uD', 'uC', 'uB'])
  const ui = await opened($)
  expect(await labels(ui)).toEqual(['› E', '› D', '› C'])
  await ui.unmount()
})

test('L12b the earlierQuestions write of an older settle lands after a newer settle: it does not take the newer list back', async ($, on) => {
  const s = session(on)
  const g = gate()
  let isHeld = false
  const r = recent(on, {
    meddle: {
      hold: async write => {
        if (!isHeld && write[0]?.uuid === 'uC') {
          isHeld = true
          await g.wait // D's earlier write (C, B, A) waits
        }
      },
    },
  })
  await start($)
  await asked($, s, 'A', 'B', 'C')
  s.rows = [...s.rows, Q('D')]
  await typed($, 'D') // held at its earlier write
  await ask($, s, 'E') // E settles completely
  expect(await held($, s)).toEqual({ uuid: 'uE', text: 'E' })
  g.release()
  await spin()
  expect(await held($, s)).toEqual({ uuid: 'uE', text: 'E' })
  expect(await heldEarlier($, r), 'what the engine holds, before any list open rebuilds it').toEqual(entries('D', 'C', 'B'))
  const ui = await opened($)
  expect(await labels(ui), 'D is not lost').toEqual(['› E', '› D', '› C'])
  await ui.unmount()
})

test('L12c a session end while a settle\'s lastQuestion write waits: nothing is written after it', async ($, on) => {
  const s = session(on)
  const r = recent(on)
  const g = gate()
  let isHeld = false
  on('state.set', KEY, async (_, e, next) => {
    if (!isHeld && e.value !== null && 'uuid' in e.value && e.value.uuid === 'uD') {
      isHeld = true
      await g.wait
    }
    return next(e)
  })
  await start($)
  await asked($, s, 'A', 'B', 'C')
  s.rows = [...s.rows, Q('D')]
  await typed($, 'D')
  await end($)
  await spin()
  expect(valueOf(s)).toBeNull()
  expect(lastEarlier(r)).toEqual([])
  const after = [s.writes.length, r.writes.length]
  g.release()
  await spin()
  expect(s.writes.slice(after[0]).every(w => w === null), 'only null after the end').toBe(true)
  expect(r.writes.slice(after[1]).every(w => w.length === 0), 'only empty lists after the end').toBe(true)
  expect(valueOf(s)).toBeNull()
  expect(lastEarlier(r)).toEqual([])
})

test('L12d a session end while a settle\'s earlierQuestions write waits: the list stays empty', async ($, on) => {
  const s = session(on)
  const g = gate()
  let isHeld = false
  const r = recent(on, {
    meddle: {
      hold: async write => {
        if (!isHeld && write[0]?.uuid === 'uC') {
          isHeld = true
          await g.wait
        }
      },
    },
  })
  await start($)
  await asked($, s, 'A', 'B', 'C')
  s.rows = [...s.rows, Q('D')]
  await typed($, 'D')
  await end($)
  await spin()
  expect(lastEarlier(r)).toEqual([])
  const after = [s.writes.length, r.writes.length]
  g.release()
  await spin()
  expect(s.writes.slice(after[0]).every(w => w === null), 'only null after the end').toBe(true)
  expect(r.writes.slice(after[1]).every(w => w.length === 0), 'only empty lists after the end').toBe(true)
  expect(await held($, s)).toBeNull()
})

test('L13 a long turn: an earlier question more than 50 rows back stays in the list after the next settle', async ($, on) => {
  const s = session(on)
  const r = recent(on)
  await start($)
  await asked($, s, 'A', 'B', 'C')
  s.rows = [...s.rows, ...Array.from({ length: 60 }, (_, i) => answer(`long${i}`))]
  await ask($, s, 'D') // the lookup reads the newest 50 rows: B and A are past them
  expect(valueOf(s)).toEqual({ uuid: 'uD', text: 'D' })
  expect(uuids(lastEarlier(r))).toEqual(['uC', 'uB', 'uA'])
  const ui = await opened($)
  expect(await labels(ui)).toEqual(['› D', '› C', '› B'])
  await ui.unmount()
})

test('L14 a draw between the two writes of a settle shows no question twice and none missing', async ($, on) => {
  const s = session(on)
  recent(on)
  const g = gate()
  let isHeld = false
  on('state.set', KEY, async (_, e, next) => {
    if (!isHeld && e.value !== null && 'uuid' in e.value && e.value.uuid === 'uD') {
      isHeld = true
      await g.wait
    }
    return next(e)
  })
  await start($)
  await asked($, s, 'A', 'B', 'C')
  const ui = await opened($)
  s.rows = [...s.rows, Q('D')]
  await typed($, 'D') // earlierQuestions is written (C, B, A); lastQuestion still says pending
  await ui.redraw()
  expect(s.read, 'what the engine holds').toEqual({ pending: 'D', previous: 'uC', previousText: 'C' })
  expect(await labels(ui), 'C once, B, A').toEqual(['› C (sending…)', '› B', '› A'])
  g.release()
  await spin()
  await ui.redraw()
  expect(await labels(ui)).toEqual(['› D', '› C', '› B'])
  await ui.unmount()
})

test('L15 the change function runs again on a version miss: the written list comes from the run that landed', async ($, on) => {
  const s = session(on)
  const other: Entry[] = [{ uuid: 'uZ', text: 'Z' }]
  let misses = 0
  const r = recent(on, {
    meddle: {
      miss: () => {
        if (misses > 0) return undefined
        misses = 1
        return other // another write landed between the read and this write: this one misses and the change function runs again on it
      },
    },
  })
  await start($)
  await asked($, s, 'A', 'B')
  expect(misses).toBe(1)
  expect(uuids(lastEarlier(r)), 'the list of the run that landed: it holds what the other write left (Z)').toEqual(['uA', 'uZ'])
})
