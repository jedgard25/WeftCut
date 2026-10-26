// FFmpeg-engine capability machinery: the sticky per-media unusable markers,
// the seek-validated HW codec allow-list, and `pickInitialLane` — the async
// lane-selection entry point `FfmpegSource` calls so it owns lane selection
// itself and the pure resolver never sees a lane. SESSION state — resets on
// reload; the persisted machine truth is main's capability cache, never these
// maps/sets.
import type { FfmpegLane } from "./decodeEngine";
import { hwEligibleOnAnyLane } from "../../../shared/hwLaneEligibility";
import { notifyDecodeCapabilityChange } from './capabilityChanges';
import { isResourceCapacityError } from '../../../shared/resource-policy';
import { HW_BUDGET_EXCEEDED, HW_BUDGET_RESERVATION_MISMATCH } from '../../../shared/ipc';

/// Transient admission pressure, as distinct from a decoder capability verdict.
/// These refusals are owned by the application resource authority (or main's
/// preview HW budget): they describe how busy the machine is right now, not
/// whether this engine can decode this media. Treating one as capability is the
/// production failure this module exists to prevent — it pinned a whole media
/// item to "unsupported" after a 4K scrub exhausted the session budget, and the
/// verdict survived the freed capacity for the rest of the session.
export function isFfmpegCapacityRefusal(reason: unknown): boolean {
  if (isResourceCapacityError(reason)) return true;
  const text = String(reason);
  return text.includes(HW_BUDGET_EXCEEDED) || text.includes(HW_BUDGET_RESERVATION_MISMATCH);
}

/// Only a genuine capability failure may become sticky. Capacity is retryable
/// and must clear itself when the ledger has room again.
export function shouldMarkFfmpegUnusable(reason: unknown): boolean {
  return !isFfmpegCapacityRefusal(reason);
}

/// TWIN of main's `classKeyOf` (src/main/decode-capability.ts) — MUST produce a
/// BYTE-IDENTICAL format string so a renderer-derived key hits the exact cache
/// entry main's HW probe writes/reads. Same shape `codec::pixFmt:res` with the
/// resolution class bucketed on `px = max(w, h)` (sd/hd/uhd/huge) and a null
/// pixFmt interpolated as "unknown". Returns null when `codec` is null
/// (audio/image — no HW video lane). Keep in lockstep with `classKeyOf` if
/// either side's string form ever changes.
export function classKeyOfMedia(m: {
  codec: string | null;
  pix_fmt: string | null;
  width?: number | null;
  height?: number | null;
}): string | null {
  if (!m.codec) return null;
  const px = Math.max(m.width ?? 0, m.height ?? 0);
  const res = px <= 1024 ? "sd" : px <= 2048 ? "hd" : px <= 4096 ? "uhd" : "huge";
  return `${m.codec}::${m.pix_fmt ?? "unknown"}:${res}`;
}

/// The renderer's HW-probe KICK gate: true when ANY lane could host the format,
/// so an everywhere-ineligible codec never lights the HW lane. The per-lane
/// seek-validated sets — and why a static allow-list narrows the probe at all —
/// live in `shared/hwLaneEligibility.ts`.
export function hwEligibleCodec(codec: string | null, pixFmt: string | null): boolean {
  return hwEligibleOnAnyLane(codec, pixFmt);
}

/// Sticky per-media "never try HW again this session" marker. Set when a
/// native-HW transport dies at runtime (device loss, driver reset, session
/// crash); gates `pickInitialLane`, so a subsequent `FfmpegSource` open for
/// this media skips straight to the software lane.
const hwUnusable = new Set<string>();

export function markHwUnusable(mediaId: string, _reason: string): void {
  hwUnusable.add(mediaId);
}

/// Sticky per-media "ffmpeg engine terminally failed this session" marker —
/// the runtime signal behind `DecodeResolveInputs.ffmpegUsable` (decodeEngine.ts).
/// Consumed by `Compositor.ts` (calls `markFfmpegUnusable` on total FfmpegSource
/// failure) and `PixiPreview.tsx` (calls `isFfmpegUnusable` to feed the resolver's
/// `ffmpegUsable` input), keeping the pure resolver untouched.
const ffmpegUnusable = new Set<string>();

