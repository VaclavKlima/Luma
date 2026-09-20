import { expect, test } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import { PreviewEngine } from '../src/main/preview-engine'
import { rawDecoder } from '../src/main/processing/decoders'
import { automaticLensSettings, noLensSettings, type ProcessingOptions } from '../src/shared/lens'

test('real Sony corrected CPU and GPU frames agree, reuse linear data and generate exact placeholders', async () => {
  test.setTimeout(180_000)
  const root = test.info().outputPath('corrected')
  await mkdir(root, { recursive: true })
  const cpu = new PreviewEngine(undefined, 'cpu'),
    gpu = new PreviewEngine(undefined, 'auto')
  const path = 'tests/fixtures/sony-zv1.ARW'
  try {
    const metadata = await cpu.inspect(path)
    expect(metadata.lensProfile.distortion?.values).toHaveLength(11)
    expect(metadata.lensProfile.vignetting?.values).toHaveLength(16)
    expect(metadata.lensProfile.chromaticAberration?.red.values).toHaveLength(11)
    const options: ProcessingOptions = { metadata, settings: automaticLensSettings, revision: 7 }
    const reference = await cpu.renderFull(path, root, undefined, options)
    const expected = await readFile(`${root}/full.rgba`)
    const actual = await gpu.renderFull(path, root, undefined, options)
    if (actual.diagnostics?.fallback?.includes('No hardware GPU'))
      test.skip(true, 'No hardware GPU available; CPU render completed.')
    expect(actual.diagnostics?.backend, JSON.stringify(actual.diagnostics)).toBe('gpu')
    expect([actual.width, actual.height]).toEqual([reference.width, reference.height])
    expect(actual.settingsRevision).toBe(7)
    const pixels = await readFile(`${root}/full.rgba`)
    let difference = 0,
      large = 0
    for (let i = 0; i < pixels.length; i++) {
      const delta = Math.abs(pixels[i] - expected[i])
      difference += delta
      if (delta > 2) large++
    }
    const report = {
      cpu: reference.diagnostics,
      gpu: actual.diagnostics,
      mean: difference / pixels.length,
      largeFraction: large / pixels.length,
      width: actual.width,
      height: actual.height,
    }
    console.log(report)
    await writeFile(
      test.info().outputPath('corrected-comparison.json'),
      JSON.stringify(report, null, 2),
    )
    await sharp(pixels, { raw: { width: actual.width, height: actual.height, channels: 4 } })
      .resize(1280)
      .png()
      .toFile(test.info().outputPath('corrected.png'))
    expect(report.mean).toBeLessThan(0.1)
    expect(report.largeFraction).toBeLessThan(0.002)
    const placeholder = await sharp(pixels, {
      raw: { width: actual.width, height: actual.height, channels: 4 },
    })
      .resize({ width: 96, height: 96, fit: 'inside', withoutEnlargement: true })
      .withIccProfile('srgb')
      .png()
      .toBuffer()
    expect(await readFile(`${root}/placeholder.png`)).toEqual(placeholder)
    const adjustedOptions = {
      ...options,
      adjustments: {
        shadows: 65,
        whites: -35,
        blacks: -20,
        exposureEv: 0.75,
        contrast: 35,
        highlights: -80,
      },
      revision: 8,
    }
    await cpu.renderFull(path, root, undefined, adjustedOptions)
    const adjustedReference = await readFile(`${root}/full.rgba`)
    await gpu.renderFull(path, root, undefined, adjustedOptions)
    const adjustedPixels = await readFile(`${root}/full.rgba`)
    let adjustedDifference = 0,
      adjustedLarge = 0
    for (let i = 0; i < adjustedPixels.length; i++) {
      const delta = Math.abs(adjustedPixels[i] - adjustedReference[i])
      adjustedDifference += delta
      if (delta > 2) adjustedLarge++
    }
    expect(adjustedDifference / adjustedPixels.length).toBeLessThan(0.1)
    expect(adjustedLarge / adjustedPixels.length).toBeLessThan(0.002)
    const toggled = await gpu.renderFull(path, root, undefined, {
      ...options,
      settings: { ...noLensSettings, distortion: true },
      revision: 8,
    })
    expect(toggled.diagnostics?.timings.reusedLinear).toBe(1)
    expect(toggled.appliedCorrections).toEqual({ ...noLensSettings, distortion: true })
  } finally {
    await cpu.close()
    await gpu.close()
  }
})

test('CPU adapter exposes an owned unrotated linear camera frame', async () => {
  const session = await rawDecoder('sample.arw')!.open('tests/fixtures/sony-zv1.ARW')
  try {
    const frame = session.linear()
    expect([frame.width, frame.height]).toEqual([5496, 3672])
    expect(frame.data.length).toBe(frame.width * frame.height * 4)
    expect(frame.data.some((n) => n > 0 && n < 1)).toBe(true)
  } finally {
    session.close()
  }
})

test('corrected previews retain all supported corrections after GPU failure', async () => {
  test.setTimeout(60_000)
  const root = test.info().outputPath('fallback')
  await mkdir(root, { recursive: true })
  const engine = new PreviewEngine(undefined, 'auto', {
    render: async () => {
      throw new Error('Simulated corrected GPU failure')
    },
    releaseFrame: () => {},
    close: () => {},
  })
  try {
    const path = 'tests/fixtures/sony-zv1.ARW'
    const metadata = await engine.inspect(path)
    const result = await engine.renderFull(path, root, undefined, {
      metadata,
      settings: automaticLensSettings,
      revision: 3,
    })
    expect(result).toMatchObject({
      width: 5422,
      height: 3622,
      settingsRevision: 3,
      appliedCorrections: automaticLensSettings,
      diagnostics: { backend: 'cpu', fallback: 'Simulated corrected GPU failure' },
    })
    const second = await engine.renderFull(path, root, undefined, {
      metadata,
      settings: { ...automaticLensSettings, vignetting: false },
      revision: 4,
    })
    expect(second.diagnostics?.timings.reusedLinear).toBe(1)
    expect(second.settingsRevision).toBe(4)
    const frame = await readFile(`${root}/full.rgba`)
    expect(frame.length).toBe(second.byteLength)
  } finally {
    await engine.close()
  }
})
