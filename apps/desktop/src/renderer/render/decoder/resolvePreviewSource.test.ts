// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaSummary } from "../../ipc";

vi.mock("../../bridge/ipc", () => ({ convertFileSrc: (path: string) => path }));

import { resolvePreviewSource } from "./resolvePreviewSource";
import { useAppSettingsStore } from "../../settings/appSettingsStore";
import { useDecodeComponentStore } from "../../settings/decodeComponentStore";
import { useProxyPrefStore } from "../../state/proxyPreferenceStore";
import { resetFfmpegCapabilitySession } from "./ffmpegCapability";
import { resetWebcodecsCapabilitySession } from "./webcodecsCapability";

const video = (over: Partial<MediaSummary> = {}): MediaSummary => ({
  id: "m1",
  label: "clip.mp4",
  path: "/m/clip.mp4",
  kind: "Video",
  duration_us: 5_000_000,
  width: 3840,
  height: 2160,
  size_bytes: 10_000_000,
  available: true,
  decode_route: { route: "direct-export", quick_proxy: "/proxy.mp4" },
  codec: "h264",
  pix_fmt: "yuv420p",
  ...over,
});

beforeEach(() => {
  useAppSettingsStore.setState((s) => ({ settings: {
    ...s.settings,
    decode_engine: "auto",
    auto_preview_proxies: true,
  } }));
  useDecodeComponentStore.setState({ available: true });
  useProxyPrefStore.setState({ preferProxies: false, overrides: {} });
  resetFfmpegCapabilitySession();
  resetWebcodecsCapabilitySession();
});

describe("automatic quick proxy for heavy preview sources", () => {
  it("uses a 4K DirectExport source's existing quick proxy when the auto setting is on", () => {
    expect(resolvePreviewSource(video(), false)).toMatchObject({
      engine: "webcodecs",
      source: "proxy",
      target: "/proxy.mp4",
      status: "ok",
    });
  });

  it("stays on the original when the auto setting is off", () => {
    useAppSettingsStore.setState((s) => ({ settings: { ...s.settings, auto_preview_proxies: false } }));
    expect(resolvePreviewSource(video(), false)).toMatchObject({
      engine: "ffmpeg",
      source: "original",
      target: "/m/clip.mp4",
      status: "ok",
    });
  });

  it("never overrides an explicit per-clip Original choice", () => {
    useProxyPrefStore.setState({ preferProxies: false, overrides: { m1: false } });
    expect(resolvePreviewSource(video(), false)).toMatchObject({
      engine: "ffmpeg",
      source: "original",
    });
  });

  it("does not auto-proxy a WebCodecs-blind (proxied) source", () => {
    expect(resolvePreviewSource(video({
      decode_route: { route: "proxied", quick_proxy: "/proxy.mp4", full_proxy: null, format_version: 0 },
    }), false)).toMatchObject({
      engine: "ffmpeg",
      source: "original",
    });
  });

  it("does not auto-proxy a 1080p source", () => {
    expect(resolvePreviewSource(video({ width: 1920, height: 1080 }), false)).toMatchObject({
      engine: "ffmpeg",
      source: "original",
    });
  });

  it("does not auto-proxy before the quick proxy exists", () => {
    expect(resolvePreviewSource(video({
      decode_route: { route: "direct-export", quick_proxy: null },
    }), false)).toMatchObject({
      engine: "ffmpeg",
      source: "original",
    });
  });
});
