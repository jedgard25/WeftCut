// apps/desktop/src/main/state/mutations/trim.ts
import type { Layer, Project, Uuid } from '../model'
import { gridForLayerKind, snapDownOnGrid, snapOnGrid, snapUpOnGrid, type Grid } from '../snap'
import { applyDurationAutofit, hasSourceWindow, locateLayerIn, requireLayer, shiftLayerKeyframes, sourceDurationUs } from './helpers'
import { CommandFailure } from '../errors'
import { linkSiblingsExcluding, checkLinkLock } from './links'

export type LayerEdge = 'In' | 'Out'
const INF = Math.floor(Number.MAX_SAFE_INTEGER / 4)

export function clampSigned(d: number, min: number, max: number): number {
  if (min > max) return 0 // bounds collapsed — no movement allowed
  return Math.min(Math.max(d, min), max)
}

/** The RAW µs constraints on a trim delta. `trimEdgeWindowUs` is the bound the
 *  mutation path clamps against — it lifts these onto the composition frame grid.
 *
 *  `sourceDurationUs` is the normalized source content duration for layers with
 *  a source window (media for VideoClip / Audio, the referenced composition's
 *  `duration_us` for a Group layer); it caps OUT trims so `src_out_us` never
 *  extends past source content. Floored at zero: a Group window that already
 *  overhangs its composition (legal in state, ADR 0052 §6) may not grow, and
 *  must not be dragged back either — an outward drag is refused, not inverted.
 *
 *  LANDMINE: every `- 1` below is a STRICT-inequality exclusion (`t_start` must
 *  land strictly before `t_end`; `src_in` strictly before `src_out`), never a
 *  minimum duration — `trimEdgeWindowUs`' inward snap is what widens each of
 *  them to a whole frame. Delete them as µs-era relics and that snap lands both
 *  edges on the same frame, i.e. a zero-length layer. */
export function trimDeltaBounds(
  layer: Layer,
  edge: LayerEdge,
  _motifMaxDurUs: number | null,
  sourceDurationUs: number | null = null,
): { min: number; max: number } {
  const dur = layer.t_end_us - layer.t_start_us
  const pa = layer.params
  if (edge === 'In') {
    const timelineMin = -layer.t_start_us
    const timelineMax = dur - 1
    let srcMin = -INF, srcMax = INF
    if (hasSourceWindow(pa)) { srcMin = -pa.src_in_us; srcMax = pa.src_out_us - pa.src_in_us - 1 }
    return { min: Math.max(timelineMin, srcMin), max: Math.min(timelineMax, srcMax) }
  } else {
    const timelineMin = -(dur - 1)
    let srcMin = -INF; let srcMax = INF
    if (hasSourceWindow(pa)) {
      srcMin = -(pa.src_out_us - pa.src_in_us - 1)
      if (sourceDurationUs != null) srcMax = Math.max(0, sourceDurationUs - pa.src_out_us)
    }
    return { min: Math.max(timelineMin, srcMin), max: srcMax }
  }
}

/** The absolute window the trimmed edge may land in, as canonical points of the
 *  LAYER'S OWN grid — the composition frame grid for a visual kind, the 48 kHz
 *  sample lattice for Audio (spec R2-D6): `trimDeltaBounds` snapped INWARD (ceil the
 *  low end, floor the high end). Because both ends come out of that grid, a clamp
 *  can only ever persist a canonical `t_start_us` / `t_end_us` — the endpoint
 *  invariant in `docs/data-model.md` (Timeline-field alignment).
 *
 *  Inward is the load-bearing half. A source-derived bound is arbitrary µs (a
 *  media duration is not a frame boundary), so the layer gives up to one quantum of
 *  media back rather than persisting an off-grid endpoint, and the strict µs
 *  exclusions become a one-quantum minimum duration — one composition frame for
 *  visual kinds, ONE SAMPLE (~20.83 µs) for audio, which is what makes sample-level
 *  audio trims reachable at all. `hi < lo` means no legal point is left —
 *  `applyTrimLayer` reports `TrimEdgeOutOfRange` instead of committing a sub-quantum
 *  sliver. `INF` stays a sentinel: an OUT trim with no source cap has no upper bound
 *  to put on the grid. */
