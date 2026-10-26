// apply_cut_list: a cut list landed on one clip as ONE recorded edit, through
// the cut-and-close plan remove_pauses makes (mutations/cutList.ts), with its
// dry_run rehearsal predicting the same answer.
import { describe, it, expect } from 'vitest'
import type { ActorHandle } from '../actor'
import { freshActor } from './pbt/harness'
import { root } from './fixtures/project'
import { cutListRanges, planRangeCut } from '../mutations/cutList'

/** A VideoClip with a co-extensive linked Audio partner — an auto-paired
 *  import — plus a colour title downstream on the same A roll. */
function fixture(durationUs = 6_000_000) {
  const actor = freshActor()
  const track = root(actor.snapshot()).tracks[0].id
  const VID = '00000000-0000-0000-0000-0000000000cc'
  const AUD = '00000000-0000-0000-0000-0000000000dd'
  actor.dispatch('add_media', { id: VID, kind: 'Video', duration_us: durationUs })
  actor.dispatch('add_media', { id: AUD, kind: 'Audio', duration_us: durationUs })
  const video = actor.dispatch('add_layer', { track, kind: 'video', media: VID, src_in_us: 0, src_out_us: durationUs, t_start_us: 0, t_end_us: durationUs })
  const audio = actor.dispatch('add_layer', { track, kind: 'audio', media: AUD, src_in_us: 0, src_out_us: durationUs, t_start_us: 0, t_end_us: durationUs })
  if (!video.ok || !audio.ok) throw new Error('fixture failed')
  expect(actor.dispatch('links_create', { layers: [video.value, audio.value], reassign: false }).ok).toBe(true)
  const tail = actor.dispatch('add_layer', { track, kind: 'color', t_start_us: durationUs, t_end_us: durationUs + 1_000_000 })
  if (!tail.ok) throw new Error('fixture failed')
  return { actor, track, videoId: video.value as string, audioId: audio.value as string, tailId: tail.value as string }
}

function spansOfKind(actor: ActorHandle, kind: string): Array<[number, number]> {
  return root(actor.snapshot()).tracks.flatMap((t) => t.layers)
    .filter((l) => l.params.kind === kind)
    .map((l): [number, number] => [l.t_start_us, l.t_end_us])
    .sort((x, y) => x[0] - y[0])
}

function call(actor: ActorHandle, args: Record<string, unknown>) {
  return actor.mcpCall('apply_cut_list', JSON.stringify(args))
}

function answer(r: ReturnType<ActorHandle['mcpCall']>): Record<string, unknown> {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return JSON.parse(r.result.content[0].text) as Record<string, unknown>
}

