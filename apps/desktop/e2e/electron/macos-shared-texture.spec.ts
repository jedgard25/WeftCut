import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  newProject,
  importAndPlaceMedia,
  invokeCmd,
  tmpDir,
  DECODE_COMPONENT_PRESENT,
} from './helpers/driver'

// macOS zero-copy VideoToolbox preview gate.
//
// Proves the production path end to end in the real app:
//   ffmpeg VideoToolbox decode → CVPixelBuffer/IOSurface
//     → Electron sharedTexture.importSharedTexture (main, once per surface)
//     → VideoFrame in the preload → createImageBitmap → Pixi compositor
// with NO CPU frame copy and NO per-frame pixel IPC.
//
// The clip is a saturated 601 green chart: a wrong matrix/range reads tens of
// code units off the source (the same defect class preview-hw-color guards),
// and a raw-NV12-in-WebGPU mistake is what the POC's Result 5 measured at +38
// on red. The negative control toggles the feature off and requires the SAME
// pixels through the copy-back lane, proving the gate is not vacuous and that
// the live transport swap works both ways.

const CANVAS = { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 }
const SEEK_US = 500_000
const EXPECTED_RGB: [number, number, number] = [20, 220, 40]
const TOL = 8

interface Probe {
  sourceKind: string
  hwLane: string | null
  sharedTextureTransport: boolean
  ringLastPtsUs: number | null
  spriteBound: boolean
}

async function probe(page: import('@playwright/test').Page, layerId: string): Promise<Probe | null> {
  return page.evaluate((id) => {
    const p = (window as unknown as { __weftcutTest: { activeClipProbe(id?: string): Probe | null } })
      .__weftcutTest.activeClipProbe(id)
    return p
  }, layerId)
}

