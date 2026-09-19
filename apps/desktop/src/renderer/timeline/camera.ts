// Timeline camera: the zoom scale (px/sec) as an out-of-React value.
//
// Why this exists: `pxPerSec` used to be React state on the whole timeline
// tree, so every wheel tick reconciled every track lane, layer block and
// keyframe sub-lane. At a few dozen clips that commit runs tens of ms — the
// zoom jank. The camera splits the two consumers apart:
//
//   - Reactive consumers (the ruler, markers, keyframe lanes, the playhead and
//     the clip previews) subscribe and re-render on zoom. They are a small
//     fraction of the tree.
//   - The clip blocks do NOT subscribe. They read the current value once for
//     their first paint and then keep their geometry in step through a plain
//     imperative subscription, so a zoom writes `left`/`width` on the nodes
//     instead of re-running React over every clip.
//
// Keyed by composition because a timeline Panel is one composition (ADR 0053)
// and two Panels scroll/zoom independently. The unbound row the Dock builds
// before a summary names a root has no composition and shares the empty key —
// no real composition id can collide with it.

import { useCallback, useSyncExternalStore } from "react";

import { DEFAULT_PX_PER_SEC } from "./geometry";

const values = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

/// The record key for a timeline Panel — mirrors `timelineScrollKey`.
export function cameraKey(compositionId: string | null | undefined): string {
  return compositionId ?? "";
}

/// Publish one Panel's scale. Guarded so a repeated value is not a store write
/// (and so the imperative geometry pass does not run for a no-op tick).
export function setCameraPxPerSec(
  compositionId: string | null | undefined,
  pxPerSec: number,
): void {
  if (!Number.isFinite(pxPerSec) || pxPerSec <= 0) return;
  const key = cameraKey(compositionId);
  if (values.get(key) === pxPerSec) return;
  values.set(key, pxPerSec);
  listeners.get(key)?.forEach((cb) => cb());
}

/// Imperative read, for first paint and event-time consumers. `fallback` is
/// what an isolated component test hands in when no Panel ever published (the
/// live app always has a value by the time a block paints).
export function cameraPxPerSec(
  compositionId: string | null | undefined,
  fallback: number = DEFAULT_PX_PER_SEC,
): number {
  return values.get(cameraKey(compositionId)) ?? fallback;
}

/// Subscribe to one Panel's scale changes without re-rendering the subscriber.
/// Returns the unsubscribe. Used by the clip blocks to keep `left`/`width` in
/// step through the DOM rather than through React.
export function subscribeCamera(
  compositionId: string | null | undefined,
  cb: () => void,
): () => void {
  const key = cameraKey(compositionId);
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) listeners.delete(key);
  };
}

/// Reactive read for the components that genuinely redraw on zoom. Falls back
/// to `fallback` (a prop) only when no Panel has ever published under this key
/// — the isolated-component-test case.
export function useCameraPxPerSec(
  compositionId: string | null | undefined,
  fallback: number = DEFAULT_PX_PER_SEC,
): number {
  const subscribe = useCallback(
    (cb: () => void) => subscribeCamera(compositionId, cb),
    [compositionId],
  );
  const get = useCallback(
    () => cameraPxPerSec(compositionId, fallback),
    [compositionId, fallback],
  );
  return useSyncExternalStore(subscribe, get, get);
}
