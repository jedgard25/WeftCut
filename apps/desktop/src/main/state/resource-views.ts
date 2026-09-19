import type { ServerResult } from '@modelcontextprotocol/sdk/types.js'
import type { ActorHandle } from './actor'
import type { Composition, Layer, Project } from './model'
import { eachLayer, rootComposition } from './model'
import { serializeProject } from './serialize'

const APP_JSON = 'application/json'
const PREFIX_LAYERS = 'project://layers/'
const PREFIX_MEDIA = 'media://'

/** Build a Rust-faithful text ResourceResult: one application/json content block
 *  whose `text` is the pretty-printed body (matches resources.rs `text_resource`). */
function textResource(uri: string, body: unknown): ServerResult {
  return { contents: [{ uri, mimeType: APP_JSON, text: JSON.stringify(body, null, 2) }] } as unknown as ServerResult
}

/** `project://composition` keeps its documented meaning — canvas size, fps,
 *  sample rate, colour space, background (docs/mcp.md) — by projecting the root's
 *  SETTINGS. Emitting the whole root would ship every track on a resource an
 *  agent reads for the frame size. */
export function compositionSettings(c: Composition): Record<string, unknown> {
  return { id: c.id, label: c.label, width: c.width, height: c.height, fps: c.fps, duration_us: c.duration_us,
    duration_pinned: c.duration_pinned, sample_rate: c.sample_rate, channels: c.channels,
    color_space: c.color_space, background: c.background }
}

/** One compact timeline row — the layer envelope an agent needs to plan an
 *  edit, without the params/effects weight of `project://tracks`. `role` is
 *  the track's role stamp, falling back to the Audio layer's own mixing role
 *  (dialogue/music/sfx/voiceover), else null. Full detail stays on
 *  `project://layers/{id}`. */
export interface TimelineRow {
  id: string; track_id: string; label: string | null; kind: string; role: string | null
  t_start_us: number; t_end_us: number
}

/** One gap on one track — the whole empty span between two layer boundaries
 *  (or composition 0 and the first layer's start), read off the union of every
 *  layer's span whatever its class, so a half-empty combined A/V row is not
 *  one. The space after a track's last layer is not a gap. When the read
 *  carries a window the gaps are clipped to it. */
export interface TimelineGap { track_id: string; s: number; e: number }

const TIMELINE_DEFAULT_LIMIT = 200
const TIMELINE_MAX_LIMIT = 1000

function parseTimelineInt(raw: string | null, field: string): number | null {
  if (raw === null) return null
  if (!/^-?\d+$/.test(raw)) resourceNotFound(`project://timeline: ${field} not an integer: '${raw}'`)
  return Number(raw)
}

/** Serve `project://timeline` — flat compact rows plus the gap list.
 *  `?composition=<id>` selects a Group's composition (root when absent).
 *  `?t_start_us=&t_end_us=` is the primary axis: a window in composition µs,
 *  keeping rows (and gaps, clipped) that overlap `[t_start_us, t_end_us)`.
 *  `?offset=&limit=` pages the rows (defaults 0 / 200, max 1000) for
 *  bulk enumeration; gaps are always complete within the window. */
