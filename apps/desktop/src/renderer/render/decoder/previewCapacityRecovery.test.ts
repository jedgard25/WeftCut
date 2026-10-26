// @vitest-environment jsdom
//
// Regression for the production 4K fast-scrub failure:
//
//   3840x2160 @ 29.97, many clips of one media, fast scrub
//     -> 21 live native preview sessions, each reserved at ~570 MiB
//     -> work_mib 13107 exhausted
//     -> previewSw:open refused with resource-capacity-exceeded
//     -> the refusal became a session-sticky "ffmpeg unusable" verdict
//
// The invariant under test is not "a refusal never happens" — pressure is real.
// It is that pressure is transient: the pool drops sessions outside the demand
// plan before minting new ones, a refused open reclaims those sessions and
// retries, and nothing turns capacity into a capability verdict.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./transports/GpuTransport", () => ({
  GpuTransport: class {},
}));
vi.mock("../../ipc", () => ({
  logEmit: vi.fn(async () => {}),
}));

import { SourceDecoderPool } from "./SourceDecoderPool";
import { FfmpegSource, type FfmpegSourceInit } from "./FfmpegSource";
import { resetFfmpegCapabilitySession, isFfmpegUnusable } from "./ffmpegCapability";
import type { DecodeTransport } from "./transports/DecodeTransport";

const MIB_PER_4K_SESSION = 570;
const CAPACITY_SESSIONS = 4;

class SessionLedger {
  live = new Set<number>();
  maxLive = 0;
  refusals = 0;
  private next = 1;

  reserve(): () => void {
    if (this.live.size + 1 > CAPACITY_SESSIONS) {
      this.refusals += 1;
      throw new Error(
        `resource-capacity-exceeded: ${this.live.size} sessions at ${MIB_PER_4K_SESSION} MiB`,
      );
    }
    const id = this.next++;
    this.live.add(id);
    this.maxLive = Math.max(this.maxLive, this.live.size);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.live.delete(id);
      }
    };
  }
}

function decodeTransport(ledger: SessionLedger) {
  let release: (() => void) | null = null;
  const t: DecodeTransport = {
    open: vi.fn(async () => {
      release = ledger.reserve();
    }),
    requestFrameAt: vi.fn(),
    onFrame: vi.fn(),
    onError: vi.fn(),
    onEof: vi.fn(),
    dispose: vi.fn(() => {
      release?.();
      release = null;
    }),
  };
  return t;
}

function fourKInit(layerId: string): FfmpegSourceInit {
  return {
    layerId,
    // Many clips of ONE media is the production shape this regression keeps.
    mediaId: "media-4k",
    sourcePath: "C:/fixture-4k.mp4",
    codec: "h264",
    pixFmt: "yuv420p",
    width: 3840,
    height: 2160,
    componentAvailable: true,
  };
}

describe("4K fast-scrub capacity recovery", () => {
  beforeEach(() => resetFfmpegCapabilitySession());
  afterEach(() => resetFfmpegCapabilitySession());

  it("keeps the live set bounded, reclaims on refusal, and never marks the engine unusable", async () => {
    const ledger = new SessionLedger();
    const pool = new SourceDecoderPool({
      makeFfmpegSource: (init, reclaimRetainedCapacity) =>
        new FfmpegSource(init, {
          makeSw: () => decodeTransport(ledger),
          pickLane: async () => ({ lane: "software" as const, hwLane: null, device: null }),
          reclaimRetainedCapacity,
        }),
    });
    const clips = Array.from({ length: 24 }, (_, i) => `clip-${i}`);
    const fatals: Array<{ clip: string; reason: string }> = [];
    let peakPoolSessions = 0;

    try {
      for (let i = 0; i < clips.length; i++) {
        // The Compositor's real plan: active + bounded lookahead. Three
        // sequential cuts is the maximum speculation at one active video.
        const window = clips.slice(i, i + 3);
        await pool.setPriorityKeys(window);
        for (const clip of window) {
          const source = pool.acquire({
            ...fourKInit(clip),
            engine: "ffmpeg",
            proxyAssetUrl: "",
          });
          if (source instanceof FfmpegSource) {
            source.onFatalError((reason) => fatals.push({ clip, reason }));
          }
          // A fast scrub touches each visible clip, so each session is opened
          // and then abandoned as the window moves on.
          await source.ensureReady();
          await source.requestFrameAt(i * 33_333);
        }
        peakPoolSessions = Math.max(peakPoolSessions, pool.liveSessionCount());
      }

      // Pressure was real: a naive one-session-per-visited-clip policy would
      // have needed 24 leases (13.7 GiB), and this ledger refused at 4.
      expect(ledger.refusals).toBeGreaterThan(0);
      // The demand plan (3) plus the retention cache (2) bounds the pool; a
      // pass over 24 clips must not leave 24 sessions resident.
      expect(peakPoolSessions).toBeLessThanOrEqual(6);
      expect(pool.liveSessionCount()).toBeLessThanOrEqual(6);
      expect(ledger.maxLive).toBeLessThanOrEqual(CAPACITY_SESSIONS);

      // No capacity refusal escaped as a decode failure, and the media never
      // acquired the sticky verdict that made every clip "unsupported".
      expect(fatals).toEqual([]);
      expect(isFfmpegUnusable("media-4k")).toBe(false);
    } finally {
      pool.dispose();
    }
  });

  it("reclaims a retained session before refusing a priority open", async () => {
    const ledger = new SessionLedger();
    const pool = new SourceDecoderPool({
      makeFfmpegSource: (init, reclaimRetainedCapacity) =>
        new FfmpegSource(init, {
          makeSw: () => decodeTransport(ledger),
          pickLane: async () => ({ lane: "software" as const, hwLane: null, device: null }),
          reclaimRetainedCapacity,
        }),
    });
    try {
      // Three priority sessions subscribe the 4-slot ledger, leaving one slot.
      await pool.setPriorityKeys(["active", "next-1", "next-2"]);
      for (const clip of ["active", "next-1", "next-2"]) {
        await pool.acquire({ ...fourKInit(clip), engine: "ffmpeg", proxyAssetUrl: "" }).ensureReady();
      }
      // A fourth session (the retained cache) takes the last slot.
      await pool.setPriorityKeys(["active", "next-1", "next-2", "retained"]);
      await pool.acquire({ ...fourKInit("retained"), engine: "ffmpeg", proxyAssetUrl: "" }).ensureReady();
      expect(ledger.live.size).toBe(4);

      // The demand plan moves: "retained" is no longer needed, and a new
      // priority clip needs its slot. The pool must drop it and retry rather
      // than reporting a capacity failure.
      await pool.setPriorityKeys(["active", "next-1", "new-priority"]);
      const fresh = pool.acquire({
        ...fourKInit("new-priority"),
        engine: "ffmpeg",
        proxyAssetUrl: "",
      });
      await expect(fresh.ensureReady()).resolves.toBeUndefined();
      expect((fresh as FfmpegSource).currentLane()).toBe("software");
      expect(ledger.live.size).toBeLessThanOrEqual(CAPACITY_SESSIONS);
      expect(isFfmpegUnusable("media-4k")).toBe(false);
    } finally {
      pool.dispose();
    }
  });
});
