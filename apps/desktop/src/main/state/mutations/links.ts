// apps/desktop/src/main/state/mutations/links.ts
import type { Composition, Link, Project, Uuid } from '../model'
import { CommandFailure } from '../errors'
import { locateLayerIn, requireSameComposition } from './helpers'

/** link.rs:index_links — member LayerId → owning LinkId. */
export function indexLinks(links: Link[]): Map<Uuid, Uuid> {
  const m = new Map<Uuid, Uuid>()
  for (const g of links) for (const member of g.members) m.set(member, g.id)
  return m
}

/** Every layer id across one composition's tracks — the set a link's members
 *  are drawn from (a link never spans compositions). */
export function layerIdSet(c: Composition): Set<Uuid> {
  const s = new Set<Uuid>()
  for (const t of c.tracks) for (const l of t.layers) s.add(l.id)
  return s
}

/** All OTHER members of `id`'s link in `c`, in sorted member order (Rust OrdSet
 *  iteration order). Empty when unlinked. The sort is the id-allocation-order
 *  guarantee for split fan-out. */
export function linkSiblingsExcluding(c: Composition, id: Uuid): Uuid[] {
  const idx = indexLinks(c.links)
  const gid = idx.get(id)
  if (gid === undefined) return []
  const link = c.links.find((g) => g.id === gid)
  if (!link) return []
  return [...link.members].filter((m) => m !== id).sort()
}

/** Reject if any `touched` member is layer-locked or on a locked track of `c`.
 *  No-op when `anchor` is unlinked. */
export function checkLinkLock(c: Composition, anchor: Uuid, touched: Iterable<Uuid>): void {
  const idx = indexLinks(c.links)
  const gid = idx.get(anchor)
  if (gid === undefined) return
  for (const id of touched) {
    const loc = locateLayerIn(c, id)
    if (!loc) continue
    if (loc.track.locked) throw new CommandFailure({ error: 'TrackLocked', track: loc.track.id })
    if (loc.layer.locked) throw new CommandFailure({ error: 'LinkLockedMember', link: gid, locked_layer: id, touched: anchor })
  }
}

/** A link with the composition that holds it, or null. Link ids come off the one
 *  id stream, so a link lives in exactly one composition. */
export function locateLink(p: Project, id: Uuid): { comp: Composition; link: Link; index: number } | null {
  for (const c of Object.values(p.compositions)) {
    const index = c.links.findIndex((g) => g.id === id)
    if (index >= 0) return { comp: c, link: c.links[index], index }
  }
  return null
}
function requireLink(p: Project, id: Uuid): { comp: Composition; link: Link; index: number } {
  const found = locateLink(p, id)
  if (!found) throw new CommandFailure({ error: 'LinkNotFound', link: id })
  return found
}

// ── Write-side link mutations ────────────────────────────────────────────────

import type { IdGen } from '../ids'
import { dropLayerFromLinks } from './helpers'
import { AUDIO_GRID, isCanonicalOnGrid, snapOnGrid } from '../snap'

/** Snap an orphaned Audio layer's endpoints onto the 48 kHz sample lattice.
 *
 *  A linked split cuts picture and sound at ONE frame instant, leaving the
 *  audio up to half a sample off its own lattice (validate's linked-audio
 *  exception covers exactly that shape). Dissolving the link afterwards must
 *  not strand it there: an unlinked frame-aligned endpoint fails validate
 *  (`OffGridLayerBoundary`), so after any frame-snapped cut the link could
 *  never be dissolved. Snapping here — in the same commit that orphans it —
 *  keeps the dissolve total: the move is ≤ half a sample (≈10 µs, the same
 *  sample index the mixer reads), abutting ex-partners snap identically so
 *  they still abut, and an already sample-canonical endpoint is the identity.
 *  Surviving (still-linked) members are never touched. */
function snapOrphanedAudio(c: Composition, ids: Iterable<Uuid>): void {
  for (const id of ids) {
    let found: { layer: { t_start_us: number; t_end_us: number; params: { kind: string } } } | null = null
    for (const t of c.tracks) {
      const l = t.layers.find((x) => x.id === id)
      if (l) { found = { layer: l }; break }
    }
    if (!found || found.layer.params.kind !== 'Audio') continue
    const l = found.layer
    if (!isCanonicalOnGrid(l.t_start_us, AUDIO_GRID)) l.t_start_us = snapOnGrid(l.t_start_us, AUDIO_GRID)
    if (!isCanonicalOnGrid(l.t_end_us, AUDIO_GRID)) l.t_end_us = snapOnGrid(l.t_end_us, AUDIO_GRID)
  }
}

