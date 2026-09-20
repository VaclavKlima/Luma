import { build } from 'esbuild'
import sharp from 'sharp'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'

export function rendererAgreement(fixtures: readonly ('synthetic' | 'raster' | 'raw')[]) {
  for (const fixture of fixtures)
    test(`${fixture} WebGL combined adjustments match CPU, reuses the working texture and coalesces fallback changes`, async ({
      luma,
    }, info) => {
      test.setTimeout(120000)
      const { page } = luma
      let source =
        fixture === 'raw' ? 'tests/fixtures/sony-zv1.ARW' : 'tests/fixtures/photos/alpine-lake.jpg'
      if (fixture === 'synthetic') {
        source = info.outputPath('ramp.png')
        const pixels = Buffer.alloc(256 * 256 * 4)
        for (let y = 0; y < 256; y++)
          for (let x = 0; x < 256; x++) {
            const offset = (y * 256 + x) * 4
            pixels.set([x, y, (x + y) >> 1, x < 100 ? 128 : 255], offset)
          }
        await sharp(pixels, { raw: { width: 256, height: 256, channels: 4 } })
          .png()
          .toFile(source)
      }
      await importPhotos(luma.app, page, [source])
      const preview = page.getByTestId('main-preview')
      await expect(preview).toHaveAttribute('data-editing', 'ready', { timeout: 40000 })
      const id = (await page.evaluate(() => window.luma.listPhotos())).photos[0].id
      const compiled = await build({
        stdin: {
          contents: `export { renderAdjustments, neutralAdjustments } from './src/shared/adjustments'`,
          resolveDir: process.cwd(),
        },
        bundle: true,
        format: 'iife',
        globalName: 'highlightsReference',
        write: false,
      })
      await page.evaluate(compiled.outputFiles[0].text)
      await page.evaluate(async (id) => {
        const result = await window.luma.requestEditingPreview(id, crypto.randomUUID())
        const bytes = await (await fetch(result.linear!.url!)).arrayBuffer()
        const target = window as unknown as { highlightsTest: unknown }
        target.highlightsTest = { frame: result, data: new Float32Array(bytes), uploads: 0 }
        const upload = WebGL2RenderingContext.prototype.texImage2D
        WebGL2RenderingContext.prototype.texImage2D = function (...args: unknown[]) {
          ;(target.highlightsTest as { uploads: number }).uploads++
          return Reflect.apply(upload, this, args)
        }
        await window.luma.releaseFullPreview(result.requestId)
      }, id)
      await page.getByRole('combobox', { name: 'Preview zoom' }).selectOption('1')
      const compare = () =>
        page.evaluate(() => {
          const test = window as unknown as {
            highlightsTest: {
              data: Float32Array
              frame: import('../src/shared/contracts').FullPreview
              uploads: number
            }
            highlightsReference: typeof import('../src/shared/adjustments')
          }
          const { frame, data } = test.highlightsTest
          const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
          const viewport = canvas.parentElement!
          const box = viewport.getBoundingClientRect()
          const parameters = {
            whiteBalance: JSON.parse(canvas.dataset.whiteBalance!),
            shadows: Number(canvas.dataset.shadows),
            whites: Number(canvas.dataset.whites),
            blacks: Number(canvas.dataset.blacks),
            exposureEv: Number(canvas.dataset.exposure),
            highlights: Number(canvas.dataset.highlights),
            contrast: Number(canvas.dataset.contrast),
          }
          const gl = canvas.dataset.backend === 'webgl2' ? canvas.getContext('webgl2') : null
          let max = 0
          for (const dx of [-48, 0, 48]) {
            const x = Math.floor(canvas.width / 2 + dx * devicePixelRatio)
            const y = Math.floor(canvas.height / 2)
            const sx = Math.floor(
              (x + 0.5) / devicePixelRatio -
                box.width / 2 -
                Number(viewport.dataset.panX) +
                frame.width / 2,
            )
            const sy = Math.floor(
              (y + 0.5) / devicePixelRatio -
                box.height / 2 -
                Number(viewport.dataset.panY) +
                frame.height / 2,
            )
            const offset = (sy * frame.width + sx) * 4
            const expected = test.highlightsReference.renderAdjustments(
              data.slice(offset, offset + 4),
              canvas.dataset.comparison === 'before' ||
                (canvas.dataset.comparison === 'split' &&
                  (x + 0.5) / devicePixelRatio < box.width / 2)
                ? test.highlightsReference.neutralAdjustments
                : parameters,
              frame.linear!.transform,
            )
            const actual = new Uint8Array(4)
            if (gl) gl.readPixels(x, canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, actual)
            else actual.set(canvas.getContext('2d')!.getImageData(x, y, 1, 1).data)
            for (let c = 0; c < 4; c++) max = Math.max(max, Math.abs(actual[c] - expected[c]))
          }
          return { max, uploads: test.highlightsTest.uploads }
        })
      for (const [exposureEv, contrast, highlights, shadows = 0, whites = 0, blacks = 0] of [
        [0, 0, 0, -100, 0, 0],
        [0, 0, 0, 100, 0, 0],
        [0, 0, 0, 0, -100, 0],
        [0, 0, 0, 0, 100, 0],
        [0, 0, 0, 0, 0, -100],
        [0, 0, 0, 0, 0, 100],
        [0.75, 35, -65, 80, -40, 25],
        [-0.5, -35, 40, -80, 60, -30],
        [0, 35, -100],
        [0, -100, 0],
        [0, 35, 100],
        [0, 100, 0],
        [-1.25, 35, 50],
        [-1.25, 50, 0],
        [1, 35, -35],
        [1, -35, 0],
        [0, 35, 0],
        [0, 0, 0],
      ]) {
        await page.evaluate(
          async ({ id, exposureEv, contrast, highlights, shadows, whites, blacks, fixture }) => {
            const state = await window.luma.getEdits(id)
            await window.luma.updateEdits(
              id,
              {
                shadows,
                whites,
                blacks,
                exposureEv,
                contrast,
                highlights,
                whiteBalance:
                  fixture === 'raw' && exposureEv !== 0
                    ? { mode: 'custom', kelvin: 8000, tint: 25 }
                    : { mode: 'as-shot' },
              },
              state.revision,
            )
          },
          { shadows, whites, blacks, id, exposureEv, contrast, highlights, fixture },
        )
        await expect(preview).toHaveAttribute('data-shadows', String(shadows))
        await expect(preview).toHaveAttribute('data-whites', String(whites))
        await expect(preview).toHaveAttribute('data-blacks', String(blacks))
        await expect(preview).toHaveAttribute('data-contrast', String(contrast))
        await expect(preview).toHaveAttribute('data-highlights', String(highlights))
        await expect(preview).toHaveAttribute('data-exposure', String(exposureEv))
        await expect.poll(async () => (await compare()).max).toBeLessThanOrEqual(1)
      }
      await page.evaluate(async (id) => {
        const state = await window.luma.getEdits(id)
        await window.luma.updateEdits(id, { exposureEv: 1 }, state.revision)
      }, id)
      await expect(preview).toHaveAttribute('data-exposure', '1')
      await preview.focus()
      await preview.press('\\')
      await expect(preview).toHaveAttribute('data-comparison', 'before')
      await expect.poll(async () => (await compare()).max).toBeLessThanOrEqual(1)
      await preview.press('y')
      await expect(preview).toHaveAttribute('data-comparison', 'split')
      await expect.poll(async () => (await compare()).max).toBeLessThanOrEqual(1)
      await preview.press('y')
      expect((await compare()).uploads).toBe(0)
      await preview.evaluate((element) =>
        (element as HTMLCanvasElement)
          .getContext('webgl2')!
          .getExtension('WEBGL_lose_context')!
          .loseContext(),
      )
      await expect(preview).toHaveAttribute('data-backend', 'canvas2d')
      await expect(preview).toHaveAttribute('data-editing', 'ready')
      // Deliberately queue updates without waiting for the CPU worker's previous bitmap.
      await page.evaluate(async (id) => {
        for (const highlights of [-100, 100, -50, 80, 25]) {
          const state = await window.luma.getEdits(id)
          await window.luma.updateEdits(
            id,
            {
              highlights,
              contrast: -highlights,
              shadows: -highlights,
              whites: highlights,
              blacks: -highlights,
            },
            state.revision,
          )
        }
      }, id)
      await expect(preview).toHaveAttribute('data-highlights', '25')
      await expect(preview).toHaveAttribute('data-shadows', '-25')
      await expect(preview).toHaveAttribute('data-whites', '25')
      await expect(preview).toHaveAttribute('data-blacks', '-25')
      await expect
        .poll(async () => (await compare()).max, { timeout: 30000 })
        .toBeLessThanOrEqual(2)
      await preview.focus()
      await preview.press('y')
      await expect(preview).toHaveAttribute('data-comparison', 'split')
      await expect
        .poll(async () => (await compare()).max, { timeout: 30000 })
        .toBeLessThanOrEqual(2)
    })
}
