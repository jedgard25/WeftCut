import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary, LayerSummary, TrackSummary } from '../ipc';
import type { ProjectPublication } from '../../shared/projectPublication';

const mocks = vi.hoisted(() => ({ read: vi.fn(), unlisten: vi.fn(),
  onProjectChanged: null as ((event: any) => void) | null }));
vi.mock('../bridge/ipc', () => ({ invokeRaw: (...args: unknown[]) => mocks.read(...args) }));
vi.mock('@/bridge/events', () => ({
  listen: vi.fn(async (_event: string, callback: (event: any) => void) => {
    mocks.onProjectChanged = callback;
    return mocks.unlisten;
  }),
}));
import { refreshProjectStore, settleProjectStore, useProjectStore, wireProjectStore, groupAvPassthrough } from './projectStore';
import { compositionFixture, ROOT_ID, summaryFixture } from '../testing/summaryFixture';

const publication = (name: string | null, revision: number): ProjectPublication<ProjectSummary> => ({
  version: { session: 1, revision }, summary: name === null ? null : summaryFixture({ name }),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const changed = (revision: number) => mocks.onProjectChanged!({ payload: { publication: { session: 1, revision } } });
async function tick() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

describe('project publication store adapter', () => {
  let unwire: (() => void) | undefined;
  beforeEach(() => {
    mocks.read.mockReset(); mocks.unlisten.mockReset();
    useProjectStore.getState().apply(null);
  });
  afterEach(() => { unwire?.(); unwire = undefined; vi.restoreAllMocks(); });
  async function seed() {
    mocks.read.mockResolvedValueOnce(publication('baseline', 0));
    unwire = await wireProjectStore();
    expect(mocks.read).toHaveBeenCalledWith('project_publication', undefined);
  }
  it('publishes only the latest observed revision and joins mutation callbacks without redundant reads', async () => {
    await seed();
    const first = deferred<ProjectPublication<ProjectSummary>>();
    const last = deferred<ProjectPublication<ProjectSummary>>();
    mocks.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    changed(1);
    for (let i = 2; i <= 101; i++) changed(i);
    const settling = settleProjectStore();
    expect(mocks.read).toHaveBeenCalledTimes(2);
    first.resolve(publication('stale', 1));
    await tick();
    expect(useProjectStore.getState().summary?.name).toBe('baseline');
    last.resolve(publication('latest', 101));
    await settling;
    await settleProjectStore();
    expect(mocks.read).toHaveBeenCalledTimes(3);
    expect(useProjectStore.getState().summary?.name).toBe('latest');
  });
  it('allows an intentional same-version refresh of derived availability', async () => {
    await seed();
    mocks.read.mockResolvedValueOnce(publication('external file arrived', 0));
    await refreshProjectStore();
    expect(useProjectStore.getState().summary?.name).toBe('external file arrived');
  });
  it('preserves the last good snapshot after failure and clears only on actual close', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await seed();
    mocks.read.mockRejectedValueOnce(new Error('connection lost'));
    await expect(refreshProjectStore()).rejects.toThrow();
    expect(useProjectStore.getState().summary?.name).toBe('baseline');
    mocks.read.mockResolvedValueOnce(publication(null, 1));
    changed(1);
    await settleProjectStore();
    expect(useProjectStore.getState().summary).toBeNull();
    expect(useProjectStore.getState().ready).toBe(true);
  });
  it('reports initial failure without publishing a fabricated closed snapshot', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useProjectStore.getState().apply(publication('retained', 0).summary);
    mocks.read.mockRejectedValueOnce(new Error('temporarily unavailable'));
    unwire = await wireProjectStore();
    expect(useProjectStore.getState().summary?.name).toBe('retained');
    expect(console.error).toHaveBeenCalled();
  });
  it('teardown prevents a pending read from publishing', async () => {
    await seed();
    const pending = deferred<ProjectPublication<ProjectSummary>>();
    mocks.read.mockReturnValueOnce(pending.promise);
    changed(1);
    unwire!(); unwire = undefined;
    pending.resolve(publication('late', 1));
    await tick();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(useProjectStore.getState().summary?.name).toBe('baseline');
  });
});

