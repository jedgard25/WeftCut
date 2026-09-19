// Decoder-output pre-snapshot filter for the WebCodecs preview lane.
// A long-GOP seek decodes the whole GOP prefix before the covering frame,
// and every prefix frame used to pay a full-res `createImageBitmap`
// snapshot (+ GPU upload + ring push, usually stale-dropped on arrival).
// At 4K that is ~33 MB of transient allocation per discarded frame —
// the per-seek stall behind slow scrub updates.
//
// A frame whose presentation interval ends strictly BEFORE the current
// target can never paint: the painter wants the frame COVERING the target
// (or a later one), and `FrameRing.push` would stale-drop it anyway once
// it falls outside the lookbehind window. Such frames are closed
// un-snapshotted. Frames with unknown duration (`<= 0` — WebCodecs may
// report null) are never dropped: without an end bound, non-covering is
// unprovable, and the covering frame itself often carries no duration.

/// True when a decoded output with the given source PTS/duration can never
/// serve `targetUs` and should be closed without snapshotting.
export function shouldDropPrefixOutput(
  ptsUs: number,
  durationUs: number,
  targetUs: number,
): boolean {
  if (durationUs <= 0) return false;
  return ptsUs + durationUs < targetUs;
}
