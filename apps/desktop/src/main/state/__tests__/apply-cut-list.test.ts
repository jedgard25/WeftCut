// apps/desktop/src/main/state/__tests__/apply-cut-list.test.ts
// apply_cut_list: the keep-range rough cut as one verb — cuts, discards,
// ripple, labels, refusals, rehearsal. Planner unit tests live beside it
// (mutations/cutList.test.ts); these drive the dispatch arm, the MCP tool,
// the generic dry_run op, and the undo contract.
import { describe, it, expect } from 'vitest'
import { createActor, type ActorHandle, type DispatchResult } from '../actor'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { root } from './fixtures/project'

const S = 1_000_000

function freshActor(): ActorHandle {
  const idGen = seededGen()
  return createActor({ initial: blankProject(idGen, 'acl'), idGen, clock: () => '<TS>' })
}

function spans(actor: ActorHandle): Array<[number, number]> {
  return root(actor.snapshot()).tracks.flatMap((t) => t.layers)
    .map((l): [number, number] => [l.t_start_us, l.t_end_us])
    .sort((x, y) => x[0] - y[0])
}

function addColor(actor: ActorHandle, track: string, s: number, e: number): string {
  const r = actor.dispatch('add_layer', { track, kind: 'color', t_start_us: s, t_end_us: e })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.value as string
}

/** A 10 s color clip with a 4 s downstream neighbour on the same track. */
function withClipAndDownstream() {
  const actor = freshActor()
  const track = root(actor.snapshot()).tracks[0].id
  const layer = addColor(actor, track, 0, 10 * S)
  addColor(actor, track, 10 * S, 14 * S)
  return { actor, track, layer }
}

function cut(actor: ActorHandle, layer: string, keep: Array<{ t_start_us: number; t_end_us: number; label?: string | null }>) {
  return actor.dispatch('apply_cut_list', { layer, keep })
}