describe("indices span every composition", () => {
  const stat = <T,>(value: T) => ({ mode: "Static" as const, value });
  const color = (id: string): LayerSummary => ({
    id, label: null, t_start_us: 0, t_end_us: 1_000_000, kind: "Color", color_hint: "#000000",
    enabled: true, locked: false, effects: [],
    params: { kind: "Color", color: stat({ r: 0, g: 0, b: 0, a: 255 }), width: 16, height: 9 },
  });
  const clip = (id: string, mediaId: string): LayerSummary => ({
    id, label: null, t_start_us: 0, t_end_us: 1_000_000, kind: "VideoClip", color_hint: "#000000",
    enabled: true, locked: false, effects: [],
    params: {
      kind: "VideoClip", media_id: mediaId, media_label: mediaId,
      src_in_us: 0, src_out_us: 1_000_000,
      x: stat(0), y: stat(0), scale_x: stat(1), scale_y: stat(1), scale_linked: true,
      rotation_deg: stat(0), opacity: stat(1), anchor_x: stat(0.5), anchor_y: stat(0.5),
      speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
    },
  });
  const track = (id: string, layers: LayerSummary[]): TrackSummary => ({
    id, kind: "Video", label: null, enabled: true, locked: false, muted: false, solo: false,
    role: null, transient: true, layers,
  });

  it('retains unchanged tracks and indices across marker-only IPC snapshots, but publishes actual layer edits', () => {
    const make = () => summaryFixture({ root: { tracks: [track('t', [color('a'), color('b')])], markers: [
      { id: 'm', t_us: 0, end_t_us: null, label: '', note: '', color_hint: '#ffffff',
        anchor_layer: null, anchor_src_us: null, hibernating: false },
    ] } });
    useProjectStore.getState().apply(make());
    const before = useProjectStore.getState();
    const moved = make(); moved.compositions[ROOT_ID]!.markers[0]!.t_us = 500_000;
    useProjectStore.getState().apply(moved);
    const after = useProjectStore.getState();
    expect(after.summary!.compositions[ROOT_ID]!.tracks).toBe(before.summary!.compositions[ROOT_ID]!.tracks);
    expect(after.summary!.compositions[ROOT_ID]!.markers[0]!.t_us).toBe(500_000);
    expect(before.summary!.compositions[ROOT_ID]!.markers[0]!.t_us).toBe(0);
    expect(after.layerById).toBe(before.layerById);
    expect(after.groupOrdinals).toBe(before.groupOrdinals);
    const edited = make(); edited.compositions[ROOT_ID]!.tracks[0]!.layers[0]!.label = 'Changed';
    useProjectStore.getState().apply(edited);
    expect(useProjectStore.getState().layerById.get('a')!.label).toBe('Changed');
    expect(useProjectStore.getState().layerById.get('b')).toBe(before.layerById.get('b'));
  });

  it("resolves a layer inside a Group to its layer, track and composition", () => {
    useProjectStore.getState().apply(
      summaryFixture({
        root: { tracks: [track("t-root", [color("root-a")])] },
        groups: [compositionFixture({ id: "comp-g1", tracks: [track("t-g1", [color("inner-a")])] })],
      }),
    );
    const s = useProjectStore.getState();
    expect(s.layerById.get("inner-a")?.id).toBe("inner-a");
    expect(s.trackIdByLayerId.get("inner-a")).toBe("t-g1");
    expect(s.compositionIdByLayerId.get("inner-a")).toBe("comp-g1");
    expect(s.compositionIdByLayerId.get("root-a")).toBe(ROOT_ID);
    expect(s.compositionIdByTrackId.get("t-g1")).toBe("comp-g1");
    expect(s.compositionIdByTrackId.get("t-root")).toBe(ROOT_ID);
    useProjectStore.getState().apply(null);
    expect(useProjectStore.getState().compositionIdByLayerId.size).toBe(0);
  });

  it("counts media references across compositions, one Map per summary", () => {
    const seed = () =>
      useProjectStore.getState().apply(
        summaryFixture({
          root: { tracks: [track("t-root", [clip("root-a", "m-1")])] },
          groups: [
            compositionFixture({
              id: "comp-g1",
              tracks: [track("t-g1", [clip("inner-a", "m-1"), clip("inner-b", "m-2")])],
            }),
          ],
        }),
      );
    seed();
    const counts = useProjectStore.getState().mediaRefCounts;
    // A clip inside a Group is a reference: the pool spans the whole project,
    // and an item used only inside a Group is not unused.
    expect(counts.get("m-1")).toBe(2);
    expect(counts.get("m-2")).toBe(1);
    // Stable while the references are unchanged, even across IPC snapshots.
    expect(useProjectStore.getState().mediaRefCounts).toBe(counts);
    seed();
    expect(useProjectStore.getState().mediaRefCounts).toBe(counts);
    useProjectStore.getState().apply(null);
    expect(useProjectStore.getState().mediaRefCounts.size).toBe(0);
  });
});

