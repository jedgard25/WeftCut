// apps/desktop/src/main/state/mutations/cutList.ts
//
// Cutting a list of ranges out of one clip and closing the gaps — the planning
// shared by `remove_pauses` (ranges it detected) and `apply_cut_list` (ranges
// the caller decided). Pure over a snapshot: no draft, no ids, no dispatch. The
// plan is what `split_layer_multi` takes with `ripple: true`, so both tools
// land the same single commit through the same split-and-ripple engine
// (ADR 0062, ADR 0143).
import type { Composition, Layer, Project, Uuid } from '../model'
import { CommandFailure } from '../errors'
import { snapFrameRound } from '../snap'
import { requireLayer } from './helpers'

/** A half-open timeline span, µs: `[t_start_us, t_end_us)`. */
export interface CutRange {
  t_start_us: number
  t_end_us: number
}

/** What `split_layer_multi` cuts: the interior boundaries in time order, the
 *  nominal segments to discard, and how much time the discarded ranges hold. */
export interface RangeCutPlan {
  cuts: number[]
  discard: number[]
  /** The ranges actually cut, after the grid landing, in time order. */
  removed: CutRange[]
  removed_us: number
}

type Subject = Pick<Layer, 'id' | 't_start_us' | 't_end_us'>

/** The ranges as the split can actually take them when the subject travels
 *  with a picture.
 *
 *  `split_layer_multi` re-snaps every spanning link member on ITS OWN grid: an
 *  Audio subject on the 48 kHz lattice, a linked VideoClip on the frame grid. A
 *  boundary that lands between frames is therefore cut in two places up to half
 *  a frame apart, and the picture piece of a KEPT segment then overlaps the next
 *  hole by that half frame — enough for the fan-out to doom it and for the
 *  ripple planner to refuse the whole edit (`RippleInsideHole` over a hole that
 *  has swallowed the clip). Snapping the interior boundaries onto the
 *  composition's frame grid FIRST puts both members' cuts on one instant: a
 *  frame boundary is a sample boundary at every integer rate, and at 29.97 /
 *  59.94 the residue is ~10 µs, which the fan-out's half-frame slack absorbs.
 *  The head and tail boundaries are the subject's own edges and are left alone.
 *
 *  Only when the subject is on the frame grid itself or a frame-grid member
 *  shares its link: an unlinked Audio clip keeps its sample precision, because
 *  nothing else has to be cut where it is cut. A range the snap collapses is
 *  dropped. */
export function landOnLinkGrid(
  ranges: readonly CutRange[],
  subject: Subject & Pick<Layer, 'params'>,
  composition: Composition,
): CutRange[] {
  const kindOf = (id: string): string | undefined => {
    for (const track of composition.tracks) {
      const hit = track.layers.find((l) => l.id === id)
      if (hit) return hit.params.kind
    }
    return undefined
  }
  const link = composition.links.find((g) => g.members.includes(subject.id))
  const onFrameGrid = subject.params.kind !== 'Audio'
    || (link?.members.some((m) => m !== subject.id && kindOf(m) !== 'Audio') ?? false)
  if (!onFrameGrid) return [...ranges]
  const { num, den } = composition.fps
  const onFrame = (t: number): number => snapFrameRound(t, num, den)
  const out: CutRange[] = []
  for (const r of ranges) {
    const start = r.t_start_us <= subject.t_start_us ? r.t_start_us : onFrame(r.t_start_us)
    const end = r.t_end_us >= subject.t_end_us ? r.t_end_us : onFrame(r.t_end_us)
    if (end > start) out.push({ t_start_us: start, t_end_us: end })
  }
  return out
}

/** Plan the cut of `ranges` (already landed, half-open, inside the subject)
 *  out of `subject`.
 *
 *  The cut list is every range boundary STRICTLY inside the clip. A range that
 *  touches the head or the tail contributes no cut on that side, and that is
 *  not an optimization: there is nothing to cut off at a clip's own edge, and a
 *  split there is refused rather than ignored. The segment is discarded whole
 *  instead — dropping the boundary is exactly what makes a leading or trailing
 *  range one nominal segment rather than an empty one plus a real one.
 *
 *  Which segments to discard is decided by MIDPOINT against the ranges rather
 *  than by counting boundaries. The actor re-snaps every cut onto the target's
 *  grid and SKIPS one that no longer lands strictly inside its segment, so a
 *  boundary pair less than a frame apart merges two nominal segments into one;
 *  a midpoint still names the right piece where an index arithmetic over "two
 *  boundaries per range" would name its neighbour.
 *
 *  `null` when there is nothing to cut. A plan that discards every segment is
 *  returned as such: `split_layer_multi` refuses it by design (removing all of
 *  a clip is a delete), and the caller decides how to say so. */
