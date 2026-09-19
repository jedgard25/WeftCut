// Store-facing wiring for the GPU (WebCodecs) filmstrip path. Kept apart from
// `FrameProvider` so that module stays store-agnostic and unit-testable, and
// loaded lazily by `FilmstripTileProducer` only when the flag is on — the
// default ffmpeg path must not drag the render/decode module graph into every
// timeline.

import { convertFileSrc } from "@/bridge/ipc";
import { quickProxyPath } from "../../render/decodeRoute";
import { ffprobeColorToWebCodecs } from "../../render/decoder/ffprobeColorSpace";
import { useProjectStore } from "../../state/projectStore";
import { FrameProvider, type FrameProviderSource } from "./FrameProvider";

/// The quick proxy when one exists (short-GOP, WebCodecs-decodable by
/// construction — the same preference the preview resolver makes), else the
/// original. A source WebCodecs cannot decode rejects and the producer falls
/// back to ffmpeg.
export function resolveFilmstripFrameSource(mediaId: string): FrameProviderSource | null {
  const media = useProjectStore.getState().mediaById.get(mediaId);
  if (!media) return null;
  const path = quickProxyPath(media) ?? media.path;
  if (!path) return null;
  return {
    proxyAssetUrl: convertFileSrc(path),
    sourceColor: ffprobeColorToWebCodecs(media),
    sourceStartPtsUs: media.start_pts_us ?? null,
  };
}

let provider: FrameProvider | null = null;

export function filmstripFrameProvider(): FrameProvider {
  if (!provider) {
    provider = new FrameProvider({ resolveSource: resolveFilmstripFrameSource });
  }
  return provider;
}
