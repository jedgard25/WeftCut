---
status: accepted
---

# Preview decoders are bounded cursors, and macOS shares VideoToolbox IOSurfaces

Date: 2026-10-26

## Context

A 3840×2160 29.97 H.264/HEVC clip on fast scrub reproduced a production
failure that the decode-engine docs did not cover. Preview kept one native
`FfmpegSource` per *clip* and retained each for the 5 s idle timeout. A scrub
across many clips of one media therefore held 21 live sessions, each charged
~570 MiB by `decodeMemoryMib`, and the shared resource ledger refused the next
`previewSw:open` with `resource-capacity-exceeded`. That transient refusal then
took two wrong paths:

1. `FfmpegSource.onTransportError` called `fireFatal` for it, and
2. `CompositionNode` called `markFfmpegUnusable` — a session-sticky per-media
   verdict. Every clip of that media resolved `unsupported` long after the
   capacity had been freed, and the card's copy blamed the Lite engine even
   when the Standard engine was the one that failed.

On macOS the Standard engine's `videotoolbox` lane is a copy-back lane: the OS
media engine decodes, `av_hwframe_transfer_data` copies the surface to CPU, and
the NV12/P010 bytes cross IPC. That is the same transport as software decode,
and per-frame bytes are the cost. Electron 44's `sharedTexture` API accepts an
`IOSurfaceRef` on macOS (`SharedTextureHandle.ioSurface`), and the component
addon runs in Electron main — the same process that owns the import. A proof
(standalone probe, then the committed e2e gate) showed a decoded
VideoToolbox IOSurface imports as a `VideoFrame`, reaches the renderer, and
`createImageBitmap` returns the source color exactly for a BT.601 chart.

## Decision

### Decode sessions are bounded cursors, not one-per-visited-clip leases

A decoder is stateful from a keyframe forward, so two clips at different source
times cannot share one decoder state. What can and must be shared is lifetime:

- **WebCodecs/Lite** keeps the existing refcounted `SourceMedia` (one open and
  parse per media) plus one decoder + `FrameRing` per clip cursor.
- **FFmpeg/Standard** keeps one decoder session per cursor (clip instance), but
  only cursors in the active + bounded-lookahead plan plus a small LRU retention
  allowance (`MAX_RETAINED_PREVIEW_SESSIONS = 2`) keep a live session. The pool
  trims on every priority change and before a new acquire; the idle sweep is a
  backstop, not the primary bound.
- **Capacity is not capability.** A capacity refusal is retryable with bounded
  exponential backoff, in place, keeping the ring and the resolved lane. Before
  refusing an open, `FfmpegSource` asks the pool to close non-priority sessions
  (any lane — on macOS that means copy-back `previewSw` sessions, which the old
  Windows-HW-lease-only reclaim could not free) and retries once. Only a real
  decode/capability failure may call `fireFatal`/`markFfmpegUnusable`, and
  `markFfmpegUnusable` itself refuses capacity reasons as a second guard.
- The pool numbers (live sessions, retention) are diagnostics, never a
  renderer-side admission authority: main's resource ledger and HW budget still
  decide.

This is **per-clip cursor state with per-media lifetime sharing**, not a
per-media decoder. Many clips of one media at different times are exactly the
case it is designed for: only the visible cursor plus bounded lookahead needs a
session, and a fast pass across twenty clips cannot mint twenty decoders.

### macOS VideoToolbox shares decoded IOSurfaces, behind a feature flag

When `experimental_macos_shared_texture` is on (Settings → Preview, macOS only,
default off), the `videotoolbox` hardware lane uses Electron `sharedTexture`
instead of copy-back:

- native `preview_vt` opens the source on VideoToolbox and retains each decoded
  `CVPixelBuffer`; the first time an IOSurface is seen it emits a slot
  descriptor (handle, dimensions, `nv12`/`p010le`, range), then every delivered
  frame is a tiny `frameReady` poke. The retained CVPixelBuffer is released only
  on the renderer's `consumeAck`, so VideoToolbox cannot recycle the surface
  while Chromium reads it. A bounded outstanding window and a 3 s lease timeout
  keep a stalled consumer from wedging the session.
- main imports each IOSurface **once** (`sharedTexture.importSharedTexture`
  with `handle.ioSurface`) and sends it to the renderer. There is no per-frame
  pixel IPC; the per-frame traffic is the poke.
- the renderer's existing `GpuTransport`/`FrameRing` seam is unchanged: the
  preload turns the imported `VideoFrame` into an `ImageBitmap` with
  `createImageBitmap`, which honors the source colorSpace (the POC's Result 7,
  reconfirmed by the committed e2e gate for BT.601). The frame then enters the
  same ring the WebCodecs and copy-back paths use.
- **Both 8-bit NV12 and 10-bit 4:2:0 P010 are supported.** This lane pins
  VideoToolbox to the **video-range** pool (`'420v'` / `'x420'`), because
  Electron's `nv12`/`p010le` import has no full-range `'420f'`/`'xf44'` surface
  format. VT range-converts the source into that surface, and the import color
  tag is taken from the actual surface, not the source metadata. A full-range
  `yuvj420p` H.264 source — the production crash — now imports; expanding its
  limited luma back to full matches the copy-back decode within 0.3 luma, and
  `shared_vt_lane_converts_full_range_to_video_range` is the native regression.
  The 10-bit P010 path is probe-tested, not yet a full e2e gate.
  The importer also has no 4:2:2/4:4:4 format, so ProRes and any `422`/`444`/`RGB`
  source stays on copy-back by an explicit pre-open eligibility check (it never
  becomes a HW capability verdict). An unexpected CVPixelBuffer format fails
  the session with a `shared-texture-format-unsupported` marker and falls back
  to copy-back without a sticky HW mark; it never renders silently black.
