import { describe, it, expect } from 'vitest'
import { serveProjectResource, buildResourceInjection, compositionSettings } from '../resource-views'
import { createActor } from '../actor'
import { uuidV7Gen } from '../ids'
import { blankProject } from '../model'
import { mediaItemTemplate } from '../mutations/media'
import { groupedProject, root, withGroup } from './fixtures/project'
import { applyAddLayer, colorParams } from '../mutations/add'

function mkActor() {
  const idGen = uuidV7Gen()
  return createActor({ initial: blankProject(idGen, 'rv'), idGen, clock: () => '<TS>' })
}
function text(out: ReturnType<typeof serveProjectResource>): string {
  return (out as { contents: Array<{ text: string }> }).contents[0].text
}

describe('serveProjectResource', () => {
  it('serves project://current as a pretty JSON application/json block', () => {
    const actor = mkActor()
    const out = serveProjectResource('project://current', actor)!
    expect((out as { contents: Array<{ mimeType: string }> }).contents[0].mimeType).toBe('application/json')
    expect(JSON.parse(text(out)).project_id).toBe(actor.snapshot().project_id)
  })
  it('serves project://history with the {ops,cursor,len,checkpoints} shape', () => {
    const actor = mkActor()
    const body = JSON.parse(text(serveProjectResource('project://history', actor)))
    expect(Array.isArray(body.ops)).toBe(true)
    expect(body).toMatchObject({ cursor: expect.any(Number), len: expect.any(Number), checkpoints: expect.any(Array) })
    // Whole stack fits in view(100) → the window IS the stack.
    expect(body.window_start).toBe(0)
  })

  /// The resource serves `view(100)` against a cap of 200, so `ops` is routinely
  /// a WINDOW: `cursor` is an absolute stack index that can sit past the end of
  /// the array handed over, and `evicted: 0` does NOT mean "the first op is the
  /// start of the project". `window_start` is the only field that says where the
  /// window begins — docs/mcp.md promises it.
  it('reports window_start when the stack is longer than the served window', () => {
    const actor = mkActor()
    for (let i = 0; i < 149; i++) {
      const r = actor.mcpCall('add_track', JSON.stringify({ label: `t${i}` }))
      expect(r.ok).toBe(true)
    }
    const body = JSON.parse(text(serveProjectResource('project://history', actor)))
    expect(body.len).toBe(150)          // seed + 149, still under the 200 cap
    expect(body.evicted).toBe(0)        // nothing dropped: the STACK holds it all
    expect(body.ops).toHaveLength(100)  // …but the WINDOW does not
    expect(body.window_start).toBe(50)
    expect(body.cursor).toBe(149)
    // The two identities a consumer needs to read any of it correctly.
    expect(body.window_start + body.ops.length).toBe(body.len)
    expect(body.cursor).toBeGreaterThan(body.ops.length)
  })
  it('serves composition / tracks from the snapshot', () => {
    const actor = mkActor()
    const snap = actor.snapshot()
    // The root's SETTINGS projection, not the whole root (docs/mcp.md: "composition only").
    expect(JSON.parse(text(serveProjectResource('project://composition', actor)))).toEqual(structuredClone(compositionSettings(root(snap))))
    expect(JSON.parse(text(serveProjectResource('project://tracks', actor)))).toHaveLength(root(snap).tracks.length)
  })
  it('serves a single layer for project://layers/{id}', () => {
    const actor = mkActor()
    const track = root(actor.snapshot()).tracks[0].id
    const r = actor.mcpCall('add_color_layer', JSON.stringify({ track_id: track, color: { r: 0, g: 0, b: 0, a: 1 }, t_start_us: 0, t_end_us: 1_000_000 }))
    expect(r.ok).toBe(true)
    const layerId = root(actor.snapshot()).tracks.flatMap((t) => t.layers)[0].id
    expect(JSON.parse(text(serveProjectResource(`project://layers/${layerId}`, actor))).id).toBe(layerId)
  })
  it('throws not-found for an absent layer id', () => {
    expect(() => serveProjectResource('project://layers/gone', mkActor())).toThrow(/not found/)
  })
  it('returns null for the Rust-compute resources', () => {
    const actor = mkActor()
    expect(serveProjectResource('project://compiled', actor)).toBeNull()
    expect(serveProjectResource('media://x/thumbnail', actor)).toBeNull()
    expect(serveProjectResource('composition://meter', actor)).toBeNull()
  })
})

