import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sharedTexture, type BrowserWindow, type ColorSpace } from 'electron';
import type { NativeDecode } from '@weftcut/native-decode';
import { MIB, hydratePerformanceSettings } from '../shared/performance-settings';
import { gpuBufferBudget } from './gpuBufferBudget';
import { closePreviewGpu, openPreviewGpu } from './previewGpu';

vi.mock('electron', () => ({ sharedTexture: {
  importSharedTexture: vi.fn(), sendSharedTexture: vi.fn(async () => {}),
} }));
const callbacks: (() => void)[] = [];
const backend = {
  previewGpuOpen: vi.fn((_id: string, _path: string, size: number) => ({
    width: 3840, height: 2160, slots: Array.from({ length: size }, () => ({ handle: Buffer.alloc(8) })),
  })),
  previewGpuClose: vi.fn(),
} as unknown as NativeDecode;
const win = { webContents: { send: vi.fn(), mainFrame: {} } } as unknown as BrowserWindow;
const color: ColorSpace = { matrix: 'rgb', primaries: 'bt709', transfer: 'srgb', range: 'full' };
beforeEach(() => {
  hydratePerformanceSettings({ gpu_buffer_mib: 128 });
  vi.clearAllMocks(); callbacks.length = 0;
  vi.mocked(sharedTexture.importSharedTexture).mockImplementation(({ allReferencesReleased }) => {
    callbacks.push(allReferencesReleased!);
    return { release: vi.fn() } as unknown as ReturnType<typeof sharedTexture.importSharedTexture>;
  });
});
afterEach(() => {
  closePreviewGpu(backend, 'video');
  for (const callback of callbacks) callback();
  hydratePerformanceSettings(undefined);
});

describe('preview shared buffer lifetime', () => {
  // The pool-size byte gate is the Windows RGBA pool's. macOS shares
  // decoder-owned surfaces and deliberately reserves one surface, so a large
  // poolSize is inert there (the native session ignores it).
  it.skipIf(process.platform === 'darwin')('refuses oversized pools before native allocation', async () => {
    await expect(openPreviewGpu(backend, win, 'video', 'video.mp4', 16, color, 3840, 2160)).rejects.toThrow('hw-budget-exceeded');
    expect(backend.previewGpuOpen).not.toHaveBeenCalled();
    expect(gpuBufferBudget.snapshot().used_bytes).toBe(0);
  });

  it('charges a closed video until all imported slot references are gone', async () => {
    await openPreviewGpu(backend, win, 'video', 'video.mp4', 3, color, 3840, 2160);
    // macOS reserves one decoder-owned surface for the shared buffer budget
    // (the VT session is charged through the resource ledger); Windows reserves
    // the whole RGBA pool. See openPreviewGpu's budgetPoolSize.
    const bytes = 3840 * 2160 * 4 * (process.platform === 'darwin' ? 1 : 3);
    expect(gpuBufferBudget.snapshot().preview_bytes).toBe(bytes);
    closePreviewGpu(backend, 'video');
    expect(backend.previewGpuClose).toHaveBeenCalledOnce();
    expect(gpuBufferBudget.snapshot().preview_bytes).toBe(bytes);
    // macOS reserves one 4K surface (33 MiB), Windows the whole pool (100 MiB).
    expect(gpuBufferBudget.reserve('motif', (process.platform === 'darwin' ? 120 : 40) * MIB)).toBeNull();
    callbacks[0]!(); callbacks[1]!();
    expect(gpuBufferBudget.snapshot().preview_bytes).toBe(bytes);
    callbacks[2]!();
    expect(gpuBufferBudget.snapshot().preview_bytes).toBe(0);
  });
});