export function planRangeCut(ranges: readonly CutRange[], subject: Subject): RangeCutPlan | null {
  const live = ranges.filter((r) => r.t_end_us > r.t_start_us)
  if (live.length === 0) return null
  const seen = new Set<number>()
  const cuts: number[] = []
  for (const r of live) {
    for (const t of [r.t_start_us, r.t_end_us]) {
      if (t <= subject.t_start_us || t >= subject.t_end_us || seen.has(t)) continue
      seen.add(t)
      cuts.push(t)
    }
  }
  cuts.sort((a, b) => a - b)
  // The nominal segments the actor will number, in the same order: `cuts + 1`
  // of them, spanning the clip end to end.
  const bounds = [subject.t_start_us, ...cuts, subject.t_end_us]
  const discard: number[] = []
  for (let i = 0; i + 1 < bounds.length; i++) {
    const mid = (bounds[i] + bounds[i + 1]) / 2
    if (live.some((r) => mid > r.t_start_us && mid < r.t_end_us)) discard.push(i)
  }
  if (discard.length === 0) return null
  const removed = [...live].sort((a, b) => a.t_start_us - b.t_start_us)
  return { cuts, discard, removed, removed_us: removed.reduce((sum, r) => sum + (r.t_end_us - r.t_start_us), 0) }
}

/** `apply_cut_list`'s ranges, checked against the subject and turned into the
 *  ranges to REMOVE: `keep` names what stays (its complement inside the clip
 *  goes), `remove` names what goes. Each range must lie inside the clip's span
 *  — a time is refused, never clamped (docs/mcp.md "Snap and echo, clamp and
 *  refuse"). Overlapping or touching ranges merge into their union: a cut list
 *  built word by word from a transcript touches at every word boundary.
 *
 *  Refused as `InvalidArgument`: an empty list, and a `keep` list whose union
 *  is the whole clip is not refused but yields no range — there is nothing to
 *  cut, and the caller answers that as a no-op. */
export function cutListRanges(subject: Subject, mode: 'keep' | 'remove', ranges: readonly CutRange[]): CutRange[] {
  if (ranges.length === 0)
    throw new CommandFailure({ error: 'InvalidArgument', field: mode, detail: mode === 'keep'
      ? 'names no span — keeping nothing is a delete (delete_layers), not a cut list'
      : 'names no span — name at least one range to remove' })
  ranges.forEach((r, i) => {
    if (!(r.t_end_us > r.t_start_us))
      throw new CommandFailure({ error: 'InvalidArgument', field: `${mode}[${i}]`, detail: `t_end_us ${r.t_end_us} must be greater than t_start_us ${r.t_start_us}` })
    if (r.t_start_us < subject.t_start_us || r.t_end_us > subject.t_end_us)
      throw new CommandFailure({ error: 'InvalidArgument', field: `${mode}[${i}]`, detail: `[${r.t_start_us}, ${r.t_end_us}) lies outside layer ${subject.id} at [${subject.t_start_us}, ${subject.t_end_us}) — ranges are timeline-absolute µs inside the clip` })
  })
  const merged = mergeRanges(ranges)
  if (mode === 'remove') return merged
  const out: CutRange[] = []
  let at = subject.t_start_us
  for (const k of merged) {
    if (k.t_start_us > at) out.push({ t_start_us: at, t_end_us: k.t_start_us })
    at = Math.max(at, k.t_end_us)
  }
  if (at < subject.t_end_us) out.push({ t_start_us: at, t_end_us: subject.t_end_us })
  return out
}

function mergeRanges(ranges: readonly CutRange[]): CutRange[] {
  const sorted = [...ranges].sort((a, b) => a.t_start_us - b.t_start_us)
  const out: CutRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.t_start_us <= last.t_end_us) last.t_end_us = Math.max(last.t_end_us, r.t_end_us)
    else out.push({ ...r })
  }
  return out
}

/** `apply_cut_list`'s whole plan against a snapshot: the clip, the ranges it
 *  loses (after the grid landing), and the split that removes them — `null`
 *  when the list keeps the whole clip. The wet arm and its `dry_run` rehearsal
 *  both call this, then hand the plan to `applySplitLayerMulti` with
 *  `ripple: true`, so the rehearsal predicts the commit by construction.
 *
 *  A list that would remove every segment is refused here, naming the tool
 *  that does that, rather than reaching `split_layer_multi`'s generic refusal
 *  of an all-discard set. */
export function planCutList(
  p: Project,
  layerId: Uuid,
  mode: 'keep' | 'remove',
  ranges: readonly CutRange[],
): { subject: Layer; plan: RangeCutPlan | null } {
  const { layer: subject, comp } = requireLayer(p, layerId)
  const landed = landOnLinkGrid(cutListRanges(subject, mode, ranges), subject, comp)
  const plan = planRangeCut(landed, subject)
  if (plan !== null && plan.discard.length === plan.cuts.length + 1)
    throw new CommandFailure({ error: 'InvalidArgument', field: mode, detail: `the ranges remove all of layer ${layerId} — removing a whole clip is delete_layers (with ripple: true to close its span), not a cut list` })
  return { subject, plan }
}
