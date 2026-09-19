// apps/desktop/src/main/state/mutations/split.ts
import type { Animated, Keyframe, Composition, Project, Uuid } from '../model'
import type { IdGen } from '../ids'
import { frameGrid, gridForLayerKind, snapOnGrid, type Grid } from '../snap'
import { CommandFailure } from '../errors'
import { cloneLayer, hasSourceWindow, requireLayer } from './helpers'
import { linkSiblingsExcluding, checkLinkLock, indexLinks } from './links'
import { forEachAnimatedF64, forEachAnimatedRgba, retainKeyframes, shiftKeyframes, firstKeyframeValue, lastKeyframeValue, collapseToStatic } from './animated'

/** Partition one Animated<T> track for a split at the
 *  clip-local `splitOffset`. LEFT keeps t<=offset; RIGHT keeps t>offset, rebased
 *  by -offset. An emptied Keyframed half collapses to Static at the boundary value
 *  (LEFT→first, RIGHT→last). */
function splitTrackHalf<T>(a: Animated<T>, splitOffset: number, right: boolean): void {
  const boundary = right ? lastKeyframeValue(a) : firstKeyframeValue(a)
  if (right) { retainKeyframes(a, (t) => t > splitOffset); shiftKeyframes(a, -splitOffset) }
  else { retainKeyframes(a, (t) => t <= splitOffset) }
  if (a.mode === 'Keyframed' && (a.value as Keyframe<T>[]).length === 0 && boundary !== null) collapseToStatic(a, boundary)
}

/** Whether `layerId` sits in a link holding a frame-grid (non-Audio) member.
 *
 *  A linked A/V pair is cut at ONE instant on the frame grid — the video's
 *  precision dominates, and the audio cut lands on the same frame (≤ half a
 *  sample off its own lattice, the same sample index the mixer reads). Cutting
 *  each member on its own lattice instead leaves the two cuts up to half a
 *  frame apart at NTSC rates, and the ripple then refuses the pair it just
 *  made (`RippleInsideHole` over a hole that swallowed the clip). An unlinked
 *  Audio layer, or one linked only to other Audio, keeps sample precision. */
export function linkHasFrameMember(c: Composition, layerId: Uuid): boolean {
  const link = c.links.find((g) => g.members.includes(layerId))
  if (!link) return false
  // Early-exit on the first picture member: a link's kinds never change under
  // splits (a right half inherits its kind), and an A/V link's first member in
  // id order is usually the picture, so this is typically one lookup.
  // `kinds` avoids re-walking tracks per member (a 300-cut remove_pauses fans
  // out over a thousand-member link — O(m·n) locate-per-member blocks main).
  const kinds = kindMapOf(c)
  for (const m of link.members) {
    const k = kinds.get(m)
    if (k === undefined) continue
    if (k !== 'Audio') return true
  }
  return false
}

/** Layer id → params kind for one composition, built in one walk. The split
 *  fan-out and the discard fan-out both test every link sibling per cut; a
 *  per-member `locateLayerIn` scan turns a 300-cut remove_pauses into minutes
 *  on main (Bug 3). One map per call keeps each call O(tracks + members). */
export function kindMapOf(c: Composition): Map<Uuid, string> {
  const m = new Map<Uuid, string>()
  for (const t of c.tracks) for (const l of t.layers) m.set(l.id, l.params.kind)
  return m
}

/** Layer id → layer for one composition, built in one walk. Same scaling
 *  rationale as `kindMapOf`: the spanning test below must not scan tracks per
 *  sibling. */
function layerMapOf(c: Composition): Map<Uuid, { t_start_us: number; t_end_us: number }> {
  const m = new Map<Uuid, { t_start_us: number; t_end_us: number }>()
  for (const t of c.tracks) for (const l of t.layers) m.set(l.id, l)
  return m
}