describe("groupAvPassthrough", () => {
  const stat = <T,>(value: T) => ({ mode: "Static" as const, value });
  const video = (id: string, t0: number, t1: number, src0 = 0, src1 = 4_000_000, mediaId = "m-v"): LayerSummary => ({
    id, label: null, t_start_us: t0, t_end_us: t1, kind: "VideoClip", color_hint: "#000000",
    enabled: true, locked: false, effects: [],
    params: {
      kind: "VideoClip", media_id: mediaId, media_label: mediaId,
      src_in_us: src0, src_out_us: src1,
      x: stat(0), y: stat(0), scale_x: stat(1), scale_y: stat(1), scale_linked: true,
      rotation_deg: stat(0), opacity: stat(1), anchor_x: stat(0.5), anchor_y: stat(0.5),
      speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
    },
  });
  const audio = (id: string, t0: number, t1: number, src0 = 0, src1 = 4_000_000, mediaId = "m-a"): LayerSummary => ({
    id, label: null, t_start_us: t0, t_end_us: t1, kind: "Audio", color_hint: "#000000",
    enabled: true, locked: false, effects: [],
    params: {
      kind: "Audio", media_id: mediaId, media_label: mediaId,
      src_in_us: src0, src_out_us: src1,
      gain_db: stat(0), pan: stat(0), fade_in_us: 0, fade_out_us: 0, mute: false, role: "dialogue",
    },
  });
  const text = (id: string): LayerSummary => ({
    id, label: null, t_start_us: 0, t_end_us: 4_000_000, kind: "Text", color_hint: "#000000",
    enabled: true, locked: false, effects: [],
    params: { kind: "Text" } as LayerSummary["params"],
  });
  const lane = (id: string, layers: LayerSummary[]): TrackSummary => ({
    id, kind: "Video", label: null, enabled: true, locked: false, muted: false, solo: false,
    role: null, transient: true, layers,
  });
  const comp = (layers: LayerSummary[][], duration = 4_000_000) =>
    compositionFixture({ id: "comp-g1", duration_us: duration, tracks: layers.map((ls, i) => lane(`t-${i}`, ls)) });

  it("passes one video covering the window straight through", () => {
    expect(groupAvPassthrough(comp([[video("v", 0, 4_000_000)]]), 0, 4_000_000)).toEqual({
      video: { layerId: "v", mediaId: "m-v", srcInUs: 0, srcOutUs: 4_000_000 },
      audio: null,
    });
  });

  it("passes video plus audio, each mapped", () => {
    expect(
      groupAvPassthrough(comp([[video("v", 0, 4_000_000)], [audio("a", 0, 4_000_000)]]), 0, 4_000_000),
    ).toEqual({
      video: { layerId: "v", mediaId: "m-v", srcInUs: 0, srcOutUs: 4_000_000 },
      audio: { layerId: "a", mediaId: "m-a", srcInUs: 0, srcOutUs: 4_000_000 },
    });
  });

  it("offsets the media range when the Group window is trimmed", () => {
    // Inner clip runs [0, 4s) of media [500k, 4.5M); the Group shows [1s, 3s).
    const c = comp([[video("v", 0, 4_000_000, 500_000, 4_500_000)]]);
    expect(groupAvPassthrough(c, 1_000_000, 3_000_000)).toEqual({
      video: { layerId: "v", mediaId: "m-v", srcInUs: 1_500_000, srcOutUs: 3_500_000 },
      audio: null,
    });
  });

  it("passes an audio-only Group as waveform alone", () => {
    expect(groupAvPassthrough(comp([[audio("a", 0, 4_000_000)]]), 0, 4_000_000)).toEqual({
      video: null,
      audio: { layerId: "a", mediaId: "m-a", srcInUs: 0, srcOutUs: 4_000_000 },
    });
  });

  it("falls back for two videos, a title, partial cover, gaps and empties", () => {
    const two = comp([[video("v1", 0, 2_000_000), video("v2", 2_000_000, 4_000_000)]]);
    expect(groupAvPassthrough(two, 0, 4_000_000)).toBeNull();
    const titled = comp([[video("v", 0, 4_000_000)], [text("t")]]);
    expect(groupAvPassthrough(titled, 0, 4_000_000)).toBeNull();
    // Inner clip covers only the first half: the window overhangs it.
    const partial = comp([[video("v", 0, 2_000_000, 0, 2_000_000)]]);
    expect(groupAvPassthrough(partial, 0, 4_000_000)).toBeNull();
    // Audio shorter than the window is the same refusal on the audio side.
    const shortAudio = comp([[video("v", 0, 4_000_000)], [audio("a", 0, 2_000_000, 0, 2_000_000)]]);
    expect(groupAvPassthrough(shortAudio, 0, 4_000_000)).toBeNull();
    expect(groupAvPassthrough(comp([[]]), 0, 4_000_000)).toBeNull();
    expect(groupAvPassthrough(null, 0, 4_000_000)).toBeNull();
    expect(groupAvPassthrough(comp([[video("v", 0, 4_000_000)]]), 2_000_000, 2_000_000)).toBeNull();
  });
});
