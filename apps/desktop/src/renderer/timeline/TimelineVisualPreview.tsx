import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { convertFileSrc } from "@/bridge/ipc";
import { DEFAULT_PX_PER_SEC, LAYER_PREVIEW_MIN_PX } from "./geometry";
import { cameraPxPerSec, subscribeCamera } from "./camera";
import { TimelineFilmstrip } from "./TimelineFilmstrip";
import { TimelineWaveform } from "./TimelineWaveform";
import { trackStatic, type LayerSummary, type Rgba } from "../ipc";
import { useMediaPosterSrc } from "../panels/MediaThumbnail";
import { useReadyPeaksKey } from "../state/audioFxStore";
import {
  useFirstVideoMediaIdIn,
  useGroupAvPassthrough,
  useMediaById,
} from "../state/projectStore";
import { timelineLayerTheme } from "./layerTheme";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rgbaToCss(color: Rgba): string {
  const alpha = color.a / 255;
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${clamp01(alpha)})`;
}

function fallbackFill(surface: string, pattern?: "motif") {
  return (
    <div
      className="h-full w-full"
      style={{
        backgroundColor: surface,
        backgroundImage:
          pattern === "motif"
            ? "radial-gradient(circle at 1px 1px, rgba(177,123,193,0.22) 1px, transparent 1.25px)"
            : "linear-gradient(180deg, rgba(255,255,255,0.03), rgba(0,0,0,0.10))",
        backgroundSize: pattern === "motif" ? "10px 10px" : undefined,
      }}
    />
  );
}

function usePreviewResourceGate(enabledByWidth: boolean) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [enabled, setEnabled] = useState(
    () => enabledByWidth && typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    if (!enabledByWidth) {
      setEnabled(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setEnabled(true);
      return;
    }
    const element = rootRef.current;
    if (!element) return;
    setEnabled(false);
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries.some(
            (entry) => entry.isIntersecting || entry.intersectionRatio > 0,
          )
        ) {
          setEnabled(true);
        }
      },
      {
        root: null,
        rootMargin: "256px 512px",
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabledByWidth]);

  return { enabled, rootRef };
}

function colorFill(color: Rgba, colorHint: string) {
  const alpha = color.a / 255;
  if (alpha < 0.98) {
    const fill = rgbaToCss(color);
    return (
      <div
        className="h-full w-full"
        style={{
          backgroundColor: colorHint,
          backgroundImage: [
            `linear-gradient(${fill}, ${fill})`,
            "linear-gradient(45deg, rgba(255,255,255,0.18) 25%, transparent 25%)",
            "linear-gradient(-45deg, rgba(255,255,255,0.18) 25%, transparent 25%)",
            "linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.18) 75%)",
            "linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.18) 75%)",
          ].join(", "),
          backgroundPosition: "0 0, 0 0, 0 4px, 4px -4px, -4px 0",
          backgroundSize: "auto, 8px 8px, 8px 8px, 8px 8px, 8px 8px",
        }}
      />
    );
  }
  return (
    <div className="h-full w-full" style={{ backgroundColor: rgbaToCss(color) }} />
  );
}

export const TimelineVisualPreview = memo(function TimelineVisualPreview({
  layer,
  compositionId,
  tStartUs,
  tEndUs,
  layerWidthPx = 0,
  layerHeightPx,
  pxPerSec,
}: {
  layer: LayerSummary;
  /// The Panel's composition — the camera key. Null/absent in isolated tests,
  /// which hand a fixed `layerWidthPx`/`pxPerSec` instead.
  compositionId?: string | null | undefined;
  /// Live clip edges, so the preview follows a trim/move drag AND re-maps on
  /// zoom through the camera without its parent block re-rendering.
  tStartUs?: number;
  tEndUs?: number;
  /// Fallback width for isolated tests. The live app passes live edges
  /// instead and lets the strip derive width from the camera.
  layerWidthPx?: number | undefined;
  layerHeightPx: number;
  pxPerSec?: number | undefined;
}) {
  // This component must NOT re-render per zoom tick: it runs ~10 project-store
  // hooks, and doing that for every clip on every tick is the per-cut cost. It
  // re-renders only when the clip crosses the preview width floor, and hands
  // the live edges to the filmstrip/waveform, which subscribe to the camera
  // themselves and compute their own width.
  const fallbackPxPerSec = pxPerSec ?? DEFAULT_PX_PER_SEC;
  const subscribeZoom = useCallback(
    (cb: () => void) => subscribeCamera(compositionId ?? null, cb),
    [compositionId],
  );
  const widthAt = (p: number) =>
    tStartUs !== undefined && tEndUs !== undefined
      ? Math.max(((tEndUs - tStartUs) / 1_000_000) * p, 4)
      : layerWidthPx;
  const canRenderPreview = useSyncExternalStore(
    subscribeZoom,
    () =>
      widthAt(cameraPxPerSec(compositionId ?? null, fallbackPxPerSec)) >=
      LAYER_PREVIEW_MIN_PX,
    () => layerWidthPx >= LAYER_PREVIEW_MIN_PX,
  );
  const { enabled: resourceEnabled, rootRef } =
    usePreviewResourceGate(canRenderPreview);
  const imageMedia = useMediaById(
    layer.params.kind === "ImageOverlay" ? layer.params.media_id : null,
  );
  const audioMedia = useMediaById(
    layer.params.kind === "Audio" ? layer.params.media_id : null,
  );
  const videoMedia = useMediaById(
    layer.params.kind === "VideoClip" ? layer.params.media_id : null,
  );
  // A Group's poster is the earliest video INSIDE the composition it shows — a
  // still, not a filmstrip: the strip would have to map the Group's window onto
  // one inner clip's own window, and there is no such mapping when the
  // composition holds more than one clip. One frame says "this is that shot"
  // without claiming anything about the rest of the span. The exception is the
  // single-take Group (`useGroupAvPassthrough`): one video plus at most one
  // audio covering the window end to end draws as footage — filmstrip over
  // waveform, flush, under the one unified label the block already draws.
  const groupPosterMediaId = useFirstVideoMediaIdIn(
    layer.params.kind === "CompositionRef" ? layer.params.composition_id : null,
  );
  const groupPosterSrc = useMediaPosterSrc(groupPosterMediaId, "video");
  const groupPass = useGroupAvPassthrough(
    layer.params.kind === "CompositionRef" ? layer.params.composition_id : null,
    layer.params.kind === "CompositionRef" ? layer.params.src_in_us : 0,
    layer.params.kind === "CompositionRef" ? layer.params.src_out_us : 0,
  );
  const passVideoMedia = useMediaById(groupPass?.video?.mediaId ?? null);
  const passAudioMedia = useMediaById(groupPass?.audio?.mediaId ?? null);
  // The inner audio's own bake key: `""` subscribes to nothing (no entry) when
  // the Group holds no audio and no waveform renders.
  const passAudioPeaksKey = useReadyPeaksKey(groupPass?.audio?.layerId ?? "");
  // Audio-effect bake state for THIS layer, whatever its kind: a hook cannot
  // be conditional, and a non-audio layer simply has no entry.
  const readyPeaksKey = useReadyPeaksKey(layer.id);
  if (!canRenderPreview) return null;
  const layerTheme = timelineLayerTheme(layer.params.kind, layer.color_hint);

  const preview = (() => {
    switch (layer.params.kind) {
      case "VideoClip":
        return (
          <TimelineFilmstrip
            mediaId={layer.params.media_id}
            compositionId={compositionId}
            srcInUs={layer.params.src_in_us}
            srcOutUs={layer.params.src_out_us}
            layerWidthPx={layerWidthPx}
            tStartUs={tStartUs}
            tEndUs={tEndUs}
            layerHeightPx={layerHeightPx}
            pxPerSec={pxPerSec}
            colorHint={layerTheme.surface}
            enabled={resourceEnabled}
            mediaWidth={videoMedia?.width ?? undefined}
            mediaHeight={videoMedia?.height ?? undefined}
            mediaDurationUs={videoMedia?.duration_us ?? undefined}
          />
        );
      case "Audio":
        return (
          <TimelineWaveform
            mediaId={layer.params.media_id}
            compositionId={compositionId}
            // The processed waveform wherever a bake is ready for this layer,
            // else the raw conform's — the picture follows what plays
            // (ADR 0063). Read through the store hook, so a bake landing
            // re-renders the strip on its own.
            waveformKey={readyPeaksKey ?? layer.params.media_id}
            layerId={layer.id}
            srcInUs={layer.params.src_in_us}
            srcOutUs={layer.params.src_out_us}
            layerWidthPx={layerWidthPx}
            tStartUs={tStartUs}
            tEndUs={tEndUs}
            layerHeightPx={layerHeightPx}
            colorHint={layerTheme.surface}
            waveformColor={layerTheme.accent}
            enabled={resourceEnabled}
            pxPerSec={pxPerSec}
            mediaChannels={audioMedia?.audio_channels ?? undefined}
          />
        );
      case "ImageOverlay":
        return resourceEnabled && imageMedia?.available ? (
          <img
            className="h-full w-full object-cover"
            src={convertFileSrc(imageMedia.path)}
            alt=""
            draggable={false}
          />
        ) : (
          fallbackFill(layerTheme.surface)
        );
      case "Color":
        return colorFill(
          trackStatic(layer.params.color, { r: 0, g: 0, b: 0, a: 255 }),
          layer.color_hint,
        );
      // Deliberately NOT a text render. Text is the one kind whose content
      // lives in the same visual channel as the block's name chip — same 10px,
      // same centred baseline, same left inset, same 48px reveal threshold — so
      // drawing it here put two strings on one line, out of phase by the width
      // of the chip's icon, with only the chip's fade-to-transparent scrim
      // between them. The chip carries the content now (layerName.ts names a
      // Text layer by its words), and it carries it BETTER: it is sticky, so it
      // stays readable when a long caption's head scrolls out of the viewport.
      case "Text":
        return fallbackFill(layerTheme.surface);
      case "Motif":
        return fallbackFill(layerTheme.surface, "motif");
      // No poster (a Group of titles, a thumbnail job still running) falls back
      // to the plain fill, and the block's `Group` glyph is then what names the
      // clip — the same division every other kind uses when its resource is not
      // there yet.
      case "CompositionRef": {
        // Single-take Group: footage, not a poster. The two halves are flush
        // (no center gap): one clip, one label, one visual.
        if (groupPass !== null && (groupPass.video !== null || groupPass.audio !== null)) {
          const halfPx = layerHeightPx / 2;
          return (
            <div className="flex h-full w-full flex-col">
              {groupPass.video !== null && (
                <div className="min-h-0 flex-1">
                  <TimelineFilmstrip
                    mediaId={groupPass.video.mediaId}
                    compositionId={compositionId}
                    srcInUs={groupPass.video.srcInUs}
                    srcOutUs={groupPass.video.srcOutUs}
                    layerWidthPx={layerWidthPx}
                    tStartUs={tStartUs}
                    tEndUs={tEndUs}
                    layerHeightPx={groupPass.audio !== null ? halfPx : layerHeightPx}
                    pxPerSec={pxPerSec}
                    colorHint={layerTheme.surface}
                    enabled={resourceEnabled}
                    mediaWidth={passVideoMedia?.width ?? undefined}
                    mediaHeight={passVideoMedia?.height ?? undefined}
                    mediaDurationUs={passVideoMedia?.duration_us ?? undefined}
                  />
                </div>
              )}
              {groupPass.audio !== null && (
                <div className="min-h-0 flex-1">
                  <TimelineWaveform
                    mediaId={groupPass.audio.mediaId}
                    compositionId={compositionId}
                    waveformKey={passAudioPeaksKey ?? groupPass.audio.mediaId}
                    layerId={groupPass.audio.layerId}
                    srcInUs={groupPass.audio.srcInUs}
                    srcOutUs={groupPass.audio.srcOutUs}
                    layerWidthPx={layerWidthPx}
                    tStartUs={tStartUs}
                    tEndUs={tEndUs}
                    layerHeightPx={groupPass.video !== null ? halfPx : layerHeightPx}
                    colorHint={layerTheme.surface}
                    waveformColor={layerTheme.accent}
                    enabled={resourceEnabled}
                    pxPerSec={pxPerSec}
                    mediaChannels={passAudioMedia?.audio_channels ?? undefined}
                  />
                </div>
              )}
            </div>
          );
        }
        return resourceEnabled && groupPosterSrc !== null ? (
          <img
            className="h-full w-full object-cover"
            src={groupPosterSrc}
            alt=""
            draggable={false}
          />
        ) : (
          fallbackFill(layerTheme.surface)
        );
      }
    }
  })();

  return (
    <div
      ref={rootRef}
      data-testid="timeline-visual-preview"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ borderRadius: "inherit", backgroundColor: layerTheme.surface }}
      aria-hidden="true"
    >
      {preview}
      {layer.params.kind !== "Color" && (
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.025),rgba(0,0,0,0.10))]" />
      )}
    </div>
  );
});