export function timelineView(
  p: Project,
  query: URLSearchParams,
): { composition: string; total_rows: number; offset: number; limit: number; rows: TimelineRow[]; gaps: TimelineGap[] } {
  const c = scopedComposition(p, query.get('composition'))
  const wStart = parseTimelineInt(query.get('t_start_us'), 't_start_us')
  const wEnd = parseTimelineInt(query.get('t_end_us'), 't_end_us')
  if ((wStart === null) !== (wEnd === null))
    resourceNotFound('project://timeline: t_start_us and t_end_us name a window together — send both or neither')
  if (wStart !== null && wEnd !== null && wEnd <= wStart)
    resourceNotFound(`project://timeline: t_end_us (${wEnd}) must be greater than t_start_us (${wStart})`)
  const offset = parseTimelineInt(query.get('offset'), 'offset') ?? 0
  const limit = parseTimelineInt(query.get('limit'), 'limit') ?? TIMELINE_DEFAULT_LIMIT
  if (offset < 0) resourceNotFound(`project://timeline: offset (${offset}) must be >= 0`)
  if (limit <= 0 || limit > TIMELINE_MAX_LIMIT)
    resourceNotFound(`project://timeline: limit (${limit}) must be within 1..${TIMELINE_MAX_LIMIT}`)

  const inWindow = (s: number, e: number): boolean =>
    wStart === null || wEnd === null || (s < wEnd && e > wStart)
  const clip = (s: number, e: number): [number, number] =>
    wStart === null || wEnd === null ? [s, e] : [Math.max(s, wStart), Math.min(e, wEnd)]

  const rows: TimelineRow[] = []
  const gaps: TimelineGap[] = []
  for (const track of c.tracks) {
    // Layers are stored sorted by t_start_us; the union walk below relies on it.
    const sorted = [...track.layers].sort((a, b) => a.t_start_us - b.t_start_us)
    for (const layer of sorted) {
      if (!inWindow(layer.t_start_us, layer.t_end_us)) continue
      rows.push({
        id: layer.id, track_id: track.id, label: layer.label, kind: layer.params.kind,
        role: track.role ?? (layer.params.kind === 'Audio' ? layer.params.role : null),
        t_start_us: layer.t_start_us, t_end_us: layer.t_end_us,
      })
    }
    // Union of every layer's span, whatever its class; gaps are the complement
    // within [0, last end). Abutting spans (next start == run end) are not gaps.
    let runEnd: number | null = null
    for (const layer of sorted) {
      if (runEnd === null) {
        if (layer.t_start_us > 0) {
          const [s, e] = clip(0, layer.t_start_us)
          if (s < e) gaps.push({ track_id: track.id, s, e })
        }
        runEnd = layer.t_end_us
      } else if (layer.t_start_us > runEnd) {
        const [s, e] = clip(runEnd, layer.t_start_us)
        if (s < e) gaps.push({ track_id: track.id, s, e })
        runEnd = layer.t_end_us
      } else {
        runEnd = Math.max(runEnd, layer.t_end_us)
      }
    }
  }
  const total_rows = rows.length
  return { composition: c.id, total_rows, offset, limit, rows: rows.slice(offset, offset + limit), gaps }
}

/** Throw the SDK-shaped not-found error (code -32601), mirroring Rust's
 *  `McpToolError::resource_not_found`. */
function resourceNotFound(message: string): never {
  const e = new Error(message) as Error & { code?: number }
  e.code = -32601
  throw e
}

/** `project://compositions` rows: every composition with how many
 *  `CompositionRef` layers point at it — 0 for the root (never referenced) and
 *  for an orphan, which is legal state (ADR 0052 §3). */
export function compositionListing(p: Project): Array<{ id: string; label: string | null; duration_us: number; ref_count: number }> {
  const refs = new Map<string, number>()
  for (const { layer } of eachLayer(p))
    if (layer.params.kind === 'CompositionRef') refs.set(layer.params.composition, (refs.get(layer.params.composition) ?? 0) + 1)
  return Object.values(p.compositions).map((c) => ({ id: c.id, label: c.label, duration_us: c.duration_us, ref_count: refs.get(c.id) ?? 0 }))
}

/** The composition a `?composition=<id>` query selects, the root when absent.
 *  Not-found for an unknown id, so an agent that guessed wrong learns it from
 *  the read rather than from an empty track list. */
function scopedComposition(p: Project, query: string | null): Composition {
  if (query === null) return rootComposition(p)
  const c = p.compositions[query]
  if (!c) return resourceNotFound(`composition ${query} not found`)
  return c
}

/** Serve a `project://*` state-view resource directly from the actor (the sole
 *  state owner): returns the wire ResourceResult, or `null` when the URI
 *  is a Rust-compute resource (`project://compiled`, `media://*`,
 *  `composition://meter`) the host forwards to the backend with an injected slice.
 *  Throws not-found for a bad `project://layers/{id}` URI or an unknown
 *  `?composition=` id. */
