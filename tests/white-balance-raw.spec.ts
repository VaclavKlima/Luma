import { correctionPlan } from '../src/main/processing/lens-correction'
import { expect, test } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PreviewEngine } from '../src/main/preview-engine'
import { neutralAdjustments, renderAdjustments } from '../src/shared/adjustments'
import { automaticLensSettings, noLensSettings } from '../src/shared/lens'
import { librawDecoder } from '../src/main/processing/decoders/libraw'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { resolveWhiteBalance } from '../src/main/processing/white-balance'

test('Sony gains and camera matrices support custom WB with native GPU/CPU agreement and retained working pixels', async () => {
  test.setTimeout(120000)
  const path = 'tests/fixtures/sony-zv1.ARW',
    root = test.info().outputPath('wb')
  await mkdir(root, { recursive: true })
  const session = await librawDecoder.open(path),
    gpu = new RawGpuRenderer(),
    engine = new PreviewEngine(undefined, 'cpu')
  try {
    const profile = resolveWhiteBalance(session.metadata)
    expect(profile).toBeDefined()
    session.unpack()
    const source = session.gpuSource()!
    source.whiteBalance = profile
    const neutral = await gpu.render(source, undefined, neutralAdjustments, true)
    expect(neutral.working?.transform.whiteBalance).toEqual(profile)
    const parameters = {
      ...neutralAdjustments,
      whiteBalance: { mode: 'custom' as const, kelvin: 8000, tint: 25 },
      exposureEv: 0.5,
      contrast: 20,
      highlights: -50,
      shadows: 30,
      whites: -20,
      blacks: 10,
    }
    const adjusted = await gpu.render(source, undefined, parameters)
    const reference = renderAdjustments(
      neutral.working!.data,
      parameters,
      neutral.working!.transform,
    )
    let max = 0
    for (let i = 0; i < reference.length; i++)
      max = Math.max(max, Math.abs(reference[i] - adjusted.data[i]))
    expect(max).toBeLessThanOrEqual(1)
    const again = await gpu.render(source)
    expect(again.data.equals(neutral.data)).toBe(true)
    await gpu.close()
    const metadata = await engine.inspect(path)
    const plan = correctionPlan(
      source.width,
      source.height,
      metadata.lensProfile,
      automaticLensSettings,
    )
    const corrected = await gpu.render(source, plan, neutralAdjustments, true)
    const correctedCustom = await gpu.render(source, plan, parameters)
    const correctedReference = renderAdjustments(
      corrected.working!.data,
      parameters,
      corrected.working!.transform,
    )
    let correctedMax = 0
    for (let i = 0; i < correctedReference.length; i++)
      correctedMax = Math.max(
        correctedMax,
        Math.abs(correctedReference[i] - correctedCustom.data[i]),
      )
    expect(correctedMax).toBeLessThanOrEqual(1)
    gpu.close()
    for (const settings of [noLensSettings, automaticLensSettings]) {
      const options = { metadata, settings, revision: 0, prepareLinear: true }
      const baseline = await engine.renderFull(path, root, undefined, options)
      const bytes = await readFile(join(root, 'linear.f32'))
      const floats = new Float32Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      )
      const result = await engine.renderFull(path, root, undefined, {
        ...options,
        adjustments: parameters,
        revision: 1,
      })
      expect(result.diagnostics?.timings.reusedWorking).toBe(1)
      const expected = Buffer.from(
        renderAdjustments(floats, parameters, baseline.linear!.transform),
      )
      expect((await readFile(join(root, 'full.rgba'))).equals(expected)).toBe(true)
      expect((await engine.statistics(join(root, 'full.rgba'), result)).visiblePixels).toBe(
        result.width * result.height,
      )
    }
  } finally {
    session.close()
    gpu.close()
    await engine.close()
  }
})
