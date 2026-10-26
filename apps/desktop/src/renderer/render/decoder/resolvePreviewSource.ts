import type { MediaSummary } from '../../ipc';
import { convertFileSrc } from '../../bridge/ipc';
import { useAppSettingsStore } from '../../settings/appSettingsStore';
import { useDecodeComponentStore } from '../../settings/decodeComponentStore';
import { useProxyPrefStore } from '../../state/proxyPreferenceStore';
import { quickProxyPath } from '../decodeRoute';
import { resolveDecodeEngine } from './decodeEngine';
import { isFfmpegUnusable } from './ffmpegCapability';
import { isWebcodecsUnusable } from './webcodecsCapability';
import { onDecodeCapabilityChange } from './capabilityChanges';

/** The common live gatherer for playback and actionability. A job's lifecycle
 * is deliberately not an input: only a usable source and engine grant access. */
/// A heavy source the app already decided to proxy for preview: >=2160p and a
/// Decode Route that plans a quick proxy. This is the measured seek win (a
/// 240-frame GOP decodes from its keyframe on every cold seek; the 720p
/// short-GOP proxy does not). `Bypass`/`native-sw` routes are excluded: Bypass
/// has no quick proxy, and NativeSw's engine choice stays the user's.
function heavyAutoProxy(media: MediaSummary): boolean {
  if (!useAppSettingsStore.getState().settings.auto_preview_proxies) return false;
  if (media.kind !== "Video") return false;
  if (Math.max(media.width ?? 0, media.height ?? 0) < 2160) return false;
  // DirectExport is the long-GOP decodable class this exists for. A `proxied`
  // source (ProRes/DNx/MPEG-2 and other WebCodecs blinds) seeks by nature;
  // leave its engine/source choice to the user.
  return media.decode_route.route === "direct-export";
}

export function resolvePreviewSource(media: MediaSummary, originalDecoded: boolean) {
  const proxy = quickProxyPath(media);
  const prefs = useProxyPrefStore.getState();
  const override = prefs.overrides[media.id];
  // Explicit per-clip intent always wins. Auto (no override) uses the proxy
  // when the user prefers proxies OR the heavy-source rule applies. A proxy
  // that is not on disk never activates — the `quickProxyPath` gate is the
  // no-black-frame safety net.
  const useProxySource = proxy !== null && (
    override === true
    || (override === undefined && (prefs.preferProxies || heavyAutoProxy(media)))
  );
  return resolveDecodeEngine({
    setting: useAppSettingsStore.getState().settings.decode_engine,
    componentAvailable: useDecodeComponentStore.getState().available,
    useProxySource,
    proxyReady: proxy !== null,
    proxyUrl: proxy === null ? null : convertFileSrc(proxy),
    originalPath: media.path,
    originalUrl: convertFileSrc(media.path),
    webcodecsCanDecodeOriginal: isWebcodecsUnusable(media.id) ? 'fail' : originalDecoded ? 'ok' : 'untested',
    ffmpegUsable: !isFfmpegUnusable(media.id),
  });
}

export function onPreviewResolutionChange(notify: () => void): () => void {
  const stops = [
    useAppSettingsStore.subscribe((s, prev) => { if (s.settings.decode_engine !== prev.settings.decode_engine) notify(); }),
    useDecodeComponentStore.subscribe((s, prev) => { if (s.available !== prev.available) notify(); }),
    useProxyPrefStore.subscribe(notify),
    onDecodeCapabilityChange(notify),
  ];
  return () => stops.forEach(stop => stop());
}