export function trimEdgeWindowUs(
  layer: Layer,
  edge: LayerEdge,
  grid: Grid,
  sourceDurationUs: number | null = null,
): { lo: number; hi: number } {
  const b = trimDeltaBounds(layer, edge, null, sourceDurationUs)
  const edgeT = edge === 'In' ? layer.t_start_us : layer.t_end_us
  return {
    lo: snapUpOnGrid(Math.max(0, edgeT + b.min), grid),
    hi: b.max >= INF ? INF : snapDownOnGrid(edgeT + b.max, grid),
  }
}

/** Trim one edge. Unless `escapeLink`, the WHOLE link moves with it: every
 *  sibling shifts by the same delta on its own lattice, clamped to the tightest
 *  member's window, so a deliberate A/V offset is preserved rather than
 *  collapsed. */
export function applyTrimLayer(p: Project, id: Uuid, edge: LayerEdge, newTUs: number, escapeLink: boolean): void {
  const located = requireLayer(p, id)
  const c = located.comp
  const fps = c.fps
  if (located.track.locked) throw new CommandFailure({ error: 'TrackLocked', track: located.track.id })
  const target = located.layer
  const snapped = snapOnGrid(newTUs, gridForLayerKind(target.params.kind, fps))
  const curStart = target.t_start_us, curEnd = target.t_end_us
  const curEdgeT = edge === 'In' ? curStart : curEnd

  // The linked set: the target plus EVERY sibling. A trim moves the whole link —
  // the standard NLE behavior — each member shifting by the same delta on its own
  // lattice. The old "matching edge must coincide" gate silently dropped
  // auto-paired audio, whose Out edge lands on the sample lattice while the
  // picture's lands on the frame grid, so the pair never trimmed together.
  // `escape_link` (Alt, or the Links-off toggle) is the per-op opt-out.
  const aligned: Uuid[] = [id]
  if (!escapeLink) {
    for (const sid of linkSiblingsExcluding(c, id)) {
      if (locateLayerIn(c, sid)) aligned.push(sid)
    }
    checkLinkLock(c, id, aligned)
  }

  const requestedDelta = snapped - curEdgeT
  if (requestedDelta === 0) return // no-op early return

  // Clamp against every member's grid window, each expressed on the shared DELTA
  // basis by subtracting that member's OWN edge. The tightest member governs,
  // while each keeps its offset: a member whose edge is already offset by δ
  // contributes the same delta bound as a coincident one, and lands δ away again.
  let lo = -INF
  let hi = INF
  for (const mid of aligned) {
    const m = locateLayerIn(c, mid)!.layer
    const mEdgeT = edge === 'In' ? m.t_start_us : m.t_end_us
    const w = trimEdgeWindowUs(m, edge, gridForLayerKind(m.params.kind, fps), sourceDurationUs(p, m.params))
    lo = Math.max(lo, w.lo - mEdgeT)
    hi = Math.min(hi, w.hi - mEdgeT)
  }
  const clamped = clampSigned(requestedDelta, lo, hi)
  if (clamped === 0) throw new CommandFailure({ error: 'TrimEdgeOutOfRange', layer: id, new_t: snapped, cur_start: curStart, cur_end: curEnd })

  for (const mid of aligned) {
    const m = locateLayerIn(c, mid)!.layer
    const params = m.params
    const g = gridForLayerKind(params.kind, fps)
    // Shift by the clamped delta, resolved on THIS member's own lattice so its
    // endpoint stays canonical. At 29.97 / 59.94 a video and an audio edge land
    // within half a sample of each other; each snaps to its own grid, so the
    // relative offset survives. `src_*` shifts by the same per-member delta, so
    // content stays glued to the edge.
    if (edge === 'In') {
      const nextStart = snapOnGrid(m.t_start_us + clamped, g)
      const delta = nextStart - m.t_start_us
      m.t_start_us = nextStart
      if (hasSourceWindow(params)) params.src_in_us += delta
      shiftLayerKeyframes(params, -delta) // keyframes glued to content
    } else {
      const nextEnd = snapOnGrid(m.t_end_us + clamped, g)
      const delta = nextEnd - m.t_end_us
      m.t_end_us = nextEnd
      if (hasSourceWindow(params)) params.src_out_us += delta
    }
  }

  // Re-sort touched tracks on IN trims (t_start changed → order may shift).
  if (edge === 'In') {
    const touched = new Set(aligned.map((m) => locateLayerIn(c, m)!.track))
    for (const t of touched) t.layers.sort((x, y) => x.t_start_us - y.t_start_us)
  }
  applyDurationAutofit(c)
}
