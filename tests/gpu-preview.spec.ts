import { test, expect } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { LibRaw } from '@colorhythm/libraw-wasm'
import sharp from 'sharp'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { readGpuSource, type RawSource } from '../src/main/gpu/raw-source'
import { PreviewEngine } from '../src/main/preview-engine'

async function hardwareRender(gpu: RawGpuRenderer, source: RawSource) {
  try {
    return await gpu.render(source)
  } catch (error) {
    if (error instanceof Error && error.message === 'No hardware GPU adapter is available.')
      test.skip(true, 'No hardware GPU adapter; CPU fallback is tested separately.')
    throw error
  }
}

// Additional local samples are read in place; photographs are never added to fixtures.
const rawSamples: string[] = process.env.LUMA_RAW_TEST_FILES
  ? JSON.parse(process.env.LUMA_RAW_TEST_FILES)
  : ['tests/fixtures/sony-zv1.ARW']

for (const sample of rawSamples) {
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture arguments must be destructured.
  test(`Sony GPU AHD preserves CPU rendering and full detail: ${basename(sample)}`, async ({}, info) => {
    test.setTimeout(90_000)
    await LibRaw.initialize()
    const decoder = new LibRaw()
    await decoder.waitUntilReady()
    const gpu = new RawGpuRenderer()
    try {
      const bytes = await readFile(sample)
      decoder.open(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      decoder.setHalfSize(0)
      decoder.setDemosaic(3)
      decoder.setUseCameraWb(1)
      decoder.setOutputColor(1)
      decoder.setGamma(0, 1 / 2.4)
      decoder.setGamma(1, 12.92)
      decoder.setOutputBps(8)
      decoder.unpack()
      const source = readGpuSource(decoder)!
      expect(source).not.toBeNull()
      const started = performance.now()
      const actual = await hardwareRender(gpu, source)
      const gpuMs = performance.now() - started
      const cpuStart = performance.now()
      decoder.dcrawProcess()
      const reference = decoder.dcrawMakeMemImage()
      const cpuMs = performance.now() - cpuStart
      expect([actual.width, actual.height]).toEqual([reference.width, reference.height])
      let difference = 0,
        large = 0,
        max = 0
      for (let i = 0; i < reference.width * reference.height; i++)
        for (let c = 0; c < 3; c++) {
          const delta = Math.abs(actual.data[i * 4 + c] - reference.data[i * 3 + c])
          difference += delta
          max = Math.max(max, delta)
          if (delta > 2) large++
        }
      const samples = reference.width * reference.height * 3
      const report = {
        gpuMs,
        cpuMs,
        mean: difference / samples,
        largeFraction: large / samples,
        max,
        timings: actual.timings,
        scale: source.scale,
      }
      console.log(report)
      await writeFile(info.outputPath('comparison.json'), JSON.stringify(report, null, 2))
      await sharp(actual.data, { raw: { width: actual.width, height: actual.height, channels: 4 } })
        .resize(1280)
        .png()
        .toFile(info.outputPath('gpu.png'))
      await sharp(reference.data, {
        raw: { width: reference.width, height: reference.height, channels: 3 },
      })
        .resize(1280)
        .png()
        .toFile(info.outputPath('cpu.png'))
      expect(report.mean).toBeLessThan(0.02)
      expect(report.largeFraction).toBeLessThan(0.001)
    } finally {
      decoder.dispose()
      gpu.close()
    }
  })
}

test('ZV-1A metadata enables the verified GPU layout while unknown models stay on CPU', async () => {
  await LibRaw.initialize()
  const decoder = new LibRaw()
  await decoder.waitUntilReady()
  try {
    const bytes = await readFile('tests/fixtures/sony-zv1.ARW')
    decoder.open(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    decoder.unpack()
    const camera = decoder.getIParams()
    decoder.getIParams = () => ({ ...camera, normalized_model: 'ZV-1A' })
    expect(readGpuSource(decoder)).not.toBeNull()
    decoder.getIParams = () => ({ ...camera, normalized_model: 'unverified camera' })
    expect(readGpuSource(decoder)).toBeNull()
    decoder.getIParams = () => ({ ...camera, normalized_make: 'Other', normalized_model: 'ZV-1A' })
    expect(readGpuSource(decoder)).toBeNull()
    decoder.getIParams = () => ({ ...camera, normalized_model: 'ZV-1A' })
    decoder.getPixelAspect = () => 2
    expect(readGpuSource(decoder)).toBeNull()
  } finally {
    decoder.dispose()
  }
})

test('GPU stripes preserve neutral colors, black, highlights and all flip orientations', async () => {
  const gpu = new RawGpuRenderer()
  const width = 64,
    height = 600,
    rawWidth = 68
  const left = 2,
    top = 4
  const pixels = new Uint16Array(rawWidth * (height + top))
  // Flat neutral bars cross both 256-row stripe boundaries, with stored row padding.
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      pixels[(y + top) * rawWidth + x + left] = x < 16 ? 100 : x < 48 ? 10000 : 65535
  const source: RawSource = {
    pixels,
    width,
    height,
    rawWidth,
    left,
    top,
    flip: 0,
    cfa: [0, 1, 3, 2],
    black: [100, 100, 100, 100],
    scale: [1, 1, 1, 1],
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
  }
  try {
    const reference = await hardwareRender(gpu, source)
    for (const x of [8, 32, 56])
      for (let y = 6; y < height - 6; y++) {
        const offset = (y * width + x) * 4
        expect(reference.data[offset]).toBe(reference.data[offset + 1])
        expect(reference.data[offset + 1]).toBe(reference.data[offset + 2])
        expect(reference.data[offset]).toBe(reference.data[(10 * width + x) * 4])
        expect(reference.data[offset + 3]).toBe(255)
      }
    expect(reference.data[(10 * width + 8) * 4]).toBe(0)
    expect(reference.data[(10 * width + 56) * 4]).toBe(255)
    for (let flip = 1; flip < 8; flip++) {
      const actual = await gpu.render({ ...source, flip })
      expect([actual.width, actual.height]).toEqual(flip & 4 ? [height, width] : [width, height])
      for (let y = 0; y < height; y += 17)
        for (let x = 0; x < width; x += 7) {
          let dx = flip & 1 ? width - 1 - x : x,
            dy = flip & 2 ? height - 1 - y : y
          if (flip & 4) [dx, dy] = [dy, dx]
          expect(
            actual.data.subarray((dy * actual.width + dx) * 4, (dy * actual.width + dx) * 4 + 4),
          ).toEqual(reference.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))
        }
    }
    // Simulate an actual WebGPU device-lost notification, then verify a clean failure.
    const device = (gpu as unknown as { device: GPUDevice }).device
    device.destroy()
    await device.lost
    await expect(gpu.render(source)).rejects.toThrow('GPU device lost')
  } finally {
    gpu.close()
  }
})

test('GPU failure falls back to a complete CPU frame with its own matching placeholder', async () => {
  const output = test.info().outputPath('fallback')
  await mkdir(output, { recursive: true })
  const engine = new PreviewEngine(undefined, 'auto', {
    render: async () => {
      throw new Error('Simulated GPU device loss')
    },
    releaseFrame: () => {},
    close: () => {},
  })
  try {
    const result = await engine.renderFull('tests/fixtures/sony-zv1.ARW', output)
    expect(result.renderId).toBe('libraw-ahd-srgb-cpu-1')
    expect(result.diagnostics).toMatchObject({
      backend: 'cpu',
      fallback: 'Simulated GPU device loss',
    })
    const frame = await readFile(`${output}/full.rgba`)
    expect(frame.length).toBe(5496 * 3672 * 4)
    const placeholder = await sharp(frame, { raw: { width: 5496, height: 3672, channels: 4 } })
      .resize({ width: 96, height: 96, fit: 'inside', withoutEnlargement: true })
      .withIccProfile('srgb')
      .png()
      .toBuffer()
    expect(await readFile(`${output}/placeholder.png`)).toEqual(placeholder)
  } finally {
    await engine.close()
  }
})
