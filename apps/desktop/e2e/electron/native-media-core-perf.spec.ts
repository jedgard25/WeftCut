import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  launchApp,
  newProject,
  importAndPlaceMedia,
  invokeCmd,
  waitForHook,
  tmpDir,
  DECODE_COMPONENT_PRESENT,
} from './helpers/driver'

// Opt-in 4K measurement, not a CI gate. Run with:
//   WEFTCUT_PERF_4K=1 WEFTCUT_E2E_FULL=1 WEFTCUT_E2E_ONLY=native-media-core-perf.spec.ts npm run e2e
// Numbers are written to reports/native-media-core-perf.json (gitignored).
//
// What it measures, in one session:
//   - first frame from placement
//   - a 4s seek
//   - 3s of playback (underrun dropped/late, composite max)
//   - a 24-clip fast scrub on one track (max live sessions / reserved MiB)
//   - the same seek/playback through the copy-back lane
//   - the same through the app's own quick proxy (Lite/WebCodecs), after the
//     normal background proxy job lands

const CANVAS = { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 }
const PERF_DIR = path.join(os.tmpdir(), 'weftcut-perf-4k')
const FOUR_K = path.join(PERF_DIR, 'fourk_30s_gop240.mp4')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPORTS = path.resolve(HERE, '../../reports')

interface Probe {
  sourceKind: string
  hwLane: string | null
  sharedTextureTransport: boolean
  sharedTextureRequested: boolean
  ringLastPtsUs: number | null
  spriteBound: boolean
  sourceDisposed: boolean
  ringSize: number
}

interface Budget {
  sessions: { used: number; max: number }
  codedPixelArea: { used: number; max: number }
  slotVram: { usedBytes: number; bytesPerPixel: number }
}
interface ResourceStatus {
  active: number
  reserved_mib: number
  pressure: string
  available_memory_mib?: number
}

