import { describe, it, expect, vi, beforeEach } from "vitest";
import { CaptureRing, FrameProvider, type FrameProviderMedia } from "./FrameProvider";
import { DecodeClock } from "../../render/decoder/decodeClock";

const createImageBitmapMock = vi.fn(
  async (_image: ImageBitmapSource, _options?: ImageBitmapOptions) =>
    ({ width: 455, height: 256, close: vi.fn() }) as unknown as ImageBitmap,
);
vi.stubGlobal("createImageBitmap", createImageBitmapMock);

interface FakePacket {
  microsecondTimestamp: number;
  timestamp: number;
  toEncodedVideoChunk(): EncodedVideoChunk;
}

function packet(timestampUs: number): FakePacket {
  return {
    microsecondTimestamp: timestampUs,
    timestamp: timestampUs / 1_000_000,
    toEncodedVideoChunk: () => ({ timestamp: timestampUs }) as unknown as EncodedVideoChunk,
  };
}

function fakeFrame(timestampUs: number): VideoFrame {
  return {
    timestamp: timestampUs,
    duration: 33_333,
    displayWidth: 1280,
    displayHeight: 720,
    codedWidth: 1280,
    codedHeight: 720,
    close: vi.fn(),
  } as unknown as VideoFrame;
}

/// A decoder that synchronously emits the packet it is fed, so the capture path
/// runs without real WebCodecs.
function makeFakeDecoder(init: VideoDecoderInit) {
  return {
    state: "configured" as CodecState,
    decodeQueueSize: 0,
    configure: vi.fn(),
    reset: vi.fn(),
    close: vi.fn(),
    flush: async () => {},
    decode: (chunk: { timestamp: number }) => init.output(fakeFrame(chunk.timestamp)),
  };
}

/// A decoder that accepts packets but never emits (drives the timeout path).
function makeSilentDecoder() {
  return {
    state: "configured" as CodecState,
    decodeQueueSize: 0,
    configure: vi.fn(),
    reset: vi.fn(),
    close: vi.fn(),
    flush: async () => {},
    decode: () => {},
  };
}

function makeMedia(): FrameProviderMedia {
  const key = packet(0);
  return {
    ensureReady: async () => ({ codec: "avc1.42E01E" }) as VideoDecoderConfig,
    packetSink: {
      getKeyPacket: async () => key,
      getFirstPacket: async () => key,
      getNextPacket: async () => null,
    } as unknown as FrameProviderMedia["packetSink"],
    decodeClock: DecodeClock.fromOrigin(0),
    dispose: vi.fn(),
  };
}

function makeProvider(opts: { emit: boolean; timeoutMs?: number }): FrameProvider {
  return new FrameProvider({
    resolveSource: () => ({ proxyAssetUrl: "weftcut-media://test/clip.mp4" }),
    openMedia: () => makeMedia(),
    createDecoder: (init) =>
      (opts.emit ? makeFakeDecoder(init) : makeSilentDecoder()) as unknown as VideoDecoder,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

beforeEach(() => {
  createImageBitmapMock.mockClear();
});

describe("CaptureRing", () => {
  it("stops the pump only once marked done", () => {
    const ring = new CaptureRing();
    expect(ring.isLookaheadFull()).toBe(false);
    expect(ring.firstPtsUs()).toBeNull();
    ring.markDone();
    expect(ring.isLookaheadFull()).toBe(true);
  });
});

describe("FrameProvider", () => {
  it("captures the frame and scales it to the requested tile height", async () => {
    const provider = makeProvider({ emit: true });
    const bitmap = await provider.getFrameAt("m1", 0, { height: 256 });

    expect(bitmap).toBeDefined();
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
    const [, options] = createImageBitmapMock.mock.calls[0]!;
    expect(options).toMatchObject({ resizeHeight: 256, resizeWidth: 455, resizeQuality: "low" });
    provider.dispose();
  });

  it("rejects when the decoder never emits the target frame", async () => {
    const provider = makeProvider({ emit: false, timeoutMs: 10 });
    await expect(provider.getFrameAt("m1", 0, { height: 256 })).rejects.toThrow(/timed out/);
    provider.dispose();
  });

  it("rejects after dispose", async () => {
    const provider = makeProvider({ emit: true });
    provider.dispose();
    await expect(provider.getFrameAt("m1", 0, { height: 256 })).rejects.toThrow(/disposed/);
  });

  it("rejects when no decode source is resolved", async () => {
    const provider = new FrameProvider({ resolveSource: () => null });
    await expect(provider.getFrameAt("missing", 0, { height: 256 })).rejects.toThrow(
      /no decode source/,
    );
  });
});
