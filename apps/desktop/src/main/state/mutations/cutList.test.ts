// apps/desktop/src/main/state/mutations/cutList.test.ts
import { describe, it, expect } from 'vitest'
import { CommandFailure } from '../errors'
import { validateKeepRanges, planCutList, type KeepRange } from './cutList'

const layer = { id: 'L', t_start_us: 0, t_end_us: 10_000_000 }
const ident = (t: number): number => t

function refuse(fn: () => unknown): { field: string; detail: string } {
  try { fn() } catch (e) {
    if (e instanceof CommandFailure && e.err.error === 'InvalidArgument')
      return e.err as { field: string; detail: string }
    throw e
  }
  throw new Error('expected an InvalidArgument refusal')
}

describe('validateKeepRanges', () => {
  it('refuses an empty list, degenerate spans, and out-of-bounds ranges', () => {
    expect(refuse(() => validateKeepRanges(layer, [])).field).toBe('keep_ranges')
    expect(refuse(() => validateKeepRanges(layer, [{ t_start_us: 5, t_end_us: 5 }])).field).toBe('keep_ranges[0]')
    expect(refuse(() => validateKeepRanges(layer, [{ t_start_us: -1, t_end_us: 5 }])).detail).toMatch(/outside layer/)
    expect(refuse(() => validateKeepRanges(layer, [{ t_start_us: 5, t_end_us: 11_000_000 }])).detail).toMatch(/outside layer/)
    expect(refuse(() => validateKeepRanges(layer, [{ t_start_us: 1.5, t_end_us: 5 }])).detail).toMatch(/integer/)
  })
  it('refuses overlaps but allows touching ranges, sorted either way', () => {
    expect(refuse(() => validateKeepRanges(layer, [
      { t_start_us: 0, t_end_us: 5_000_000 },
      { t_start_us: 4_000_000, t_end_us: 8_000_000 },
    ])).detail).toMatch(/overlaps/)
    const touching = validateKeepRanges(layer, [
      { t_start_us: 4_000_000, t_end_us: 8_000_000 },
      { t_start_us: 0, t_end_us: 4_000_000 },
    ])
    expect(touching.map((r) => r.t_start_us)).toEqual([0, 4_000_000])
  })
})

describe('planCutList', () => {
  it('cuts interior edges and discards by midpoint, labelling survivors', () => {
    const keeps: KeepRange[] = [
      { t_start_us: 1_000_000, t_end_us: 3_000_000, label: 'a' },
      { t_start_us: 6_000_000, t_end_us: 9_000_000 },
    ]
    const plan = planCutList(layer, keeps, ident)
    expect(plan.cuts).toEqual([1_000_000, 3_000_000, 6_000_000, 9_000_000])
    // Nominal segments [0,1) [1,3) [3,6) [6,9) [9,10): keep 1 and 3.
    expect(plan.discard).toEqual([0, 2, 4])
    expect([...plan.labels]).toEqual([[1, 'a']])
  })
  it('a keep covering the whole layer plans no cuts', () => {
    const plan = planCutList(layer, [{ t_start_us: 0, t_end_us: 10_000_000, label: 'all' }], ident)
    expect(plan).toEqual({ cuts: [], discard: [], labels: new Map([[0, 'all']]) })
  })
  it('drops grid-collapsed edges and refuses a list that keeps nothing', () => {
    // Every edge snaps onto the layer head: no cuts, one nominal segment whose
    // midpoint the range does not hold — the list is a delete, not an apply.
    expect(refuse(() => planCutList(layer, [{ t_start_us: 8_000_000, t_end_us: 9_000_000 }], () => 0)).field)
      .toBe('keep_ranges')
  })
  it('dedupes a shared edge and snaps before comparing interiority', () => {
    const keeps: KeepRange[] = [
      { t_start_us: 0, t_end_us: 2_000_000 },
      { t_start_us: 2_000_000, t_end_us: 10_000_000 },
    ]
    // 2_000_000 snaps onto the layer end: the touching pair merges whole.
    expect(planCutList(layer, keeps, (t) => (t === 2_000_000 ? 10_000_000 : t)))
      .toEqual({ cuts: [], discard: [], labels: new Map() })
  })
})