describe('apply_cut_list', () => {
  it('keeps the middle, closes the holes, labels the survivor', () => {
    const { actor, layer } = withClipAndDownstream()
    const r = cut(actor, layer, [{ t_start_us: 2 * S, t_end_us: 6 * S, label: 'a' }])
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    const v = r.value as { surviving_layer_ids: string[]; removed: number; removed_us: number }
    expect(v.removed).toBe(2)
    expect(v.removed_us).toBe(6 * S)
    expect(v.surviving_layer_ids).toHaveLength(1)
    // Survivor closed onto the head hole, downstream onto the survivor.
    expect(spans(actor)).toEqual([[0, 4 * S], [4 * S, 8 * S]])
    const survivor = root(actor.snapshot()).tracks.flatMap((t) => t.layers).find((l) => l.id === v.surviving_layer_ids[0])
    expect(survivor?.label).toBe('a')
  })

  it('keeps several ranges with their labels', () => {
    const { actor, layer } = withClipAndDownstream()
    const r = cut(actor, layer, [
      { t_start_us: 0, t_end_us: 2 * S, label: 'head' },
      { t_start_us: 6 * S, t_end_us: 10 * S, label: 'tail' },
    ])
    expect(r.ok).toBe(true)
    const v = (r as { ok: true; value: { surviving_layer_ids: string[]; removed: number; removed_us: number } }).value
    expect(v.removed).toBe(1)
    expect(v.removed_us).toBe(4 * S)
    expect(spans(actor)).toEqual([[0, 2 * S], [2 * S, 6 * S], [6 * S, 10 * S]])
    const byId = new Map(root(actor.snapshot()).tracks.flatMap((t) => t.layers).map((l) => [l.id, l.label] as const))
    expect(v.surviving_layer_ids.map((id) => byId.get(id))).toEqual(['head', 'tail'])
  })

  it('records one history entry and undoes whole', () => {
    const { actor, layer } = withClipAndDownstream()
    const before = spans(actor)
    const opsBefore = actor.historyView(100).ops.length
    expect(cut(actor, layer, [{ t_start_us: 2 * S, t_end_us: 6 * S }]).ok).toBe(true)
    expect(actor.historyView(100).ops.length).toBe(opsBefore + 1)
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(spans(actor)).toEqual(before)
  })

  it('cuts a linked audio partner in lockstep', () => {
    const actor = freshActor()
    const track = root(actor.snapshot()).tracks[0].id
    const VID = '00000000-0000-7000-8000-0000000000cc'
    const AUD = '00000000-0000-7000-8000-0000000000dd'
    actor.dispatch('add_media', { id: VID, kind: 'Video', duration_us: 10 * S })
    actor.dispatch('add_media', { id: AUD, kind: 'Audio', duration_us: 10 * S })
    const video = actor.dispatch('add_layer', { track, kind: 'video', media: VID, src_in_us: 0, src_out_us: 10 * S, t_start_us: 0, t_end_us: 10 * S })
    const audio = actor.dispatch('add_layer', { track, kind: 'audio', media: AUD, src_in_us: 0, src_out_us: 10 * S, t_start_us: 0, t_end_us: 10 * S })
    if (!video.ok || !audio.ok) throw new Error('setup failed')
    expect(actor.dispatch('links_create', { layers: [video.value, audio.value], reassign: false }).ok).toBe(true)
    const r = cut(actor, video.value as string, [{ t_start_us: 3 * S, t_end_us: 7 * S }])
    expect(r.ok).toBe(true)
    const kinds = root(actor.snapshot()).tracks.flatMap((t) => t.layers).map((l) => [l.params.kind, l.t_start_us, l.t_end_us])
    expect(kinds).toEqual([['VideoClip', 0, 4 * S], ['Audio', 0, 4 * S]])
  })

  it('refuses empty, overlapping, out-of-span, off-grid and keep-nothing lists', () => {
    const { actor, layer } = withClipAndDownstream()
    const err = (r: DispatchResult) => {
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error('unreachable')
      return r.error
    }
    expect(err(cut(actor, layer, []))).toMatchObject({ field: 'keep_ranges' })
    expect(err(cut(actor, layer, [
      { t_start_us: 0, t_end_us: 5 * S },
      { t_start_us: 4 * S, t_end_us: 8 * S },
    ]))).toMatchObject({ detail: expect.stringMatching(/overlaps/) })
    expect(err(cut(actor, layer, [{ t_start_us: 8 * S, t_end_us: 20 * S }]))).toMatchObject({ detail: expect.stringMatching(/outside layer/) })
    // 30 fps frame grid: 1_000_001 is between frames.
    expect(err(cut(actor, layer, [{ t_start_us: 1_000_001, t_end_us: 5 * S }]))).toMatchObject({ detail: expect.stringMatching(/nearest is/) })
    // A 10 µs keep edge is off-grid too — and that refusal is the precise one:
    // sub-grid precision names no cut the split could take.
    expect(err(cut(actor, layer, [{ t_start_us: 0, t_end_us: 10 }]))).toMatchObject({ detail: expect.stringMatching(/not on/) })
    expect(err(cut(actor, 'no-such-layer', [{ t_start_us: 0, t_end_us: 5 * S }]))).toMatchObject({ error: 'LayerNotFound' })
    // Nothing recorded, nothing split.
    expect(spans(actor)).toEqual([[0, 10 * S], [10 * S, 14 * S]])
  })

  it('surfaces the ripple planner refusal whole', () => {
    const actor = freshActor()
    const t1 = root(actor.snapshot()).tracks[0].id
    const r2 = actor.dispatch('add_track', { label: 't2' })
    if (!r2.ok) throw new Error('setup failed')
    const t2 = r2.value as string
    const layer = addColor(actor, t1, 2 * S, 12 * S)
    // C reaches into the hole from before (anchored, not blocking); D lands on it.
    addColor(actor, t2, 0, 3 * S)
    addColor(actor, t2, 10.5 * S, 11.5 * S)
    // Removing [2, 10) shifts D [10.5, 11.5) onto C [0, 3).
    const r = cut(actor, layer, [{ t_start_us: 10 * S, t_end_us: 12 * S }])
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.error.error).toBe('RippleCollision')
    expect(spans(actor)).toEqual([[0, 3 * S], [2 * S, 12 * S], [10.5 * S, 11.5 * S]])
  })
})

