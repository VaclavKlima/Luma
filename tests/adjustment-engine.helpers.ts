import { expect, test } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { PreviewEngine } from '../src/main/preview-engine'
import { renderAdjustments, neutralAdjustments } from '../src/shared/adjustments'
import { noLensSettings } from '../src/shared/lens'

export function engineAgreement(formats: readonly ('png' | 'tiff' | 'jpeg' | 'raw')[]) {
  for (const format of formats)
    test(`${format} uses float originals and reuses working pixels for combined adjustments`, async () => {
      // RAW covers four independent cold decodes as well as warmed full-frame comparisons.
      if (format === 'raw') test.setTimeout(120000)
      const root = test.info().outputPath(format)
      await mkdir(root, { recursive: true })
      const source =
        format === 'raw' ? 'tests/fixtures/sony-zv1.ARW' : join(root, `source.${format}`)
      if (format !== 'raw')
        await sharp(Buffer.from([120, 80, 200, 128, 255, 255, 255, 255]), {
          raw: { width: 2, height: 1, channels: 4 },
        })
          .toFormat(format)
          .toFile(source)
      const engine = new PreviewEngine(undefined, 'cpu')
      try {
        const metadata = await engine.inspect(source)
        const options = { metadata, settings: noLensSettings, revision: 0, prepareLinear: true }
        const neutral = await engine.renderFull(source, root, undefined, options)
        const pixels = await readFile(join(root, 'full.rgba'))
        const reference =
          format === 'raw'
            ? pixels
            : await sharp(source)
                .withIccProfile('srgb')
                .toColourspace('srgb')
                .ensureAlpha()
                .raw()
                .toBuffer()
        expect(
          pixels.reduce((max, value, i) => Math.max(max, Math.abs(value - reference[i])), 0),
        ).toBeLessThanOrEqual(1)
        const bytes = await readFile(join(root, 'linear.f32'))
        const working = new Float32Array(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        )
        const adjusted = await engine.renderFull(source, root, undefined, {
          ...options,
          adjustments: {
            shadows: 65,
            whites: -35,
            blacks: -20,
            exposureEv: -1.5,
            contrast: 60,
            highlights: -75,
          },
          revision: 1,
        })
        expect(adjusted.diagnostics?.timings.reusedWorking).toBe(1)
        const expectedCombined = Buffer.from(
          renderAdjustments(
            working,
            {
              shadows: 65,
              whites: -35,
              blacks: -20,
              exposureEv: -1.5,
              contrast: 60,
              highlights: -75,
            },
            neutral.linear!.transform,
          ),
        )
        expect((await readFile(join(root, 'full.rgba'))).equals(expectedCombined)).toBe(true)
        for (const key of ['shadows', 'whites', 'blacks'] as const) {
          const adjustments = { ...neutralAdjustments, [key]: key === 'blacks' ? -65 : 75 }
          const result = await engine.renderFull(source, root, undefined, {
            ...options,
            adjustments,
          })
          expect(result.diagnostics?.timings.reusedWorking).toBe(1)
          const expected = Buffer.from(
            renderAdjustments(working, adjustments, neutral.linear!.transform),
          )
          expect((await readFile(join(root, 'full.rgba'))).equals(expected)).toBe(true)
        }
        if (format === 'raw') {
          // Each adjustment must independently activate linear RAW fallback without a prepared asset.
          await engine.close()
          for (const key of ['highlights', 'shadows', 'whites', 'blacks'] as const) {
            const cold = new PreviewEngine(undefined, 'cpu')
            try {
              const adjustments = { ...neutralAdjustments, [key]: -100 }
              await cold.renderFull(source, root, undefined, {
                metadata,
                settings: noLensSettings,
                revision: 2,
                adjustments,
              })
              const expected = Buffer.from(
                renderAdjustments(working, adjustments, neutral.linear!.transform),
              )
              expect((await readFile(join(root, 'full.rgba'))).equals(expected)).toBe(true)
              expect(expected.equals(pixels)).toBe(false)
            } finally {
              await cold.close()
            }
          }
        }
      } finally {
        await engine.close()
      }
    })
}