export function markFfmpegUnusable(mediaId: string, reason: string): void {
  // Defence in depth: every caller already filters capacity, but this marker is
  // session-sticky per media, so one unfiltered call would reproduce the
  // production bug for every clip of that media. Refuse it here too.
  if (!shouldMarkFfmpegUnusable(reason)) return;
  if (!ffmpegUnusable.has(mediaId)) { ffmpegUnusable.add(mediaId); notifyDecodeCapabilityChange(); }
}

export function forgetFfmpegCapability(mediaId: string): void {
  hwUnusable.delete(mediaId);
  if (ffmpegUnusable.delete(mediaId)) notifyDecodeCapabilityChange();
}

export function isFfmpegUnusable(mediaId: string): boolean {
  return ffmpegUnusable.has(mediaId);
}

/// Resolved lane verdict `pickInitialLane` hands back. Carries the binary lane
/// `FfmpegSource`'s ring/recovery logic keys on PLUS the specific HW lane that
/// passed, so the source can route the hardware transport by lane NAME (the
/// copy-back lanes — Linux NVDEC/VAAPI, macOS VideoToolbox — ride SwTransport;
/// Windows d3d11va rides GpuTransport).
export interface FfmpegLaneResolution {
  /// Binary lane the FfmpegSource ring/recovery logic keys on.
  lane: FfmpegLane;
  /// The specific advertised HW lane that passed (`nvdec` | `vaapi` |
  /// `videotoolbox` | `d3d11va`) when `lane === "hardware"`, else null. Drives
  /// the FfmpegSource transport choice: nvdec/vaapi/videotoolbox ride
  /// SwTransport (copy-back), d3d11va rides GpuTransport.
  hwLane: string | null;
  /// VAAPI DRM render node the verdict was measured on (else null).
  device: string | null;
}

/// Async lane-selection entry point for `FfmpegSource`: consults the sticky
/// `markHwUnusable` marker and the seek-validated HW codec allow-list. An
/// HW-eligible codec with a valid classKey AND a path is probed; missing
/// classKey or path → software (no probe). Resolves `lane: "hardware"` only if
/// the probe succeeds (ok: true) — carrying the resolved HW lane name + device
/// so the caller can pick the matching transport; all other failures
/// (unavailable, marked unusable, ineligible codec, probe rejection/exception)
/// resolve `lane: "software"` with null hwLane/device.
export async function pickInitialLane(
  input: {
    mediaId: string;
    codec: string | null;
    pixFmt: string | null;
    /// Media dimensions for the classKey's resolution bucket — omitting
    /// these collapses `classKeyOfMedia` to the "sd" bucket for every source,
    /// mismatching main's probe cache key.
    width?: number | null;
    height?: number | null;
    componentAvailable: boolean;
  },
  probeFn: (
    path: string,
    classKey: string,
  ) => Promise<{ ok: boolean; lane?: string | null; device?: string | null }> = (p, k) =>
    window.api.decodeCap.probeHw(p, k),
  path?: string,
): Promise<FfmpegLaneResolution> {
  if (!input.componentAvailable) return { lane: "software", hwLane: null, device: null }; // caller shouldn't ask, but be safe
  if (hwUnusable.has(input.mediaId)) return { lane: "software", hwLane: null, device: null };
  if (!hwEligibleCodec(input.codec, input.pixFmt)) return { lane: "software", hwLane: null, device: null };
  // Conditional spread, not `width: input.width` — exactOptionalPropertyTypes
  // rejects assigning `number | null | undefined` to the optional `width?:
  // number | null` field when the key is present with an `undefined` value.
  const classKey = classKeyOfMedia({
    codec: input.codec,
    pix_fmt: input.pixFmt,
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.height !== undefined ? { height: input.height } : {}),
  });
  if (classKey === null || !path) return { lane: "software", hwLane: null, device: null };
  try {
    const r = await probeFn(path, classKey);
    return r.ok
      ? { lane: "hardware", hwLane: r.lane ?? null, device: r.device ?? null }
      : { lane: "software", hwLane: null, device: null };
  } catch {
    return { lane: "software", hwLane: null, device: null };
  }
}

/// Test/e2e hook: forget session verdicts (used by ffmpegCapability.test.ts).
export function resetFfmpegCapabilitySession(): void {
  hwUnusable.clear();
  ffmpegUnusable.clear();
  notifyDecodeCapabilityChange();
}