export function serveProjectResource(
  uri: string,
  actor: Pick<ActorHandle, 'snapshot' | 'historyView'>,
): ServerResult | null {
  if (uri.startsWith(PREFIX_LAYERS)) {
    const tail = uri.slice(PREFIX_LAYERS.length)
    const slash = tail.indexOf('/')
    if (slash !== -1) resourceNotFound(`unsupported layer sub-resource '${tail.slice(slash + 1)}'`)
    let layer: Layer | undefined
    for (const e of eachLayer(actor.snapshot())) if (e.layer.id === tail) { layer = e.layer; break }
    if (!layer) resourceNotFound(`layer ${tail} not found`)
    return textResource(uri, layer)
  }
  // `project://tracks` and `project://markers` are per composition:
  // `?composition=<id>` selects one, absent means the root.
  const q = uri.indexOf('?')
  const base = q === -1 ? uri : uri.slice(0, q)
  const composition = q === -1 ? null : new URLSearchParams(uri.slice(q + 1)).get('composition')
  switch (base) {
    case 'project://current': return textResource(uri, serializeProject(actor.snapshot()))
    case 'project://composition': return textResource(uri, compositionSettings(rootComposition(actor.snapshot())))
    case 'project://compositions': return textResource(uri, compositionListing(actor.snapshot()))
    case 'project://media': return textResource(uri, actor.snapshot().media_pool)
    case 'project://tracks': return textResource(uri, scopedComposition(actor.snapshot(), composition).tracks)
    case 'project://timeline': return textResource(uri, timelineView(actor.snapshot(), new URLSearchParams(q === -1 ? '' : uri.slice(q + 1))))
    case 'project://markers': return textResource(uri, scopedComposition(actor.snapshot(), composition).markers)
    case 'project://history': return textResource(uri, actor.historyView(100))
    default: return null
  }
}

/** The description cache-key inputs the app's UI owns, as one value.
 *
 *  Grouped because they are one thing — the VIEW a read resolves — and because
 *  `media://{id}/description` is addressed by URI and has no argument to carry
 *  them. Every field optional: a caller with no UI to speak for injects nothing
 *  and Rust's own defaults decide. */
export interface DescribeView {
  language?: string | null
  fps?: number | null
  focus?: string | null
  /** The SOFT preferred engine, `'auto'` or null for none. A cache-key axis like
   *  the other three — the resolved backend and its model label are both hashed
   *  into the key — so a read that omitted it would answer out of whatever the
   *  plain availability order picks while `describe_clip` writes under the
   *  preferred engine, and the rows would report every source as undescribed. */
  preferred?: string | null
}

/** Build the injected-state JSON the backend's `mcpReadResource` needs for the
 *  resources that stay Rust compute: `project://compiled` gets the full
 *  project (audio mix plan); `media://*` gets the MediaItem resolved by id;
 *  `composition://meter` gets nothing. */
export function buildResourceInjection(
  uri: string,
  snapshot: Project,
  vlmConfig: Record<string, unknown> = {},
  view: DescribeView = {},
  transcribePreferred: string | null = null,
): string {
  if (uri === 'project://compiled') return JSON.stringify({ project: serializeProject(snapshot) })
  if (uri.startsWith(PREFIX_MEDIA)) {
    const rest = uri.slice(PREFIX_MEDIA.length)
    const slash = rest.indexOf('/')
    const id = slash === -1 ? rest : rest.slice(0, slash)
    const sub = slash === -1 ? '' : rest.slice(slash + 1).split('?')[0]
    const media = snapshot.media_pool[id] ?? null
    // media://{id}/description additionally needs the merged VLM backend config
    // (stateless, ADR 0024) so the cached-view reader can resolve the backend +
    // compute the cache key — and the four view axes that are part of that same
    // key, from the one provider `describe_clip`'s injection also reads. The
    // always-computable media reads (/thumbnail, /frame, /waveform, and the
    // shot-layer /analysis view) are self-contained — they need only the
    // resolved MediaItem, no injected config.
    if (sub === 'description') {
      // Each axis omitted when there is no UI to speak for, so Rust's own
      // default decides — the `detectPauses` rule, stated once here rather
      // than once per axis. `'auto'` is such an absence: it is the setting's way
      // of saying "no preference", and the same value the tool path declines to
      // send as `preferred_backend` (`mcp/server.ts`).
      return JSON.stringify({
        media,
        vlm_config: vlmConfig,
        ...(view.language ? { language: view.language } : {}),
        ...(view.fps == null ? {} : { describe_fps: view.fps }),
        ...(view.focus ? { describe_focus: view.focus } : {}),
        ...(view.preferred && view.preferred !== 'auto'
          ? { describe_preferred: view.preferred }
          : {}),
      })
    }
    // media://{id}/transcript needs the same preference the `transcribe_clip`
    // tool path injects as `preferred_backend`: the transcript key carries the
    // backend that served the request, so a read that dropped it would look
    // under another engine's entry. The speech config itself lives on the
    // backend (unlike the stateless VLM config), so only the hint rides in.
    if (sub === 'transcript') {
      return JSON.stringify({
        media,
        ...(transcribePreferred && transcribePreferred !== 'auto'
          ? { transcribe_preferred: transcribePreferred }
          : {}),
      })
    }
    return JSON.stringify({ media })
  }
  return '{}'
}
