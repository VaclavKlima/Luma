import { test, expect } from '@playwright/test'
import { LibRaw } from '@colorhythm/libraw-wasm'
import { readFile } from 'node:fs/promises'
import { syntheticMerge } from './merge.helpers'
import { point } from '../src/main/merge/matrix'
import type { MergeMatrix } from '../src/shared/merge'

/** Native photograph texture; these engine inputs do not enable mobile-camera support. */
async function texture(index: number, width = 960, height = 720) {
  await LibRaw.initialize()
  const session = new LibRaw()
  await session.waitUntilReady()
  try {
    const bytes = await readFile(`tests/fixtures/hdrplus/payload_N00${index}.dng`)
    session.open(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    session.setHalfSize(0)
    session.setDemosaic(3)
    session.setOutputColor(0)
    session.setOutputBps(16)
    session.setGamma(0, 1)
    session.setGamma(1, 1)
    session.setNoAutoBright(1)
    session.setAdjustMaximumThr(0)
    session.setHighlight(1)
    // One fixed camera-space normalization for this engine-only DNG burst.
    for (let c = 0; c < 4; c++) session.setUserMul(c, 1)
    session.unpack()
    session.dcrawProcess()
    const frame = session.dcrawMakeMemImage(),
      pixels = new Uint16Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength / 2),
      data = new Float32Array(width * height),
      left = Math.floor((frame.width - width) / 2),
      top = Math.floor((frame.height - height) / 2)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const k = ((y + top) * frame.width + x + left) * 3
        data[y * width + x] = Math.max(
          0.008,
          (pixels[k] * 0.2627 + pixels[k + 1] * 0.678 + pixels[k + 2] * 0.0593) / 65535,
        )
      }
    return data
  } finally {
    session.dispose()
  }
}

test('independent native photograph transform survives exposure, clipping, noise and foreground motion', async () => {
  test.setTimeout(120000)
  const data = await texture(0),
    expected: MergeMatrix = [1.002, 0.004, 2.2, -0.003, 1.004, -1.3, 0.000004, -0.000003, 1]
  const f = await syntheticMerge([1, 2], {
    width: 960,
    height: 720,
    reference: 0,
    textures: [data, data],
    autoAlign: true,
    noise: 0.0005,
    motion: true,
    deghost: true,
    transforms: [[1, 0, 0, 0, 1, 0, 0, 0, 1], expected],
  })
  try {
    const actual = f.result.recipe.sources[1].transform.matrix!
    for (const [x, y] of [
      [80, 80],
      [880, 80],
      [80, 640],
      [880, 640],
    ]) {
      const a = point(actual, x, y),
        b = point(expected, x, y)
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThanOrEqual(0.5)
    }
    const patches = f.result.recipe.sources[1].transform.diagnostics!.nativePatches
    expect(patches.filter((p) => p.accepted).length / patches.length).toBeGreaterThanOrEqual(0.7)
  } finally {
    await f.close()
  }
})

test('photograph texture rejects two incompatible parallax planes', async () => {
  test.setTimeout(120000)
  const data = await texture(0),
    attempt = syntheticMerge([1, 1], {
      width: 960,
      height: 720,
      textures: [data, data],
      autoAlign: true,
      parallax: true,
    })
  await expect(attempt).rejects.toThrow(/geometric|alignment/)
})

test('licensed multi-frame HDR+ burst exercises the engine separately from Sony eligibility', async () => {
  test.setTimeout(120000)
  const textures = []
  for (let i = 0; i < 3; i++) textures.push(await texture(i))
  const f = await syntheticMerge([1, 1, 1], {
    width: 960,
    height: 720,
    textures,
    autoAlign: true,
    deghost: true,
  })
  try {
    expect(f.result.recipe.sources).toHaveLength(3)
    expect(f.result.recipe.resolution).toBe('native')
    expect(f.result.recipe.affectedPercent).toBeLessThan(95)
  } finally {
    await f.close()
  }
})
