import { contentAt, sourceIn, sourceOut, writeSourceWindow } from '../../../renderer/layerTiming'
import { exactTime } from '../../../renderer/timeMapping'
// apps/desktop/src/main/state/mutations/split.ts
import type { Animated, Keyframe, Project, Uuid } from '../model'
import type { IdGen } from '../ids'
import { gridForLayerKind, snapOnGrid } from '../snap'
import { CommandFailure } from '../errors'
import { cloneLayer, hasSourceWindow, locateLayer, locateLayerIn, requireLayer } from './helpers'
import { linkSiblingsExcluding, checkLinkLock } from './links'
import { applyDeleteLayer } from './delete'
import { applyRippleDeleteLayers } from './ripple'
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

/** Single-layer split (link-unaware). Returns {left,right};
 *  left reuses the original id, right gets a fresh one and is inserted at li+1. */
function splitSingleLayer(p: Project, idGen: IdGen, id: Uuid, atTUsRaw: number): { left: Uuid; right: Uuid } {
  const { comp: c, track, layer: original, layerIndex: li } = requireLayer(p, id)
  // The cut resolves on THIS layer's grid, not the composition's — so a linked A/V
  // split cuts the audio on the nearest sample boundary while the video cuts on the
  // frame boundary (spec R2-D6). Locate first: the grid depends on `params.kind`.
  const atTUs = snapOnGrid(atTUsRaw, gridForLayerKind(original.params.kind, c.fps))
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
  if (hasSourceWindow(right.params) || right.params.kind === 'Motif' || right.params.kind === 'ImageOverlay')
    writeSourceWindow(right.params, contentAt(original.params, exactTime(splitOffset)), sourceOut(original));
  const rightProgress='transform' in right.params && right.params.transform.position.mode==='Path'?right.params.transform.position.progress:null
  forEachAnimatedF64(right.params, (a) => { if(a===rightProgress || 'time_map' in original.params) shiftKeyframes(a,-splitOffset); else splitTrackHalf(a, splitOffset, true) })
  forEachAnimatedRgba(right.params, (a) => 'time_map' in original.params ? shiftKeyframes(a, -splitOffset) : splitTrackHalf(a, splitOffset, true))
  for (const effect of right.effects) for (const track of Object.values(effect.params)) shiftKeyframes(track, -splitOffset)

  // LEFT half — reuses original id, [original.t_start, atTUs].
  const left = cloneLayer(original)
  left.t_end_us = atTUs
  if (hasSourceWindow(left.params) || left.params.kind === 'Motif' || left.params.kind === 'ImageOverlay')
    writeSourceWindow(left.params, sourceIn(original.params), contentAt(original.params, exactTime(splitOffset)));
  const leftProgress='transform' in left.params && left.params.transform.position.mode==='Path'?left.params.transform.position.progress:null
  forEachAnimatedF64(left.params, (a) => { if(a!==leftProgress && !('time_map' in original.params)) splitTrackHalf(a, splitOffset, false) })
  forEachAnimatedRgba(left.params, (a) => { if (!('time_map' in original.params)) splitTrackHalf(a, splitOffset, false) })

  track.layers[li] = left
  track.layers.splice(li + 1, 0, right)
  return { left: id, right: right.id }
}

