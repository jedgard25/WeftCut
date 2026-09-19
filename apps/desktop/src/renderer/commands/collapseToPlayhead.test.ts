import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CompositionSummary, LayerSummary } from "../ipc";
import { AUDIO_GRID, frameGrid, snapOnGrid } from "../grid";
import { rootOf, summaryFixture } from "../testing/summaryFixture";
import { collapseKeepRange, collapseToPlayhead } from "./collapseToPlayhead";

const mocks = vi.hoisted(() => ({
  applyCutList: vi.fn(async () => ({ surviving_layer_ids: [], removed: [], removed_us: 0 })),
  tUs: 1_000_000,
  composition: null as CompositionSummary | null,
  selection: new Set<string>() as Set<string>,
}));

vi.mock("../ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc")>()),
  applyCutList: mocks.applyCutList,
}));

vi.mock("../state/playheadProjection", () => ({
  focusedPlayheadUs: () => mocks.tUs,
}));

vi.mock("../state/projectStore", () => ({
  currentOpenComposition: () => mocks.composition,
}));

vi.mock("../state/selectionStore", () => ({
  currentSelection: () => mocks.selection,
  layerIdsOf: (s: ReadonlySet<string>) => s,
}));

vi.mock("../settings/appSettingsStore", () => ({
  displayMode: () => "AbRoll",
}));

vi.mock("../timeline/linkEligibility", () => ({
  linkFanoutActive: () => true,
}));

const FPS = { num: 30, den: 1 };

function colorLayer(id: string, t0: number, t1: number): LayerSummary {
  return {
    id,
    kind: "Color",
    label: id,
    t_start_us: t0,
    t_end_us: t1,
    enabled: true,
    locked: false,
    color_hint: "#888",
    params: { kind: "Color" } as LayerSummary["params"],
    effects: [],
  };
}

function composition(layers: LayerSummary[]): CompositionSummary {
  return rootOf(
    summaryFixture({
      project_id: "p",
      name: "p",
      media: [],
      history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
      audio_roles: [],
      root: {
        width: 640,
        height: 360,
        fps_num: 30,
        fps_den: 1,
        duration_pinned: false,
        fps_locked: false,
        duration_us: 10_000_000,
        tracks: [
          {
            id: "t1",
            kind: "Video",
            label: "t1",
            enabled: true,
            locked: false,
            muted: false,
            solo: false,
            role: "a-roll",
            transient: false,
            layers,
          },
        ],
        markers: [],
        transitions: [],
        links: [],
      },
    }),
  );
}

describe("collapseKeepRange", () => {
  const layer = colorLayer("a", 0, 2_000_000);

  it("keeps the right side for a left collapse", () => {
    expect(collapseKeepRange(layer, 1_000_000, "left", FPS)).toEqual({
      t_start_us: 1_000_000,
      t_end_us: 2_000_000,
    });
  });

  it("keeps the left side for a right collapse", () => {
    expect(collapseKeepRange(layer, 1_000_000, "right", FPS)).toEqual({
      t_start_us: 0,
      t_end_us: 1_000_000,
    });
  });

  it.each([
    ["the in point", 0],
    ["the out boundary", 2_000_000],
    ["before the clip", -1],
    ["after the clip", 3_000_000],
  ])("returns null when the playhead is at %s", (_label, tUs) => {
    expect(collapseKeepRange(layer, tUs, "left", FPS)).toBeNull();
    expect(collapseKeepRange(layer, tUs, "right", FPS)).toBeNull();
  });

  it("snaps an audio edge to the sample lattice at fractional rates", () => {
    const audio = {
      ...colorLayer("au", 0, 2_000_000),
      kind: "Audio",
      params: { kind: "Audio" } as LayerSummary["params"],
    };
    // Off both lattices: the frame snap would be frame 30, the sample snap a
    // lower lattice point. The keep edge must be the SAMPLE one — the frame
    // value is what `apply_cut_list` refuses on an Audio layer.
    const tUs = 1_000_007;
    const keep = collapseKeepRange(audio, tUs, "left", { num: 30_000, den: 1001 });
    expect(keep).not.toBeNull();
    expect(keep!.t_start_us).toBe(snapOnGrid(tUs, AUDIO_GRID));
    expect(keep!.t_start_us).not.toBe(
      snapOnGrid(tUs, frameGrid({ num: 30_000, den: 1001 })),
    );
    expect(keep!.t_end_us).toBe(2_000_000);
  });
});

describe("collapseToPlayhead", () => {
  beforeEach(() => {
    mocks.applyCutList.mockClear();
    mocks.tUs = 1_000_000;
    mocks.selection = new Set<string>();
    mocks.composition = null;
  });

  it("collapses the selected straddling clip left in one commit", async () => {
    mocks.composition = composition([colorLayer("a", 0, 2_000_000)]);
    mocks.selection = new Set(["a"]);

    await collapseToPlayhead("left");

    expect(mocks.applyCutList).toHaveBeenCalledTimes(1);
    expect(mocks.applyCutList).toHaveBeenCalledWith("a", [
      { t_start_us: 1_000_000, t_end_us: 2_000_000 },
    ]);
  });

  it("collapses right, keeping the head", async () => {
    mocks.composition = composition([colorLayer("a", 0, 2_000_000)]);
    mocks.selection = new Set(["a"]);

    await collapseToPlayhead("right");

    expect(mocks.applyCutList).toHaveBeenCalledWith("a", [
      { t_start_us: 0, t_end_us: 1_000_000 },
    ]);
  });

  it("is silent when nothing straddles the playhead", async () => {
    mocks.composition = composition([colorLayer("a", 0, 2_000_000)]);
    mocks.selection = new Set(["a"]);
    mocks.tUs = 5_000_000;

    await collapseToPlayhead("left");

    expect(mocks.applyCutList).not.toHaveBeenCalled();
  });

  it("falls back to the visible straddling clip with no selection", async () => {
    mocks.composition = composition([colorLayer("a", 0, 2_000_000)]);

    await collapseToPlayhead("left");

    // No selection and the clip on the role-stamped lane AbRoll draws: the
    // fallback sweep still finds it — the silence case is the gap, above.
    expect(mocks.applyCutList).toHaveBeenCalledTimes(1);
  });
});