/** THE grid a split of `layerId` resolves on: the frame grid when the link
 *  holds a frame-grid member, else the layer's own grid. Single seam with
 *  `applySplitLayer` and the `split_layer_multi` skip check in `actor.ts`. */
export function gridForSplit(c: Composition, layerId: Uuid, kind: string): Grid {
  if (linkHasFrameMember(c, layerId)) return frameGrid(c.fps)
  return gridForLayerKind(kind, c.fps)
}

/** Single-layer split (link-unaware). Returns {left,right};
 *  left reuses the original id, right gets a fresh one and is inserted at li+1.
 *
 *  `atTUs` arrives PRE-SNAPPED by the caller (`applySplitLayer` owns the grid:
 *  frame when the link holds a picture member, else the layer's own) so every
 *  member of one link fan-out lands on the same instant. No re-snap here — a
 *  second snap on the member's own lattice is exactly the drift that used to
 *  put video and audio up to half a frame apart. */
function splitSingleLayer(p: Project, idGen: IdGen, id: Uuid, atTUs: number): { left: Uuid; right: Uuid } {
  const { track, layer: original, layerIndex: li } = requireLayer(p, id)
  if (atTUs <= original.t_start_us || atTUs >= original.t_end_us) throw new CommandFailure({ error: 'SplitOutsideLayer', layer: id, at_t: atTUs })
  const splitOffset = atTUs - original.t_start_us

  // RIGHT half — fresh id, [atTUs, original.t_end]. A source window (media or a
  // Group's composition) is divided at the same offset: at speed 1 the source
  // and the timeline advance together.
  const right = cloneLayer(original)
  right.id = idGen()
  right.t_start_us = atTUs
  right.t_end_us = original.t_end_us
  // Split does not re-derive the Motif content cap (no MotifCatalog reaches here;
  // `resolveMotifMaxDurUs` owns it), so a Motif's src_in_us is not rebased.
  const rightCapped = false
  if (hasSourceWindow(right.params)) right.params.src_in_us += splitOffset
  else if (right.params.kind === 'Motif' && rightCapped) right.params.src_in_us += splitOffset
  const rightProgress='transform' in right.params && right.params.transform.position.mode==='Path'?right.params.transform.position.progress:null
  forEachAnimatedF64(right.params, (a) => { if(a===rightProgress) shiftKeyframes(a,-splitOffset); else splitTrackHalf(a, splitOffset, true) })
  forEachAnimatedRgba(right.params, (a) => splitTrackHalf(a, splitOffset, true))

  // LEFT half — reuses original id, [original.t_start, atTUs].
  const left = cloneLayer(original)
  left.t_end_us = atTUs
  if (hasSourceWindow(left.params)) left.params.src_out_us = left.params.src_in_us + splitOffset
  const leftProgress='transform' in left.params && left.params.transform.position.mode==='Path'?left.params.transform.position.progress:null
  forEachAnimatedF64(left.params, (a) => { if(a!==leftProgress) splitTrackHalf(a, splitOffset, false) })
  forEachAnimatedRgba(left.params, (a) => splitTrackHalf(a, splitOffset, false))

  track.layers[li] = left
  track.layers.splice(li + 1, 0, right)
  return { left: id, right: right.id }
}