/** Split with link spanning fan-out, partitioning the link at the cut. */
export function applySplitLayer(p: Project, idGen: IdGen, id: Uuid, atTUsRaw: number, escapeLink: boolean): { left: Uuid; right: Uuid } {
  // Pre-flight on the target.
  const target = requireLayer(p, id)
  const c = target.comp
  if (target.track.locked) throw new CommandFailure({ error: 'TrackLocked', track: target.track.id })
  const tgt = target.layer
  // Snapped on the TARGET's grid for the pre-flight + containment tests; each
  // spanning sibling then re-snaps `atTUs` on its own grid inside splitSingleLayer.
  const atTUs = snapOnGrid(atTUsRaw, gridForLayerKind(tgt.params.kind, c.fps))
  if (atTUs <= tgt.t_start_us || atTUs >= tgt.t_end_us) throw new CommandFailure({ error: 'SplitOutsideLayer', layer: id, at_t: atTUs })

  // Spanning siblings: members whose interval strictly contains atTUs (sorted order).
  // linkSiblingsExcluding returns SORTED members — id-allocation order matches Rust OrdSet.
  const spanning: Uuid[] = escapeLink ? [] : linkSiblingsExcluding(c, id).filter((s) => {
    const sl = locateLayerIn(c, s); if (!sl) return false
    return sl.layer.t_start_us < atTUs && atTUs < sl.layer.t_end_us
  })
  if (!escapeLink) checkLinkLock(c, id, [id, ...spanning])

  const link = c.links.find((g) => g.members.includes(id))

  // Split target FIRST (id-allocation order: target right-half id comes first).
  const targetHalves = splitSingleLayer(p, idGen, id, atTUs)
  const rightByLeft = new Map<Uuid, Uuid>([[id, targetHalves.right]])

  // Allocate all layer halves before allocating the new right-side link.
  for (const sid of spanning) {
    const { right: rightId } = splitSingleLayer(p, idGen, sid, atTUs)
    rightByLeft.set(sid, rightId)
  }
  // Link override keeps the original membership and leaves the new half free;
  // unsplit siblings must not bridge the cut back to that half.
  if (link && !escapeLink) {
    const left: Uuid[] = []
    const right: Uuid[] = []
    for (const member of link.members) {
      const half = rightByLeft.get(member)
      if (half !== undefined) {
        left.push(member)
        right.push(half)
      } else {
        const loc = locateLayerIn(c, member)
        if (loc) (loc.layer.t_start_us >= atTUs ? right : left).push(member)
      }
    }
    if (left.length >= 2) link.members = left.sort()
    else c.links.splice(c.links.indexOf(link), 1)
    if (right.length >= 2) c.links.push({ id: idGen(), members: right.sort() })
  }

  return targetHalves
}

/** User-authored batch: validate every cut before splitting; snap, sort and
 *  deduplicate so unsorted/repeated input never cuts the same segment twice.
 *  Unlike detector-derived cuts, invalid endpoints are errors, not skipped. */
export function applySplitLayerBatch(p: Project, idGen: IdGen, id: Uuid, rawCuts: number[], escapeLink: boolean): { layer_ids: Uuid[]; at_t_us: number[] } {
  const { comp, layer } = requireLayer(p, id)
  const grid = gridForLayerKind(layer.params.kind, comp.fps)
  const cuts = [...new Set(rawCuts.map((at) => snapOnGrid(at, grid)))].sort((a, b) => a - b)
  for (const at of cuts) {
    if (at <= layer.t_start_us || at >= layer.t_end_us)
      throw new CommandFailure({ error: 'SplitOutsideLayer', layer: id, at_t: at })
  }
  const ids: Uuid[] = []
  let currentId = id
  for (const at of cuts) {
    const { left, right } = applySplitLayer(p, idGen, currentId, at, escapeLink)
    ids.push(left)
    currentId = right
  }
  ids.push(currentId)
  return { layer_ids: ids, at_t_us: cuts }
}

/** The `split_layer_multi` recipe, over a draft: split `layer` at every cut in
 *  `ats` (each re-snapped on the current segment's own grid; one that no longer
 *  lands strictly inside is skipped), then drop the segments `discardIdx` names
 *  — nominal indices into the cut list as the caller counted it — and, with
 *  `dropShortUs`, every segment shorter than it, each with the link members
 *  overlapping it. `ripple` sends the doomed pieces to
 *  `applyRippleDeleteLayers` as ONE set, so the split and the closing of what
 *  it threw away are one edit (ADR 0062). Returns the surviving target
 *  segments in timeline order. The actor's `split_layer_multi` arm states the
 *  rules in full; this is its body, lifted out so `dry_run` rehearses
 *  `apply_cut_list` through the very same code. */