describe('buildResourceInjection', () => {
  it('injects the full project for project://compiled', () => {
    const actor = mkActor()
    expect(JSON.parse(buildResourceInjection('project://compiled', actor.snapshot())).project.project_id)
      .toBe(actor.snapshot().project_id)
  })
  it('injects the resolved MediaItem for media://{id}/...', () => {
    const actor = mkActor()
    const snap = { ...actor.snapshot(), media_pool: { m1: mediaItemTemplate('m1', 'Video', 1_000_000) } } as never
    expect(JSON.parse(buildResourceInjection('media://m1/waveform', snap)).media.id).toBe('m1')
  })
  it('injects media:null when the id is absent', () => {
    const actor = mkActor()
    expect(JSON.parse(buildResourceInjection('media://gone/thumbnail', actor.snapshot())).media).toBeNull()
  })
  it('injects only the MediaItem for the self-contained media://{id}/analysis view (no vlm_config)', () => {
    const actor = mkActor()
    const snap = { ...actor.snapshot(), media_pool: { m1: mediaItemTemplate('m1', 'Video', 1_000_000) } } as never
    const injected = JSON.parse(buildResourceInjection('media://m1/analysis', snap, { qwen3_vl: {} }))
    expect(injected.media.id).toBe('m1')
    expect('vlm_config' in injected).toBe(false)
  })
  // The field names here are the contract with Rust's `ResourceState`. A rename
  // on either side degrades in silence: the reader keys the bare-core view, finds
  // nothing, and every source reports as undescribed.
  it('injects the config AND the whole describe view for media://{id}/description', () => {
    const actor = mkActor()
    const snap = { ...actor.snapshot(), media_pool: { m1: mediaItemTemplate('m1', 'Video', 1_000_000) } } as never
    const injected = JSON.parse(
      buildResourceInjection('media://m1/description', snap, { qwen3_vl: {} }, {
        language: 'zh-CN',
        fps: 2.5,
        focus: 'shot-type',
        preferred: 'byo_endpoint',
      }),
    )
    expect(injected.media.id).toBe('m1')
    expect(injected.vlm_config).toEqual({ qwen3_vl: {} })
    expect(injected.language).toBe('zh-CN')
    expect(injected.describe_fps).toBe(2.5)
    expect(injected.describe_focus).toBe('shot-type')
    // The FOURTH axis, and the one whose absence is hardest to see: the backend
    // the preference resolves and that backend's model label are both hashed
    // into the key, so a read that omitted it would walk the plain availability
    // order and answer out of an entry `describe_clip` never writes.
    expect(injected.describe_preferred).toBe('byo_endpoint')
  })

  // "auto" is the setting's way of saying "no preference" — the same value the
  // tool path declines to send as `preferred_backend`. Sending it would be a tag
  // no backend answers to, which is harmless, but the two sides must state the
  // rule identically or one day only one of them will.
  it('treats an auto preference as no preference', () => {
    const actor = mkActor()
    const snap = { ...actor.snapshot(), media_pool: { m1: mediaItemTemplate('m1', 'Video', 1_000_000) } } as never
    const injected = JSON.parse(
      buildResourceInjection('media://m1/description', snap, {}, { preferred: 'auto' }),
    )
    expect('describe_preferred' in injected).toBe(false)
  })

  // No UI to speak for → nothing injected, so Rust's own defaults decide. The
  // `detectPauses` rule: one statement of a default, on the side that owns it.
  it('injects no view axis the provider has none for', () => {
    const actor = mkActor()
    const snap = { ...actor.snapshot(), media_pool: { m1: mediaItemTemplate('m1', 'Video', 1_000_000) } } as never
    const injected = JSON.parse(buildResourceInjection('media://m1/description', snap, {}))
    expect('language' in injected).toBe(false)
    expect('describe_fps' in injected).toBe(false)
    expect('describe_focus' in injected).toBe(false)
    expect('describe_preferred' in injected).toBe(false)
  })

  it('injects nothing for composition://meter', () => {
    const actor = mkActor()
    expect(buildResourceInjection('composition://meter', actor.snapshot())).toBe('{}')
  })

  // The transcript reader resolves its cache key from the backend the request
  // was transcribed with — the READ half of the durable-transcript contract,
  // so the preference the `transcribe_clip` path injects as `preferred_backend`
  // has to ride in here too. `'auto'` is the same absence as on the describe
  // view (the setting's way of saying "no preference").
  it('injects the transcription preference for media://{id}/transcript, and only it', () => {
    const actor = mkActor()
    const snap = { ...actor.snapshot(), media_pool: { m1: mediaItemTemplate('m1', 'Video', 1_000_000) } } as never
    const withPref = JSON.parse(buildResourceInjection('media://m1/transcript?format=srt', snap, {}, {}, 'whisper_cpp'))
    expect(withPref.media.id).toBe('m1')
    expect(withPref.transcribe_preferred).toBe('whisper_cpp')
    expect('vlm_config' in withPref).toBe(false)
    const bare = JSON.parse(buildResourceInjection('media://m1/transcript', snap))
    expect('transcribe_preferred' in bare).toBe(false)
    const auto = JSON.parse(buildResourceInjection('media://m1/transcript', snap, {}, {}, 'auto'))
    expect('transcribe_preferred' in auto).toBe(false)
  })
})

