// Collapse a clip to the playhead and close what the cut vacated — FCP's
// trim-to-playhead-plus-ripple in one gesture (`Mod+[` trims the head,
// `Mod+]` trims the tail).
//
// One `apply_cut_list` commit per target layer: keep the side the playhead
// spares, discard the other, ripple the hole closed. The cut fans out across
// links inside that commit (the cut-list engine), so an auto-paired A/V
// couple stays one commit and one undo — which is why targets are deduped to
// one member per link, exactly as `splitAtPlayhead` dedupes its own.
//
// Target resolution is the split's: the SELECTION when anything in it
// straddles the playhead, otherwise every straddling layer the user can see.
// Strict containment (`t_start < tUs < t_end`) first — a playhead parked
// exactly on a cut names an empty removal, and sending it would be a refusal
// for a key that did nothing wrong.
//
// The keep edge is snapped to the layer's OWN lattice before sending (the
// sample lattice for Audio at fractional rates, where a frame-anchored
// playhead is off-grid): `apply_cut_list` refuses off-grid edges rather than
// moving the cut, so the snap is the caller's. A snap that lands on the
// layer's own edge collapses the keep range and the target is skipped.
//
// Reads its inputs live and holds no React state, like `splitAtPlayhead`:
// keyboard dispatch, search palette, and (later) the Quick Actions strip.

import {
  applyCutList,
  type CompositionSummary,
  type LayerSummary,
} from "../ipc";
import { displayMode } from "../settings/appSettingsStore";
import { focusedPlayheadUs } from "../state/playheadProjection";
import { currentOpenComposition } from "../state/projectStore";
import { currentSelection, layerIdsOf } from "../state/selectionStore";
import { gridForLayerKind, snapOnGrid } from "../grid";
import { linkFanoutActive } from "../timeline/linkEligibility";
import { resolveSplitTargets } from "./splitAtPlayhead";

export type CollapseDirection = "left" | "right";

function layerById(
  composition: CompositionSummary,
  layerId: string,
): LayerSummary | null {
  for (const track of composition.tracks) {
    const layer = track.layers.find((l) => l.id === layerId);
    if (layer) return layer;
  }
  return null;
}

/**
 * The keep range collapsing `layer` to `tUs` on `direction`'s spared side, or
 * null when there is nothing to remove: the playhead outside the clip (the
 * resolver never sends those, but the command re-checks after its own snap),
 * or a snap that lands on the layer's own edge — half a quantum from it — and
 * collapses the range the actor would refuse.
 *
 * Pure, so the edge arithmetic is pinned without store or IPC doubles.
 */
export function collapseKeepRange(
  layer: Pick<LayerSummary, "t_start_us" | "t_end_us" | "params">,
  tUs: number,
  direction: CollapseDirection,
  fps: { num: number; den: number },
): { t_start_us: number; t_end_us: number } | null {
  const edge = snapOnGrid(tUs, gridForLayerKind(layer.params.kind, fps));
  if (edge <= layer.t_start_us || edge >= layer.t_end_us) return null;
  return direction === "left"
    ? { t_start_us: edge, t_end_us: layer.t_end_us }
    : { t_start_us: layer.t_start_us, t_end_us: edge };
}

/**
 * Collapse every target to the playhead on `direction`'s side.
 *
 * Silent when nothing straddles the playhead — the same answer `splitAtPlayhead`
 * gives, for the same key-over-a-gap. Rejections propagate through
 * `runCommandWithLogging` (the ripple's refusals name their blocker); a
 * failure part-way stops the loop and the clips already collapsed stay
 * collapsed, each collapse being its own commit.
 */
export async function collapseToPlayhead(
  direction: CollapseDirection,
): Promise<void> {
  const composition = currentOpenComposition();
  if (!composition) return;
  // Read ONCE: the playhead moves under playback, and resolving against one
  // instant while cutting at another would send a time outside the clip the
  // resolve picked.
  const tUs = focusedPlayheadUs();
  const fanout = linkFanoutActive();
  const targets = resolveSplitTargets(
    composition,
    tUs,
    layerIdsOf(currentSelection()),
    displayMode() === "AbRoll",
    fanout,
  );
  const fps = { num: composition.fps_num, den: composition.fps_den };
  for (const target of targets) {
    const layer = layerById(composition, target.layerId);
    if (!layer) continue;
    const keep = collapseKeepRange(layer, tUs, direction, fps);
    if (!keep) continue;
    await applyCutList(target.layerId, [keep]);
  }
}