- any failure — import, native session, format — falls back to the existing
  copy-back lane on the same resolved hardware lane. The WebCodecs path,
  export routing, and the `DecoderHandle`/`DecoderPool` seam are untouched.
- the flag is machine-level because the transport depends on this machine's
  GPU/Chromium build. It is off by default until proven in the field; the
  committed e2e gate is `e2e/electron/macos-shared-texture.spec.ts`.

### Heavy sources use their quick proxy automatically; export routing is untouched

The zero-copy lane fixed memory, session count and composite cost, but it did
**not** fix long-GOP seek. A cold seek still has to decode from the preceding
keyframe, and a 240-frame GOP (8 s at 30 fps) is 740 ms of work on the measured
4K fixture. The existing quick proxy is short-GOP by construction, and it is
already built at import for exactly these sources.

Measured on a generated 3840×2160 30 fps, 240-frame-GOP H.264 fixture (8 s):

| phase | cold seek to 4 s | composite max | dropped / late | live sessions | reserved |
|---|---|---|---|---|---|
| original, VideoToolbox IOSurface | 740 ms | 0.9 ms | 0 / 0 | 1 | 286 MiB |
| original, copy-back control | 736 ms | 0.9 ms | 1 / 0 | 1 | 286 MiB |
| 24-clip single-track scrub | — | — | 0 / 0, 0 unsupported cards | max 3 | max 858 MiB |
| **existing quick proxy (auto)** | **109 ms** | 0.9 ms | 0 / 0 | 0 HW | 528 MiB |

**Decision:** a source that is (a) 2160p or larger, (b) on a `direct-export` Decode Route (the long-GOP decodable class that
already plans a quick proxy; `proxied` WebCodecs-blind sources are excluded),
and (c) has that proxy on disk uses the proxy for preview automatically, unless the user chose
**Original** for that clip. This is a new app-level setting
`auto_preview_proxies` (Settings → Preview, default **on**); it reads the
existing `prefer_proxies` / `proxy_overrides` axes, never writes them, and does
not touch export routing, export masters, or the proxy job. The proxy is still
the existing 720p short-GOP quick proxy, built by the existing import job — no
new transcode and no duplicated export logic. A per-clip **Original** choice
wins; a proxy that is not ready yet falls through to the original with no black
frame (the `quickProxyPath` gate).

This is a deliberate exception to "preview always reads the original": it
applies only to the heavy class where the measurement shows a 6.8× cold-seek
win, and it is a user-visible setting. `Bypass` sources have no quick proxy;
`native-sw` sources keep the engine choice the resolver already made.

## Considered options

- **One shared decoder per media with a re-targetable cursor.** Rejected: it
  thrashes when two clips of one media overlap or sit on opposite sides of a
  cut, which is the documented reason the WebCodecs pool has per-clip rings.
- **Keep one decoder per visited clip and raise the ledger limit.** Rejected:
  the memory is real (~570 MiB/reservation at 4K), and a limit high enough for
  a scrub would let background work starve.
- **Treat capacity as a capability failure and fall back to WebCodecs.** This
  is the production bug; it swaps a high-quality hardware lane for a different
  engine because the machine was momentarily busy, and the fallback is sticky.
- **VideoToolbox → Metal → Pixi with no `createImageBitmap` snapshot.**
  Deferred. It would require a native RGB convert (or trusting Chromium's
  WebGPU YUV ingestion, which the POC's Result 5 measured as wrong for 601),
  and a new frame kind in the Compositor. The snapshot is a GPU-side copy, not
  a CPU frame copy, and the measured composite cost is already sub-millisecond.
- **Force preview onto the quick proxy whenever a 4K long-GOP source has one.**
  Rejected on the measurement above and on the existing routing convention.

## Consequences

- The 4K/many-clip/fast-scrub failure is bounded to active + lookahead +
  retention sessions; a capacity refusal is retried and clears itself. The
  regression is `previewCapacityRecovery.test.ts` (simulated 13 GiB ledger,
  24 clips, max ≤6 sessions, no sticky marker), plus the e2e measurement above.
- macOS preview gains a zero-CPU-copy, zero-per-frame-pixel-IPC lane to the
  existing compositor, including 10-bit P010. It is opt-in per machine and
  falls back to copy-back on any failure.
- Reserved memory and decoder count are now bounded by the plan rather than by
  how far the user dragged the playhead. The trade is a small LRU retention
  window: a clip visited and left can be closed sooner than the old 5 s, which
  is a deliberate reuse/peak-memory trade.
- A retained `ImageBitmap` snapshot remains the seam into `FrameRing`; "zero
  copy" here means no CPU frame copy and no per-frame pixel IPC, not that Pixi
  samples the decoder surface directly. The next step beyond that is a native
  RGB convert plus a Compositor frame kind, recorded as future work.
- Heavy sources get the quick proxy automatically once it lands, but the
  original remains one per-clip choice away and is still what `Bypass` sources
  use. Export routing is unchanged.
- The macOS lane is new supply-chain-adjacent code (CoreVideo/IOSurface FFI,
  no new crates) and is feature-flagged; Windows and Linux builds exclude it by
  `cfg(target_os = "macos")`.
