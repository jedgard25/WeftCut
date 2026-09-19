// apps/desktop/src/main/state/mutations/cutList.ts
// apply_cut_list's planning: user keep-ranges → nominal cuts + discards + labels.
//
// The plan is pure over the target layer's span (no draft, no ids), so the
// dispatch arm and the dry-run recipe share it, and the numbering the caller
// counted is the numbering `split_layer_multi` cuts: nominal segments run
// over the SNAPPED cut list, and discard/labels ride nominal indices through
// the arm's carrier map (which absorbs grid-collapsed cuts).
import { CommandFailure } from '../errors'
import type { Layer } from '../model'

/** One kept span, timeline-absolute µs, half-open `[t_start_us, t_end_us)`.
 *  `label` names the surviving segment (omit/null leaves it alone). */
export interface KeepRange {
  t_start_us: number
  t_end_us: number
  label?: string | null
}

/** What the actor cuts: snapped interior boundaries, nominal-segment indices
 *  to discard, and nominal-segment indices to label. */
export interface CutListPlan {
  cuts: number[]
  discard: number[]
  labels: Map<number, string>
}

/** Validate the wire shape of one keep range (integers, a positive span, a
 *  string-or-absent label). Bounds and overlaps need the layer and live in
 *  `validateKeepRanges`. */
function checkRangeShape(raw: unknown, i: number): KeepRange {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new CommandFailure({ error: 'InvalidArgument', field: `keep_ranges[${i}]`, detail: 'a keep range is { t_start_us, t_end_us, label? }' })
  const r = raw as Record<string, unknown>
  for (const f of ['t_start_us', 't_end_us'] as const) {
    if (typeof r[f] !== 'number' || !Number.isInteger(r[f]))
      throw new CommandFailure({ error: 'InvalidArgument', field: `keep_ranges[${i}].${f}`, detail: 'timeline microseconds, an integer' })
  }
  if ((r.t_end_us as number) <= (r.t_start_us as number))
    throw new CommandFailure({ error: 'InvalidArgument', field: `keep_ranges[${i}]`, detail: `t_end_us (${r.t_end_us}) must be greater than t_start_us (${r.t_start_us})` })
  if (r.label !== undefined && r.label !== null && typeof r.label !== 'string')
    throw new CommandFailure({ error: 'InvalidArgument', field: `keep_ranges[${i}].label`, detail: 'a string, or omit it to leave the survivor unnamed' })
  return { t_start_us: r.t_start_us as number, t_end_us: r.t_end_us as number, label: (r.label as string | null | undefined) ?? null }
}

/** Validate keep ranges against the target layer: non-empty, inside the
 *  layer's span, sorted with no overlaps (touching ranges share an edge and
 *  are fine — they survive as neighbours). Returns the sorted ranges. */
export function validateKeepRanges(layer: Pick<Layer, 'id' | 't_start_us' | 't_end_us'>, raw: unknown): KeepRange[] {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new CommandFailure({ error: 'InvalidArgument', field: 'keep_ranges', detail: 'names no span — name at least one kept range, or delete_layers for the whole clip' })
  const ranges = raw.map((r, i) => checkRangeShape(r, i))
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]
    if (r.t_start_us < layer.t_start_us || r.t_end_us > layer.t_end_us)
      throw new CommandFailure({ error: 'InvalidArgument', field: `keep_ranges[${i}]`, detail: `[${r.t_start_us}, ${r.t_end_us}) lies outside layer ${layer.id} at [${layer.t_start_us}, ${layer.t_end_us})` })
  }
  ranges.sort((a, b) => a.t_start_us - b.t_start_us || a.t_end_us - b.t_end_us)
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].t_start_us < ranges[i - 1].t_end_us)
      throw new CommandFailure({ error: 'InvalidArgument', field: `keep_ranges[${i}]`, detail: `[${ranges[i].t_start_us}, ${ranges[i].t_end_us}) overlaps keep_ranges[${i - 1}] — merge them or split the work` })
  }
  return ranges
}

/** Plan the cuts: every distinct keep edge strictly inside the layer, through
 *  `snap` (the link-aware grid — the actor's `gridForSplit` — so the plan and
 *  the split agree on where each boundary lands). A snapped edge that leaves
 *  the interior or collides with another is dropped: sub-grid precision names
 *  no cut the split could take.
 *
 *  Discard and labels are decided by MIDPOINT against the keep ranges (the
 *  `removePauses` rule), not by counting edges: a collapsed boundary merges
 *  two nominal segments into one, and a midpoint still names the right piece.
 *  A surviving segment takes the label of the keep range holding its midpoint.
 *
 *  Refuses when the ranges keep nothing: every nominal midpoint outside every
 *  range means the list is a delete (`delete_layers`), not an apply. */
export function planCutList(
  layer: Pick<Layer, 'id' | 't_start_us' | 't_end_us'>,
  keeps: KeepRange[],
  snap: (t: number) => number,
): CutListPlan {
  const seen = new Set<number>()
  const cuts: number[] = []
  for (const k of keeps) {
    for (const t of [k.t_start_us, k.t_end_us]) {
      if (t <= layer.t_start_us || t >= layer.t_end_us || seen.has(t)) continue
      seen.add(t)
      const s = snap(t)
      if (s <= layer.t_start_us || s >= layer.t_end_us || cuts.includes(s)) continue
      cuts.push(s)
    }
  }
  cuts.sort((a, b) => a - b)
  const inKeep = (mid: number): KeepRange | null =>
    keeps.find((k) => mid >= k.t_start_us && mid < k.t_end_us) ?? null
  const bounds = [layer.t_start_us, ...cuts, layer.t_end_us]
  const discard: number[] = []
  const labels = new Map<number, string>()
  for (let i = 0; i + 1 < bounds.length; i++) {
    const mid = (bounds[i] + bounds[i + 1]) / 2
    const keep = inKeep(mid)
    if (keep === null) { discard.push(i); continue }
    if (keep.label) labels.set(i, keep.label)
  }
  if (discard.length === bounds.length - 1)
    throw new CommandFailure({ error: 'InvalidArgument', field: 'keep_ranges', detail: `the ranges keep nothing of layer ${layer.id} — every segment falls outside them (a sub-grid range on a frame-snapped clip collapses); delete_layers removes the clip instead` })
  return { cuts, discard, labels }
}