function sortedUnique(ids: Uuid[]): Uuid[] { return [...new Set(ids)].sort() }

/** Create a new link from the given layer ids, in the ONE composition they share.
 *  Dedup → existence + same composition → already-linked → reassign-drops → id alloc → push.
 *  `label === null` → field omitted (serde None parity: `'label' in link === false`). */
export function applyLinksCreate(p: Project, idGen: IdGen, layerIds: Uuid[], label: string | null, reassign: boolean): Uuid {
  const unique = sortedUnique(layerIds)
  if (unique.length < 2) throw new CommandFailure({ error: 'LinkCreateNeedsTwoLayers', got: unique.length })
  const c = requireSameComposition(p, unique) // LayerNotFound / CrossCompositionSet
  const idx = indexLinks(c.links)
  for (const m of unique) {
    const existing = idx.get(m)
    if (existing !== undefined && !reassign) throw new CommandFailure({ error: 'LayerAlreadyLinked', layer: m, existing })
  }
  if (reassign) for (const m of unique) dropLayerFromLinks(c, m)
  const id = idGen()
  const link: Link = label === null ? { id, members: unique } : { id, label, members: unique }
  c.links.push(link)
  return id
}

export function applyLinksDissolve(p: Project, id: Uuid): void {
  const { comp: c, index } = requireLink(p, id)
  const orphaned = [...c.links[index].members]
  c.links.splice(index, 1)
  snapOrphanedAudio(c, orphaned)
}

/** Add members to an existing link.
 *  layer-existence → already-linked scan → reassign-drops → LinkNotFound → insert sorted.
 *  Order matches Rust exactly: already-linked check runs before the target-link lookup.
 *  The layers name the composition; a link that exists but in ANOTHER
 *  composition is a scope mismatch, not a missing link. */
export function applyLinksAddMembers(p: Project, id: Uuid, layerIds: Uuid[], reassign: boolean): void {
  if (layerIds.length === 0) { requireLink(p, id); return }
  // Scan the RAW input (Rust iterates layer_ids unmodified — first error follows input order).
  const c = requireSameComposition(p, layerIds)
  const idx = indexLinks(c.links)
  for (const m of layerIds) {
    const existing = idx.get(m)
    if (existing !== undefined && existing !== id && !reassign) throw new CommandFailure({ error: 'LayerAlreadyLinked', layer: m, existing })
  }
  if (reassign) for (const m of layerIds) { if (idx.get(m) !== id) dropLayerFromLinks(c, m) }
  // LinkNotFound is checked AFTER the scans.
  const target = c.links.find((g) => g.id === id)
  if (!target) {
    const elsewhere = locateLink(p, id)
    if (elsewhere) throw new CommandFailure({ error: 'CrossCompositionSet', layer: layerIds[0], composition: c.id, expected: elsewhere.comp.id })
    throw new CommandFailure({ error: 'LinkNotFound', link: id })
  }
  // Final member set is an OrdSet: dedup + sort (mirrors link.members.insert).
  target.members = [...new Set([...target.members, ...layerIds])].sort()
}

/** Remove members; auto-dissolve below 2. Removed members leave the link, so
 *  an Audio member cut at a frame instant snaps back to the sample lattice
 *  (see `snapOrphanedAudio`); survivors keep their geometry verbatim. */
export function applyLinksRemoveMembers(p: Project, id: Uuid, layerIds: Uuid[]): void {
  const { comp: c, link: g, index } = requireLink(p, id)
  const members = new Set(g.members)
  for (const m of layerIds) if (!members.has(m)) throw new CommandFailure({ error: 'LayerNotInLink', link: id, layer: m })
  const removals = new Set(layerIds)
  g.members = g.members.filter((m) => !removals.has(m))
  if (g.members.length < 2) {
    const orphaned = [...g.members, ...layerIds.filter((m) => members.has(m))]
    c.links.splice(index, 1)
    snapOrphanedAudio(c, orphaned)
  } else {
    snapOrphanedAudio(c, layerIds)
  }
}

/** Rename a link; null → delete label field (serde None parity). */
export function applyLinksRename(p: Project, id: Uuid, label: string | null): void {
  const { link: g } = requireLink(p, id)
  if (label === null) delete g.label
  else g.label = label
}