test('@serial macOS VideoToolbox IOSurface preview is color-correct and live-switchable', async () => {
  test.skip(process.platform !== 'darwin', 'macOS-only shared-texture path')
  test.skip(!DECODE_COMPONENT_PRESENT, 'native-decode component not built')
  test.setTimeout(240_000)

  const mediaDir = tmpDir('weftcut-macos-shared-texture-media-')
  const clip = path.join(mediaDir, 'green601.mp4')
  if (!existsSync(clip)) {
    execFileSync(process.env.FFMPEG || 'ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=0x14DC28:s=1920x1080:d=3',
      '-vf', 'format=yuv420p',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30',
      '-color_primaries', 'smpte170m',
      '-color_trc', 'smpte170m',
      '-colorspace', 'smpte170m',
      '-color_range', 'tv',
      clip,
    ])
  }

  const { app, page } = await launchApp({ env: { WEFTCUT_FORCE_HW_LANE: 'videotoolbox' } })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-macos-shared-texture-proj-'),
      name: `shared-texture-${Date.now()}`,
      canvas: CANVAS,
    })
    const settings = (await invokeCmd(page, 'app_settings_set', {
      patch: { decode_engine: 'ffmpeg' },
    })) as { decode_engine: string }
    expect(settings.decode_engine).toBe('ffmpeg')
    // Drive the REAL renderer setter: it hydrates the store synchronously, so
    // the PixiPreview subscription (and therefore the pool flag) runs before we
    // place the clip.
    await page.evaluate(async () => {
      await (window as unknown as {
        __weftcutTest: { setExperimentalMacosSharedTexture(enabled: boolean): Promise<unknown> }
      }).__weftcutTest.setExperimentalMacosSharedTexture(true)
    })

    const { layerId } = await importAndPlaceMedia(page, { mediaAbsPath: clip })
    // The preview bridge registers once the Panel's Pixi Application is up.
    await page.waitForFunction(
      () => {
        try {
          ;(window as unknown as { __weftcutTest: { activeClipProbe(id?: string): unknown } })
            .__weftcutTest.activeClipProbe()
          return true
        } catch {
          return false
        }
      },
      undefined,
      { timeout: 30_000, polling: 250 },
    )
    await page.evaluate(
      (us) => (window as unknown as { __weftcutTest: { weftcutSeekUs(us: number): void } }).__weftcutTest.weftcutSeekUs(us),
      SEEK_US,
    )

    // First let the lane resolve at all. On a host where VideoToolbox cannot
    // engage, this becomes a clean skip, not a 90 s timeout waiting for a
    // shared transport that will never exist.
    await expect
      .poll(async () => {
        const p = await probe(page, layerId)
        return p?.spriteBound && p.ringLastPtsUs != null ? p : null
      }, { timeout: 90_000, intervals: [200] })
      .not.toBeNull()
    const initial = await probe(page, layerId)
    test.skip(
      initial?.hwLane !== 'videotoolbox',
      `videotoolbox not engaged (hwLane=${initial?.hwLane}, sourceKind=${initial?.sourceKind}) — lane unavailable`,
    )

    // Shared-texture transport engaged: hardware lane, GPU-surface sharing, and
    // a real frame bound into the sprite.
    await expect
      .poll(async () => {
        const p = await probe(page, layerId)
        if (!p) return null
        if (
          p.sourceKind !== 'native-gpu'
          || p.hwLane !== 'videotoolbox'
          || !p.sharedTextureTransport
          || !p.spriteBound
          || (p.ringLastPtsUs ?? -1) < SEEK_US
        ) return null
        return p
      }, { timeout: 90_000, intervals: [200] })
      .not.toBeNull()
    const first = await probe(page, layerId)
    expect(first?.ringLastPtsUs ?? -1).toBeGreaterThanOrEqual(SEEK_US)

    const sample = async (): Promise<[number, number, number]> => {
      const s = (await page.evaluate(
        ([x, y]) => (window as unknown as { __weftcutTest: { weftcutSampleComposite(x: number, y: number): Promise<{ r: number; g: number; b: number }> } }).__weftcutTest.weftcutSampleComposite(x, y),
        [CANVAS.width / 2, CANVAS.height / 2] as const,
      )) as { r: number; g: number; b: number }
      return [s.r, s.g, s.b]
    }
    const sharedRgb = await sample()
    const sharedErr = Math.max(...sharedRgb.map((v, i) => Math.abs(v - EXPECTED_RGB[i]!)))
    // eslint-disable-next-line no-console
    console.log(`[macos-shared-texture] shared=${sharedRgb} error=${sharedErr}`)
    expect(sharedErr, `shared-texture color ${sharedRgb}`).toBeLessThanOrEqual(TOL)

    // Negative control + live toggle: off must re-open on copy-back and keep
    // the same pixels; on must return to the shared texture.
    await page.evaluate(async () => {
      await (window as unknown as {
        __weftcutTest: { setExperimentalMacosSharedTexture(enabled: boolean): Promise<unknown> }
      }).__weftcutTest.setExperimentalMacosSharedTexture(false)
    })
    await expect
      .poll(async () => probe(page, layerId), { timeout: 30_000, intervals: [200] })
      .toMatchObject({ hwLane: 'videotoolbox', sharedTextureTransport: false, spriteBound: true })
    const copyRgb = await sample()
    const copyErr = Math.max(...copyRgb.map((v, i) => Math.abs(v - EXPECTED_RGB[i]!)))
    // eslint-disable-next-line no-console
    console.log(`[macos-shared-texture] copy-back=${copyRgb} error=${copyErr}`)
    expect(copyErr, `copy-back color ${copyRgb}`).toBeLessThanOrEqual(TOL)

    await page.evaluate(async () => {
      await (window as unknown as {
        __weftcutTest: { setExperimentalMacosSharedTexture(enabled: boolean): Promise<unknown> }
      }).__weftcutTest.setExperimentalMacosSharedTexture(true)
    })
    await expect
      .poll(async () => probe(page, layerId), { timeout: 30_000, intervals: [200] })
      .toMatchObject({ hwLane: 'videotoolbox', sharedTextureTransport: true, spriteBound: true })

    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
