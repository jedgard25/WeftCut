// On-demand single-frame extraction over the in-process WebCodecs path — the
// JPEG-free replacement for the ffmpeg-per-tile filmstrip producer.
//
// The preview decoder pool is built for *streaming* (lookahead rings, per-tick
// anchoring), which is the wrong shape for a sparse tile grid: one request per
// tile, each wanting exactly one frame. So this drives the same primitives the
// pool is built from — mediabunny's `EncodedPacketSink` (seek to a key packet)
// and `PacketPump` (decode forward) — but with a throwaway decoder and a
// capture ring that stops the pump the moment the target frame lands.
//
// It reuses `SourceMedia` for the expensive once-per-source work (open + parse
// + decoder config + PTS normalization) and for hardware decode selection
// (`hardwareAcceleration: "prefer-hardware"`, i.e. VideoToolbox on macOS). No
// ffmpeg process, no JPEG, no disk round-trip, no IPC.
//
// See docs/render.md and the filmstrip tile engine.

import type { EncodedPacketSink } from "mediabunny";
import type { DecodeClock } from "../../render/decoder/decodeClock";
import { PacketPump, type PumpDecoder, type PumpRing } from "../../render/decoder/PacketPump";
import { SourceMedia } from "../../render/decoder/SourceDecoderPool";

/// Everything needed to open one media for decode. Mirrors the fields the
/// preview pool threads into `SourceMedia`, resolved from the app stores by the
/// caller so this module stays store-agnostic.
export interface FrameProviderSource {
  proxyAssetUrl: string;
  sourceColor?: VideoColorSpaceInit | undefined;
  sourceStartPtsUs?: number | null;
}

export type FrameSourceResolver = (mediaId: string) => FrameProviderSource | null;

/// The subset of `SourceMedia` this provider uses. A seam for tests.
export interface FrameProviderMedia {
  ensureReady(): Promise<VideoDecoderConfig>;
  readonly packetSink: EncodedPacketSink;
  readonly decodeClock: DecodeClock;
  dispose(): void;
}

export interface FrameProviderDeps {
  resolveSource: FrameSourceResolver;
  /// Test seam. Defaults to a real `SourceMedia`.
  openMedia?: (mediaId: string, src: FrameProviderSource) => FrameProviderMedia;
  /// Test seam. Defaults to the global `VideoDecoder`.
  createDecoder?: (init: VideoDecoderInit) => VideoDecoder;
  /// How long to wait for the target frame before rejecting. The caller
  /// falls back to the ffmpeg producer on rejection.
  timeoutMs?: number;
}

export interface FrameCaptureOptions {
  /// Output tile height in px; width follows the frame's aspect.
  height: number;
}

/// A `PumpRing` that never caches: its only job is to stop the pump once the
/// target frame has been captured. `firstPtsUs` stays null so the pump always
/// cold-starts (fresh decoder per request) rather than trying to seek relative
/// to a window it does not keep.
export class CaptureRing implements PumpRing {
  private done = false;

  setAnchor(_tUs: number): void {
    // No window to anchor — each request is a fresh decoder.
  }

  isLookaheadFull(): boolean {
    return this.done;
  }

  flush(): void {
    // Nothing retained to flush.
  }

  firstPtsUs(): number | null {
    return null;
  }

  markDone(): void {
    this.done = true;
  }
}

const DEFAULT_TIMEOUT_MS = 3000;

export class FrameProvider {
  private readonly medias = new Map<string, FrameProviderMedia>();
  private readonly openMedia: (mediaId: string, src: FrameProviderSource) => FrameProviderMedia;
  private readonly createDecoder: (init: VideoDecoderInit) => VideoDecoder;
  private readonly timeoutMs: number;
  private _disposed = false;