describe('project://timeline', () => {
  const BLACK = { r: 0, g: 0, b: 0, a: 255 }
  function actorWithClips() {
    const gen = uuidV7Gen()
    const base = blankProject(gen, 'tl')
    const audioId = gen()
    base.media_pool = { [audioId]: mediaItemTemplate(audioId, 'Audio', 10_000_000, true) } as never
    return { actor: createActor({ initial: base, idGen: gen, clock: () => '<TS>' }), audioId }
  }
  function addColor(actor: ReturnType<typeof mkActor>, track: string, s: number, e: number) {
    const r = actor.mcpCall('add_color_layer', JSON.stringify({ track_id: track, color: BLACK, t_start_us: s, t_end_us: e }))
    expect(r.ok).toBe(true)
  }
  function body(out: ReturnType<typeof serveProjectResource>) {
    return JSON.parse(text(out)) as {
      composition: string; total_rows: number; offset: number; limit: number
      rows: Array<{ id: string; track_id: string; label: string | null; kind: string; role: string | null; t_start_us: number; t_end_us: number }>
      gaps: Array<{ track_id: string; s: number; e: number }>
    }
  }

  it('serves an empty envelope on a blank project', () => {
    const actor = mkActor()
    const b = body(serveProjectResource('project://timeline', actor))
    expect(b.composition).toBe(root(actor.snapshot()).id)
    expect(b).toMatchObject({ total_rows: 0, offset: 0, limit: 200, rows: [], gaps: [] })
  })

  it('returns flat compact rows in track order with the gap list', () => {
    const actor = mkActor()
    const track = root(actor.snapshot()).tracks[0].id
    addColor(actor, track, 1_000_000, 2_000_000)
    addColor(actor, track, 4_000_000, 5_000_000)
    const b = body(serveProjectResource('project://timeline', actor))
    expect(b.total_rows).toBe(2)
    expect(b.rows.map((r) => [r.t_start_us, r.t_end_us])).toEqual([[1_000_000, 2_000_000], [4_000_000, 5_000_000]])
    for (const r of b.rows) {
      expect(r).toMatchObject({ track_id: track, label: null, kind: 'Color', role: root(actor.snapshot()).tracks[0].role })
      expect(Object.keys(r).sort()).toEqual(['id', 'kind', 'label', 'role', 't_end_us', 't_start_us', 'track_id'])
    }
    // Leading gap + middle gap; nothing past the last layer.
    expect(b.gaps).toEqual([
      { track_id: track, s: 0, e: 1_000_000 },
      { track_id: track, s: 2_000_000, e: 4_000_000 },
    ])
  })

  it('merges abutting spans and union-overlaps into no gap', () => {
    const actor = mkActor()
    const track = root(actor.snapshot()).tracks[0].id
    addColor(actor, track, 0, 1_000_000)
    addColor(actor, track, 1_000_000, 2_000_000)
    expect(body(serveProjectResource('project://timeline', actor)).gaps).toEqual([])
  })

  it('falls back from track role to the Audio layer role, else null', () => {
    const { actor, audioId } = actorWithClips()
    // Reserved skeleton track carries a role stamp; a fresh track carries none.
    const stamped = root(actor.snapshot()).tracks[0]
    expect(stamped.role).not.toBeNull()
    const r = actor.mcpCall('add_track', JSON.stringify({}))
    expect(r.ok).toBe(true)
    const fresh = root(actor.snapshot()).tracks.at(-1)!
    expect(fresh.role).toBeNull()
    const aud = actor.mcpCall('add_audio_layer', JSON.stringify({
      track_id: fresh.id, media_id: audioId, src_in_us: 0, src_out_us: 2_000_000,
      t_start_us: 0, t_end_us: 2_000_000, role: 'voiceover',
    }))
    expect(aud.ok).toBe(true)
    addColor(actor, stamped.id, 0, 1_000_000)
    const b = body(serveProjectResource('project://timeline', actor))
    expect(b.rows.find((x) => x.kind === 'Audio')!.role).toBe('voiceover')
    expect(b.rows.find((x) => x.kind === 'Color')!.role).toBe(stamped.role)
    addColor(actor, fresh.id, 3_000_000, 4_000_000)
    expect(body(serveProjectResource('project://timeline', actor)).rows.find((x) => x.kind === 'Color' && x.t_start_us === 3_000_000)!.role).toBeNull()
  })

  it('windows rows by overlap and clips gaps to the window', () => {
    const actor = mkActor()
    const track = root(actor.snapshot()).tracks[0].id
    addColor(actor, track, 1_000_000, 2_000_000)
    addColor(actor, track, 4_000_000, 5_000_000)
    const b = body(serveProjectResource('project://timeline?t_start_us=1500000&t_end_us=4500000', actor))
    expect(b.total_rows).toBe(2)
    // [1.5s, 2s) is covered by the first layer — not a gap; the leading gap
    // [0, 1s) misses the window entirely.
    expect(b.gaps).toEqual([{ track_id: track, s: 2_000_000, e: 4_000_000 }])
    const empty = body(serveProjectResource('project://timeline?t_start_us=2000000&t_end_us=4000000', actor))
    expect(empty).toMatchObject({ total_rows: 0, rows: [] })
    expect(empty.gaps).toEqual([{ track_id: track, s: 2_000_000, e: 4_000_000 }])
    // A gap straddling the window edge is clipped to it.
    expect(body(serveProjectResource('project://timeline?t_start_us=2500000&t_end_us=10000000', actor)).gaps)
      .toEqual([{ track_id: track, s: 2_500_000, e: 4_000_000 }])
  })

  it('pages rows with offset/limit and reports the windowed total', () => {
    const actor = mkActor()
    const track = root(actor.snapshot()).tracks[0].id
    addColor(actor, track, 0, 1_000_000)
    addColor(actor, track, 2_000_000, 3_000_000)
    addColor(actor, track, 4_000_000, 5_000_000)
    const b = body(serveProjectResource('project://timeline?offset=1&limit=1', actor))
    expect(b).toMatchObject({ total_rows: 3, offset: 1, limit: 1 })
    expect(b.rows.map((r) => r.t_start_us)).toEqual([2_000_000])
    // Gaps are never paged.
    expect(b.gaps).toHaveLength(2)
  })

  it('scopes to a composition and refuses bad queries', () => {
    const gen = uuidV7Gen()
    const { p, groupId } = groupedProject(gen, 'r')
    const actor = createActor({ initial: p, idGen: gen })
    expect(body(serveProjectResource(`project://timeline?composition=${groupId}`, actor)).composition).toBe(groupId)
    for (const uri of [
      'project://timeline?composition=ghost',
      'project://timeline?limit=0',
      'project://timeline?limit=1001',
      'project://timeline?offset=-1',
      'project://timeline?t_start_us=5',
      'project://timeline?t_start_us=5&t_end_us=5',
      'project://timeline?t_start_us=9&t_end_us=5',
      'project://timeline?limit=many',
    ]) expect(() => serveProjectResource(uri, actor)).toThrow(/not found|timeline/)
  })

  it('read_project view timeline matches the resource', () => {
    const actor = mkActor()
    const track = root(actor.snapshot()).tracks[0].id
    addColor(actor, track, 0, 1_000_000)
    const viaTool = actor.mcpCall('read_project', JSON.stringify({ view: 'timeline', t_start_us: 0, t_end_us: 500_000, limit: 10 }))
    expect(viaTool.ok).toBe(true)
    if (!viaTool.ok) throw new Error('unreachable')
    const toolText = (viaTool.result as { content: Array<{ text: string }> }).content[0].text
    expect(JSON.parse(toolText)).toEqual(JSON.parse(text(serveProjectResource('project://timeline?t_start_us=0&t_end_us=500000&limit=10', actor))))
  })
})