test('@matrix @serial 4K native media core measurements', async () => {
  test.skip(!process.env.WEFTCUT_PERF_4K, 'set WEFTCUT_PERF_4K=1 to run the 4K measurement')
  test.skip(process.platform !== 'darwin', 'this measurement targets the macOS VideoToolbox lane')
  test.skip(!DECODE_COMPONENT_PRESENT, 'native-decode component not built')
  test.setTimeout(1_800_000)

  mkdirSync(PERF_DIR, { recursive: true })
  if (!existsSync(FOUR_K)) {
    execFileSync(process.env.FFMPEG || 'ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30:duration=8',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '240', '-crf', '26',
      '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-colorspace', 'bt709', '-color_range', 'tv',
      FOUR_K,
    ], { timeout: 300_000 })
  }

  const { app, page } = await launchApp({ env: { WEFTCUT_FORCE_HW_LANE: 'videotoolbox' } })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  const report: Record<string, unknown> = { file: FOUR_K, phases: {} }
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-perf-4k-proj-'),
      name: `perf-${Date.now()}`,
      canvas: CANVAS,
    })
    // No background proxy during the original-source phases.
    await invokeCmd(page, 'update_project_settings', {
      patch: { generate_preview_proxies: false, prefer_proxies: false },
    })
    await invokeCmd(page, 'app_settings_set', { patch: { decode_engine: 'ffmpeg' } })
    await page.evaluate(async () => {
      await (window as unknown as {
        __weftcutTest: { setExperimentalMacosSharedTexture(enabled: boolean): Promise<unknown> }
      }).__weftcutTest.setExperimentalMacosSharedTexture(true)
    })

    const readBudget = (): Promise<Budget> =>
      page.evaluate(() => (window as any).__weftcutTest.previewGpuBudget())
    const readResources = (): Promise<ResourceStatus> =>
      page.evaluate(() => (window as any).api.resources.status())
    const readPerf = (): Promise<any> =>
      page.evaluate(() => (window as any).__weftcutTest.compositorPerfSnapshot())
    const probe = async (layerId: string): Promise<Probe | null> => {
      try {
        return await page.evaluate(
          (id) => (window as any).__weftcutTest.activeClipProbe(id), layerId)
      } catch {
        // The preview bridge registers with the Panel; before that there is no
        // probe to read, which is not a failure.
        return null
      }
    }
    const seek = (tUs: number) => page.evaluate(
      (us) => (window as any).__weftcutTest.transportSeekUs(us), tUs)
    const play = () => page.evaluate(() => (window as any).__weftcutTest.transportPlay())
    const pause = () => page.evaluate(() => (window as any).__weftcutTest.transportPause())
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    const waitFor = async <T>(fn: () => Promise<T | null | undefined>, timeoutMs: number): Promise<T> => {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        const value = await fn()
        if (value) return value
        await sleep(50)
      }
      throw new Error(`waitFor timed out after ${timeoutMs}ms`)
    }

    const writeReport = () => {
      report.errors = errors
      mkdirSync(REPORTS, { recursive: true })
      const out = path.join(REPORTS, 'native-media-core-perf.json')
      writeFileSync(out, JSON.stringify(report, null, 2))
      // eslint-disable-next-line no-console
      console.log(`[native-media-core-perf] ${JSON.stringify(report)}`)
      // eslint-disable-next-line no-console
      console.log(`[native-media-core-perf] wrote ${out}`)
    }

    const firstStart = Date.now()
    const { mediaId, layerId } = await importAndPlaceMedia(page, { mediaAbsPath: FOUR_K })
    await waitFor(async () => {
      const p = await probe(layerId)
      return p?.spriteBound && p.ringLastPtsUs !== null ? p : null
    }, 120_000)
    const firstFrameMs = Date.now() - firstStart

    // 4s seek.
    const seekStart = Date.now()
    await seek(4_000_000)
    await waitFor(async () => {
      const p = await probe(layerId)
      return p && (p.ringLastPtsUs ?? -1) >= 4_000_000 && p.spriteBound ? p : null
    }, 120_000)
    const seekMs = Date.now() - seekStart

    // 3s playback.
    await seek(0)
    await waitFor(async () => {
      const p = await probe(layerId)
      return p && p.ringLastPtsUs !== null ? p : null
    }, 120_000)
    await play()
    await sleep(3_000)
    const sharedPerf = await readPerf()
    await pause()
    const sharedBudget = await readBudget()
    const sharedResources = await readResources()
    const sharedProbe = await probe(layerId)
    report.phases.shared = {
      firstFrameMs,
      seekMs,
      budget: sharedBudget,
      resources: sharedResources,
      dropped: sharedPerf?.underrun?.droppedFrames ?? null,
      late: sharedPerf?.underrun?.lateFrames ?? null,
      compositeMsMax: sharedPerf?.compositeMsMax ?? null,
      probe: sharedProbe,
    }
    writeReport()

    // Copy-back control: same clip, same seek/play window.
    await page.evaluate(async () => {
      await (window as unknown as {
        __weftcutTest: { setExperimentalMacosSharedTexture(enabled: boolean): Promise<unknown> }
      }).__weftcutTest.setExperimentalMacosSharedTexture(false)
    })
    await waitFor(async () => {
      const p = await probe(layerId)
      return p && p.hwLane === 'videotoolbox' && !p.sharedTextureTransport ? p : null
    }, 60_000)
    // Park at 0 first: the shared phase left the ring around 4 s, and a seek
    // served from the ring would flatter copy-back.
    await seek(0)
    await waitFor(async () => {
      const p = await probe(layerId)
      return p && (p.ringLastPtsUs ?? -1) < 1_000_000 && p.spriteBound ? p : null
    }, 120_000)
    const copySeekStart = Date.now()
    await seek(4_000_000)
    await waitFor(async () => {
      const p = await probe(layerId)
      return p && (p.ringLastPtsUs ?? -1) >= 4_000_000 && p.spriteBound ? p : null
    }, 120_000)
    const copySeekMs = Date.now() - copySeekStart
    await seek(0)
    await waitFor(async () => {
      const p = await probe(layerId)
      return p && p.ringLastPtsUs !== null ? p : null
    }, 120_000)
    await play()
    await sleep(3_000)
    const copyPerf = await readPerf()
    await pause()
    const copyBudget = await readBudget()
    const copyResources = await readResources()
    report.phases.copyback = {
      seekMs: copySeekMs,
      budget: copyBudget,
      resources: copyResources,
      dropped: copyPerf?.underrun?.droppedFrames ?? null,
      late: copyPerf?.underrun?.lateFrames ?? null,
      compositeMsMax: copyPerf?.compositeMsMax ?? null,
    }
    writeReport()

    // Back to the shared-texture transport for the scrub phase.
    await page.evaluate(async () => {
      await (window as unknown as {
        __weftcutTest: { setExperimentalMacosSharedTexture(enabled: boolean): Promise<unknown> }
      }).__weftcutTest.setExperimentalMacosSharedTexture(true)
    })
    await waitFor(async () => {
      const p = await probe(layerId)
      return p && p.sharedTextureTransport ? p : null
    }, 60_000)

    // 24-clip fast scrub on one track (8s source, contiguous starts).
    await waitForHook(page, 'placeMediaLayersOnOneTrack')
    const starts = Array.from({ length: 24 }, (_, i) => i * 8_000_000)
    await page.evaluate(([id, s]) => (window as any).__weftcutTest
      .placeMediaLayersOnOneTrack({ mediaId: id, startsUs: s }), [mediaId, starts] as const)
    let maxSessions = 0
    let maxReserved = 0
    for (const start of starts) {
      await seek(start + 100_000)
      await sleep(40)
      const b = await readBudget()
      const r = await readResources()
      maxSessions = Math.max(maxSessions, b.sessions.used)
      maxReserved = Math.max(maxReserved, r.reserved_mib)
    }
    await pause()
    await sleep(3_000)
    const scrubBudget = await readBudget()
    const scrubResources = await readResources()
    const unsupportedCards = await page.locator('[data-testid="unsupported-clip-card"]').count()
    report.phases.scrub = {
      clips: starts.length,
      maxSessions,
      maxReservedMiB: maxReserved,
      afterSessions: scrubBudget.sessions.used,
      afterReservedMiB: scrubResources.reserved_mib,
      unsupportedCards,
      errors: errors.slice(),
    }
    writeReport()

    // Proxy phase: build the app's quick proxy on demand, then prefer it.
    await page.evaluate(async () => {
      await (window as unknown as {
        __weftcutTest: { setExperimentalMacosSharedTexture(enabled: boolean): Promise<unknown> }
      }).__weftcutTest.setExperimentalMacosSharedTexture(true)
    })
    await invokeCmd(page, 'generate_quick_proxy', { mediaId })
    const proxyPath = await waitFor(async () => {
      const p = await page.evaluate(
        (id) => (window as any).__weftcutTest.mediaQuickProxyPath(id), mediaId)
      return typeof p === 'string' && p.length > 0 ? p : null
    }, 240_000)
    // Clear any explicit override and let the new heavy-source auto rule choose
    // the quick proxy. Use the REAL renderer setter so the resolver's store
    // updates synchronously; the backend command alone would only emit an event.
    await page.evaluate(async (id) => {
      await (window as any).__weftcutTest.setProxyOverride(id, null)
    }, mediaId)
    // The scrub left the playhead at the last clip; return to the measured clip
    // before waiting for its proxy swap and a cold seek.
    await seek(0)
    await waitFor(async () => {
      const p = await probe(layerId)
      return p?.sourceKind === 'webcodecs' && p.spriteBound ? p : null
    }, 120_000)
    await waitFor(async () => {
      const p = await probe(layerId)
      return p && (p.ringLastPtsUs ?? -1) < 1_000_000 ? p : null
    }, 60_000)
    const proxySeekStart = Date.now()
    await seek(4_000_000)
    await waitFor(async () => {
      const p = await probe(layerId)
      return p && (p.ringLastPtsUs ?? -1) >= 4_000_000 && p.spriteBound ? p : null
    }, 60_000)
    const proxySeekMs = Date.now() - proxySeekStart
    await seek(0)
    await sleep(500)
    await play()
    await sleep(3_000)
    const proxyPerf = await readPerf()
    await pause()
    const proxyBudget = await readBudget()
    const proxyResources = await readResources()
    report.phases.proxy = {
      autoProxy: true,
      proxyPath,
      seekMs: proxySeekMs,
      budget: proxyBudget,
      resources: proxyResources,
      dropped: proxyPerf?.underrun?.droppedFrames ?? null,
      late: proxyPerf?.underrun?.lateFrames ?? null,
      compositeMsMax: proxyPerf?.compositeMsMax ?? null,
      clips: proxyPerf?.clips?.map((c: any) => ({
        sourceKind: c.sourceKind, decodedFrameCount: c.decodedFrameCount, ringSize: c.ringSize,
      })) ?? null,
    }
    writeReport()
  } finally {
    await app.close()
  }
})