/** Split with link spanning fan-out. */
export function applySplitLayer(p: Project, idGen: IdGen, id: Uuid, atTUsRaw: number, escapeLink: boolean): { left: Uuid; right: Uuid } {
  // Pre-flight on the target.
  const target = requireLayer(p, id)
  const c = target.comp
  if (target.track.locked) throw new CommandFailure({ error: 'TrackLocked', track: target.track.id })
  const tgt = target.layer
  // ONE instant for the whole link: the frame grid when a picture member rides
  // along, else the target's own grid. Every spanning sibling is cut at this
  // same `atTUs` — no per-member re-snap — so a linked pair never drifts apart.
  const atTUs = snapOnGrid(atTUsRaw, escapeLink ? gridForLayerKind(tgt.params.kind, c.fps) : gridForSplit(c, id, tgt.params.kind))
  if (atTUs <= tgt.t_start_us || atTUs >= tgt.t_end_us) throw new CommandFailure({ error: 'SplitOutsideLayer', layer: id, at_t: atTUs })

  // Spanning siblings: members whose interval strictly contains atTUs (sorted order).
  // linkSiblingsExcluding returns SORTED members — id-allocation order matches Rust OrdSet.
  // Lookups ride one layer map, not one track scan per sibling (see kindMapOf).
  const layerMap = layerMapOf(c)
  const spanning: Uuid[] = escapeLink ? [] : linkSiblingsExcluding(c, id).filter((s) => {
    const sl = layerMap.get(s); if (!sl) return false
    return sl.t_start_us < atTUs && atTUs < sl.t_end_us
  })
  if (!escapeLink) checkLinkLock(c, id, [id, ...spanning])

  // Split target FIRST (id-allocation order: target right-half id comes first).
  const targetHalves = splitSingleLayer(p, idGen, id, atTUs)
  const linkByMember = indexLinks(c.links)
  const linkById = new Map(c.links.map((g) => [g.id, g]))

  // Split each spanning sibling in sorted order; add its right-half to the sibling's link.
  for (const sid of spanning) {
    const { right: rightId } = splitSingleLayer(p, idGen, sid, atTUs)
    const gid = linkByMember.get(sid)
    if (gid !== undefined) {
      const g = linkById.get(gid)
      if (g) { g.members = [...g.members, rightId].sort() }
    }
  }
  // Add the target's right-half to its link, if any. UNCONDITIONAL:
  // even with escape_link, the target's left half keeps the original id and stays linked,
  // so its right half joins too (split.test.ts: an escape_link split leaves 3 members).
  const tgid = linkByMember.get(targetHalves.left)
  if (tgid !== undefined) { const g = linkById.get(tgid); if (g) { g.members = [...g.members, targetHalves.right].sort() } }

  return targetHalves
}

/** Validate the set of segments a multi-split should delete in its own commit,
 *  against the `cuts + 1` segments that split will produce. Indices are 0-based
 *  in timeline order and counted BEFORE any `drop_short_us` pruning, so a caller
 *  can name them off the cut list alone instead of predicting which segments the
 *  length filter is about to take.
 *
 *  Naming EVERY segment is refused: erasing the whole clip is `delete_layers`,
 *  and an apply that answered "keep nothing" by deleting what it was applied to
 *  would be a destructive reading of a request that never said delete.
 *
 *  A result rather than a throw, because the two callers refuse in different
 *  shapes — the dispatch returns a `CommandError`, the hybrid channel throws a
 *  JSON string — and the same rule written out at both would be free to drift. */
export function parseDiscardSegments(
  raw: unknown,
  segmentCount: number,
): { ok: true; value: number[] } | { ok: false; detail: string } {
  if (!Array.isArray(raw))
    return { ok: false, detail: `discard_segments must be an array of segment indices, got ${typeof raw}` }
  const seen = new Set<number>()
  for (let i = 0; i < raw.length; i++) {
    const v: unknown = raw[i]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
      return { ok: false, detail: `discard_segments[${i}] is ${String(v)} — every entry must be a non-negative integer` }
    if (v >= segmentCount)
      return { ok: false, detail: `discard_segments[${i}] (${v}) is out of range — the split produces ${segmentCount} segment(s), numbered 0..${segmentCount - 1}` }
    if (seen.has(v))
      return { ok: false, detail: `discard_segments[${i}] (${v}) is named twice` }
    seen.add(v)
  }
  if (seen.size === segmentCount)
    return { ok: false, detail: `discard_segments names all ${segmentCount} segment(s) — discarding every segment is a delete, not an apply` }
  return { ok: true, value: [...seen] }
}