describe('serveProjectResource across compositions', () => {
  it('project://layers/{id} finds a layer inside a Group; project://tracks stays the root', () => {
    const gen = uuidV7Gen()
    const initial = blankProject(gen, 'r')
    const { p, groupId } = withGroup(initial, gen, (g, view) => applyAddLayer(view, gen, g.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 16, 9), 0, 1_000_000))
    const actor = createActor({ initial: p, idGen: gen })
    const inner = p.compositions[groupId].tracks[0].layers[0]
    const text = (r: ReturnType<typeof serveProjectResource>) => (r as { contents: Array<{ text: string }> }).contents[0].text
    expect(JSON.parse(text(serveProjectResource(`project://layers/${inner.id}`, actor))).id).toBe(inner.id)
    expect(JSON.parse(text(serveProjectResource('project://tracks', actor)))).toHaveLength(root(p).tracks.length)
    const comp = JSON.parse(text(serveProjectResource('project://composition', actor)))
    expect(comp.id).toBe(p.root_id)
    expect('tracks' in comp).toBe(false)
  })
})

describe('project://compositions and the ?composition= scope', () => {
  it('lists every composition with its ref_count; tracks / markers select a composition, root when unscoped', () => {
    const gen = uuidV7Gen()
    const { p, groupId } = groupedProject(gen, 'r')
    const actor = createActor({ initial: p, idGen: gen })
    const rows = JSON.parse(text(serveProjectResource('project://compositions', actor)))
    expect(rows).toHaveLength(2)
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: p.root_id, label: null, ref_count: 0 }),
      expect.objectContaining({ id: groupId, ref_count: 1, duration_us: 1_000_000 }),
    ]))
    expect(JSON.parse(text(serveProjectResource(`project://tracks?composition=${groupId}`, actor)))).toHaveLength(1)
    expect(JSON.parse(text(serveProjectResource('project://tracks', actor)))).toHaveLength(root(p).tracks.length)
    expect(JSON.parse(text(serveProjectResource(`project://markers?composition=${groupId}`, actor)))).toEqual([])
    expect(() => serveProjectResource('project://tracks?composition=ghost', actor)).toThrow(/not found/)
  })
})