export function applySplitLayerMulti(
  d: Project,
  idGen: IdGen,
  layer: Uuid,
  ats: readonly number[],
  discardIdx: readonly number[],
  dropShortUs: number | null,
  ripple: boolean,
): Uuid[] {
  let currentId = layer
  const ids: Uuid[] = []
  // Which segment actually carries each NOMINAL index — the numbering
  // the caller counted off the cut list. A skipped cut merges two
  // nominal segments into one real one, and without this map every
  // index past the skip would name a neighbour of what was unchecked.
  const carrier: Uuid[] = []
  for (let i = 0; i < ats.length; i++) {
    const at = ats[i]
    // Re-snap on the CURRENT SEGMENT's own grid and skip a cut that no
    // longer falls strictly inside it — defensive against a redundant cut so
    // applySplitLayer never rejects mid-batch. The segment must be located
    // first because the grid depends on its kind (spec R2-D6); shot splits
    // target video, but this op is reachable for any kind.
    const loc = locateLayer(d, currentId)
    const seg = loc ? loc.layer : null
    if (!seg) continue
    const atSnapped = snapOnGrid(at, gridForLayerKind(seg.params.kind, loc!.comp.fps))
    if (atSnapped <= seg.t_start_us || atSnapped >= seg.t_end_us) continue
    const { left, right } = applySplitLayer(d, idGen, currentId, atSnapped, false)
    while (carrier.length <= i) carrier.push(left)
    ids.push(left)
    currentId = right
  }
  while (carrier.length <= ats.length) carrier.push(currentId)
  ids.push(currentId)
  const discarded = new Set(discardIdx.map((i) => carrier[i]))
  if (dropShortUs === null && discarded.size === 0) return ids
  const kept: Uuid[] = []
  const targets = new Set(ids)
  const doomed = new Set<Uuid>()
  for (const id of ids) {
    const loc = locateLayer(d, id)
    const seg = loc?.layer ?? null
    const short = seg !== null && dropShortUs !== null && seg.t_end_us - seg.t_start_us < dropShortUs
    if (!seg || !(short || discarded.has(id))) { kept.push(id); continue }
    // Read the link BEFORE this segment's own delete: a link
    // auto-dissolves below two members, so a two-member pair would
    // have no siblings left to read afterwards.
    // Half a frame of slack on the overlap: members on different
    // grids are cut up to half a frame apart (a sample-lattice cut
    // rounds onto the frame grid), so the piece of a KEPT neighbour
    // can lap into this segment by that much without belonging to
    // it. A piece that is mostly inside still travels however short
    // it is, and a piece longer than the slack overlap is a partner
    // that genuinely shares the span (a slipped or longer partner).
    const halfFrameUs = (500_000 * loc!.comp.fps.den) / loc!.comp.fps.num
    const partners = linkSiblingsExcluding(loc!.comp, id).filter((sid) => {
      if (targets.has(sid)) return false // never another segment of the target
      const s = locateLayer(d, sid)?.layer
      if (s === undefined) return false
      const overlapUs = Math.min(s.t_end_us, seg.t_end_us) - Math.max(s.t_start_us, seg.t_start_us)
      if (overlapUs <= 0) return false
      return overlapUs * 2 > s.t_end_us - s.t_start_us || overlapUs > halfFrameUs
    })
    if (ripple) { doomed.add(id); for (const sid of partners) doomed.add(sid); continue }
    applyDeleteLayer(d, id)
    // Defensive re-locate: no partner should overlap two rejected
    // segments, since a member spanning a cut was split at it — but a
    // stale id here would throw LayerNotFound and abort the whole
    // apply, so the list is checked rather than trusted.
    for (const sid of partners) if (locateLayer(d, sid)) applyDeleteLayer(d, sid)
  }
  // Nothing but the ripple branch above fills `doomed`, and it can
  // still come out empty — `drop_short_us` with no segment under the
  // floor. The ripple refuses an empty set (nothing to close), so the
  // splits alone are the whole edit.
  if (doomed.size > 0) applyRippleDeleteLayers(d, [...doomed])
  return kept
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