describe('apply_cut_list rehearsal', () => {
  it('dry_run commits nothing and predicts the wet result exactly', () => {
    const { actor, layer } = withClipAndDownstream()
    const keep = [{ t_start_us: 2 * S, t_end_us: 6 * S, label: 'a' }]
    const tool = actor.mcpCall('apply_cut_list', JSON.stringify({ layer_id: layer, keep_ranges: keep, dry_run: true }))
    expect(tool.ok).toBe(true)
    if (!tool.ok) throw new Error('unreachable')
    const rehearsed = JSON.parse((tool.result as { content: Array<{ text: string }> }).content[0].text)
    expect(rehearsed.results).toHaveLength(1)
    expect(rehearsed.results[0].status).toBe('ok')
    expect(rehearsed.halted_at).toBeNull()
    expect(spans(actor)).toEqual([[0, 10 * S], [10 * S, 14 * S]])
    // The wet run lands where the rehearsal said. Survivor ids differ by
    // design — the rehearsal spends ids from the shared generator, and ids
    // are opaque — but the geometry agrees.
    const wet = actor.mcpCall('apply_cut_list', JSON.stringify({ layer_id: layer, keep_ranges: keep }))
    expect(wet.ok).toBe(true)
    if (!wet.ok) throw new Error('unreachable')
    const out = JSON.parse((wet.result as { content: Array<{ text: string }> }).content[0].text)
    expect(out.removed).toBe(2)
    expect(out.removed_us).toBe(6 * S)
    expect(out.surviving_layer_ids).toHaveLength(rehearsed.results[0].output.surviving_layer_ids.length)
    expect(spans(actor)).toEqual([[0, 4 * S], [4 * S, 8 * S]])
  })

  it('rehearses inside the generic dry_run op list, halting with the refusal', () => {
    const { actor, layer } = withClipAndDownstream()
    const good = actor.mcpCall('dry_run', JSON.stringify({ operations: [
      { kind: 'apply_cut_list', layer_id: layer, keep_ranges: [{ t_start_us: 2 * S, t_end_us: 6 * S }] },
    ] }))
    expect(good.ok).toBe(true)
    const body = JSON.parse(((good as { ok: true; result: { content: Array<{ text: string }> } }).result).content[0].text)
    expect(body.results[0].output.kind).toBe('apply_cut_list')
    const bad = actor.mcpCall('dry_run', JSON.stringify({ operations: [
      { kind: 'apply_cut_list', layer_id: layer, keep_ranges: [] },
    ] }))
    expect(bad.ok).toBe(false)
  })

  it('a failing rehearsal names the refusal and records nothing', () => {
    const actor = freshActor()
    const t1 = root(actor.snapshot()).tracks[0].id
    const layer = addColor(actor, t1, 0, 10 * S)
    // A refusal rehearses as a halted envelope — the dry_run convention —
    // not as a failed call.
    const tool = actor.mcpCall('apply_cut_list', JSON.stringify({
      layer_id: layer,
      keep_ranges: [{ t_start_us: 8 * S, t_end_us: 20 * S }],
      dry_run: true,
    }))
    expect(tool.ok).toBe(true)
    if (!tool.ok) throw new Error('unreachable')
    const rehearsed = JSON.parse((tool.result as { content: Array<{ text: string }> }).content[0].text)
    expect(rehearsed.halted_at).toBe(0)
    expect(rehearsed.results[0].status).toBe('error')
    expect(rehearsed.results[0].error).toMatch(/outside layer/)
    expect(spans(actor)).toEqual([[0, 10 * S]])
  })
})