  constructor(private readonly deps: FrameProviderDeps) {
    this.openMedia =
      deps.openMedia ??
      ((mediaId, src) =>
        new SourceMedia(mediaId, src.proxyAssetUrl, src.sourceColor, src.sourceStartPtsUs));
    this.createDecoder = deps.createDecoder ?? ((init) => new VideoDecoder(init));
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /// Decode the frame presenting at source time `tUs` and return a new,
  /// caller-owned `ImageBitmap` scaled to `opts.height`. Rejects on timeout or
  /// decoder failure; the caller owns the returned bitmap (close it).
  async getFrameAt(
    mediaId: string,
    tUs: number,
    opts: FrameCaptureOptions,
  ): Promise<ImageBitmap> {
    if (this._disposed) throw new Error("FrameProvider disposed");
    const media = this.ensureMedia(mediaId);
    const config = await media.ensureReady();
    if (this._disposed) throw new Error("FrameProvider disposed");

    return new Promise<ImageBitmap>((resolve, reject) => {
      let settled = false;
      let cleanup: () => void = () => {};
      const ring = new CaptureRing();

      const finish = (bitmap: ImageBitmap): void => {
        if (settled) return;
        settled = true;
        ring.markDone();
        cleanup();
        resolve(bitmap);
      };
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        ring.markDone();
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const timer = setTimeout(() => fail(new Error("frame capture timed out")), this.timeoutMs);

      const decoder = this.createDecoder({
        output: (frame: VideoFrame) => {
          try {
            if (settled) {
              frame.close();
              return;
            }
            const ptsUs = media.decodeClock.sourceUs(frame.timestamp);
            const durationUs = frame.duration ?? 0;
            // Presentation frame for `tUs` covers it (`pts + dur > tUs`); a
            // frame at/after `tUs` is also acceptable when the decoder emits
            // one first (B-frame reorder) or the covering duration is unknown.
            const covers = ptsUs + durationUs > tUs || ptsUs >= tUs;
            if (!covers) {
              frame.close();
              return;
            }
            const displayW = frame.displayWidth || frame.codedWidth;
            const displayH = frame.displayHeight || frame.codedHeight;
            const scale = opts.height > 0 && displayH > 0 ? opts.height / displayH : 1;
            const resizeWidth = Math.max(1, Math.round(displayW * scale));
            const resizeHeight = Math.max(1, Math.round(displayH * scale));
            createImageBitmap(frame, {
              resizeWidth,
              resizeHeight,
              resizeQuality: "low",
            }).then(
              (bitmap) => {
                frame.close();
                finish(bitmap);
              },
              (err: unknown) => {
                frame.close();
                fail(err);
              },
            );
          } catch (err) {
            try {
              frame.close();
            } catch {
              // Already closed.
            }
            fail(err);
          }
        },
        error: (err: unknown) => fail(err),
      });

      const pumpDecoder: PumpDecoder = {
        decode: (chunk) => decoder.decode(chunk),
        reset: () => decoder.reset(),
        configure: () =>
          decoder.configure({ ...config, hardwareAcceleration: "prefer-hardware" }),
        flush: () => decoder.flush(),
        get decodeQueueSize() {
          return decoder.decodeQueueSize;
        },
        get state() {
          return decoder.state;
        },
      };

      decoder.configure({ ...config, hardwareAcceleration: "prefer-hardware" });
      const pump = new PacketPump({
        decoder: pumpDecoder,
        packetSink: media.packetSink,
        ring,
        decodeClock: media.decodeClock,
      });

      cleanup = () => {
        clearTimeout(timer);
        pump.dispose();
        try {
          decoder.close();
        } catch {
          // Decoder may already be closed.
        }
      };

      pump.requestFrameAt(tUs);
    });
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const media of this.medias.values()) media.dispose();
    this.medias.clear();
  }

  private ensureMedia(mediaId: string): FrameProviderMedia {
    const existing = this.medias.get(mediaId);
    if (existing) return existing;
    const src = this.deps.resolveSource(mediaId);
    if (!src) {
      throw new Error(`FrameProvider: no decode source for media ${mediaId}`);
    }
    const media = this.openMedia(mediaId, src);
    this.medias.set(mediaId, media);
    return media;
  }
}