describe('apply_cut_list', () => {
  it('keeps the named spans, cuts the rest out of the clip and its link, and closes the gaps — one undo', () => {
    const { actor, videoId, tailId } = fixture()
    const before = actor.snapshot()
    const len = actor.historyStatus().len
    const out = answer(call(actor, { layer_id: videoId, keep: [{ t_start_us: 1_000_000, t_end_us: 2_000_000 }, { t_start_us: 3_000_000, t_end_us: 5_000_000 }] }))
    expect(actor.historyStatus().len - len).toBe(1)
    expect(actor.historyView(1).ops[0].label_key).toBe('history.layer.split_and_ripple')
    const kept: Array<[number, number]> = [[0, 1_000_000], [1_000_000, 3_000_000]]
    expect(spansOfKind(actor, 'VideoClip')).toEqual(kept)
    expect(spansOfKind(actor, 'Audio')).toEqual(kept)
    expect(out.removed_ranges).toEqual([
      { t_start_us: 0, t_end_us: 1_000_000 }, { t_start_us: 2_000_000, t_end_us: 3_000_000 }, { t_start_us: 5_000_000, t_end_us: 6_000_000 },
    ])
    expect(out.removed_us).toBe(3_000_000)
    expect((out.layers as Array<{ t_start_us: number }>).map((l) => l.t_start_us)).toEqual([0, 1_000_000])
    // The downstream title closed up by everything that went before it.
    const moved = out.moved as Array<{ layer_id: string; t_start_us: number }>
    expect(moved.find((m) => m.layer_id === tailId)?.t_start_us).toBe(3_000_000)
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot()).toEqual(before)
  })

  it('remove is the complement form, and an Audio subject linked to a picture lands its cuts on the frame grid', () => {
    const { actor, audioId } = fixture()
    // Sub-frame boundaries: at 30 fps they land on frames 41 and 87.
    const out = answer(call(actor, { layer_id: audioId, remove: [{ t_start_us: 1_353_151, t_end_us: 2_893_197 }] }))
    expect(out.removed_ranges).toEqual([{ t_start_us: 1_366_667, t_end_us: 2_900_000 }])
    expect(spansOfKind(actor, 'Audio')).toEqual(spansOfKind(actor, 'VideoClip'))
    expect(spansOfKind(actor, 'Audio')[0]).toEqual([0, 1_366_667])
  })

  it('merges touching and overlapping ranges, as a word-by-word list sends them', () => {
    const { actor, videoId } = fixture()
    answer(call(actor, { layer_id: videoId, remove: [
      { t_start_us: 1_000_000, t_end_us: 1_500_000 }, { t_start_us: 1_500_000, t_end_us: 2_000_000 }, { t_start_us: 1_800_000, t_end_us: 2_000_000 },
    ] }))
    expect(spansOfKind(actor, 'VideoClip')).toEqual([[0, 1_000_000], [1_000_000, 5_000_000]])
  })

  it('a list that keeps the whole clip records nothing and answers the clip as it is', () => {
    const { actor, videoId } = fixture()
    const len = actor.historyStatus().len
    const out = answer(call(actor, { layer_id: videoId, keep: [{ t_start_us: 0, t_end_us: 6_000_000 }] }))
    expect(actor.historyStatus().len).toBe(len)
    expect(out.removed_ranges).toEqual([])
    expect((out.layers as Array<{ layer_id: string }>)[0].layer_id).toBe(videoId)
  })

  it.each([
    [{ keep: [] }, /keep: names no span/],
    [{ remove: [{ t_start_us: 0, t_end_us: 6_000_000 }] }, /remove all of layer/],
    [{ keep: [{ t_start_us: 5_000_000, t_end_us: 7_000_000 }] }, /keep\[0\].*outside layer/],
    [{ remove: [{ t_start_us: 2_000_000, t_end_us: 2_000_000 }] }, /remove\[0\].*greater than/],
  ])('refuses %j before any write', (args, message) => {
    const { actor, videoId } = fixture()
    const before = actor.snapshot()
    const r = call(actor, { layer_id: videoId, ...args })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.message).toMatch(message)
    expect(actor.snapshot()).toBe(before)
  })

  it.each([
    [{}, /exactly one of keep or remove/],
    [{ keep: [{ t_start_us: 0, t_end_us: 1 }], remove: [{ t_start_us: 2, t_end_us: 3 }] }, /exactly one of keep or remove/],
    [{ keep: [{ t_start_us: 0.5, t_end_us: 1 }] }, /integer microsecond/],
    [{ keep: 'everything' }, /must be an array/],
  ])('refuses malformed args %j at the boundary', (args, message) => {
    const { actor, videoId } = fixture()
    const r = call(actor, { layer_id: videoId, ...args })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(message)
  })

  it('a ripple refusal names the blocker with the cut-list remedy, and leaves the clip unsplit', () => {
    const { actor, track, videoId } = fixture()
    // A title on another lane STARTING inside the span the cut would close.
    const other = root(actor.snapshot()).tracks.find((t) => t.id !== track)!.id
    const blocker = actor.dispatch('add_layer', { track: other, kind: 'color', t_start_us: 2_500_000, t_end_us: 2_800_000 })
    if (!blocker.ok) throw new Error('fixture failed')
    const before = actor.snapshot()
    const r = call(actor, { layer_id: videoId, remove: [{ t_start_us: 2_000_000, t_end_us: 3_000_000 }] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.message).toContain('the cut list would close')
    expect(r.error.message).toContain('leave it out of the ranges removed')
    expect(actor.snapshot()).toBe(before)
  })

  it('dry_run rehearses the same cut — ripple included — and commits nothing', () => {
    const { actor, videoId } = fixture()
    const before = actor.snapshot()
    const r = actor.mcpCall('dry_run', JSON.stringify({ operations: [
      { kind: 'apply_cut_list', layer_id: videoId, keep: [{ t_start_us: 1_000_000, t_end_us: 2_000_000 }] },
      { kind: 'apply_cut_list', layer_id: videoId, remove: [{ t_start_us: 0, t_end_us: 6_000_000 }] },
    ] }))
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    const body = JSON.parse(r.result.content[0].text) as { results: Array<{ status: string; output?: Record<string, unknown>; error?: string }>; halted_at: number | null }
    expect(body.results[0].status).toBe('ok')
    expect(body.results[0].output).toMatchObject({ kind: 'apply_cut_list', removed_us: 5_000_000 })
    // The second op runs against the FIRST one's result: the clip is 1 s long
    // now, so a 6 s range lies outside it.
    expect(body.results[1].status).toBe('error')
    expect(body.halted_at).toBe(1)
    expect(actor.snapshot()).toBe(before)
  })
})

describe('cut-list planning', () => {
  const clip = { id: 'c', t_start_us: 1_000_000, t_end_us: 5_000_000 }
  it('keep → the complement inside the clip, head and tail included', () => {
    expect(cutListRanges(clip, 'keep', [{ t_start_us: 2_000_000, t_end_us: 3_000_000 }])).toEqual([
      { t_start_us: 1_000_000, t_end_us: 2_000_000 }, { t_start_us: 3_000_000, t_end_us: 5_000_000 },
    ])
  })
  it('a range touching an edge costs one cut, and discards are chosen by midpoint', () => {
    const plan = planRangeCut([{ t_start_us: 1_000_000, t_end_us: 2_000_000 }, { t_start_us: 3_000_000, t_end_us: 4_000_000 }], clip)
    expect(plan?.cuts).toEqual([2_000_000, 3_000_000, 4_000_000])
    expect(plan?.discard).toEqual([0, 2])
    expect(plan?.removed_us).toBe(2_000_000)
  })
  it('no range, no plan', () => {
    expect(planRangeCut([], clip)).toBeNull()
  })
})
