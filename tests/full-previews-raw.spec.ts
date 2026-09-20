import { LibRaw } from '@colorhythm/libraw-wasm'
import { expect, test } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { PreviewEngine } from '../src/main/preview-engine'
import { PreviewProcess } from '../src/main/preview-process'

test('renders full Sony RAW pixels losslessly, with sRGB output and no embedded extraction', async () => {
  const info = test.info()
  const output = info.outputPath('full')
  await mkdir(output, { recursive: true })
  let extracted = false
  const engine = new PreviewEngine(async () => {
    extracted = true
    throw new Error('Do not extract')
  }, 'cpu')
  const source = await readFile('tests/fixtures/sony-zv1.ARW')
  try {
    expect(await engine.renderFull('tests/fixtures/sony-zv1.ARW', output)).toMatchObject({
      width: 5496,
      height: 3672,
    })
    expect(extracted).toBe(false)
    expect((await readFile(join(output, 'full.rgba'))).length).toBe(5496 * 3672 * 4)
    expect((await sharp(join(output, 'placeholder.png')).metadata()).hasProfile).toBe(true)
    await LibRaw.initialize()
    const decoder = new LibRaw()
    await decoder.waitUntilReady()
    try {
      decoder.open(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength))
      decoder.setHalfSize(0)
      decoder.setDemosaic(3)
      decoder.setUseCameraWb(1)
      decoder.setOutputColor(1)
      decoder.setGamma(0, 1 / 2.4)
      decoder.setGamma(1, 12.92)
      decoder.setOutputBps(8)
      decoder.unpack()
      decoder.dcrawProcess()
      const pixels = decoder.dcrawMakeMemImage()
      const actual = await sharp(await readFile(join(output, 'full.rgba')), {
        raw: { width: 5496, height: 3672, channels: 4 },
      })
        .removeAlpha()
        .raw()
        .toBuffer()
      expect(actual.equals(Buffer.from(pixels.data))).toBe(true)
    } finally {
      decoder.dispose()
    }
    expect((await readFile('tests/fixtures/sony-zv1.ARW')).equals(source)).toBe(true)
  } finally {
    await engine.close()
  }
})

test('cancels a real full-resolution worker and can render again afterwards', async () => {
  const info = test.info()
  const worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  const output = info.outputPath('worker')
  await mkdir(output, { recursive: true })
  const timed = new PreviewProcess(resolve('out/main/preview-worker.js'), 25)
  try {
    await expect(
      timed.renderFull(
        resolve('tests/fixtures/sony-zv1.ARW'),
        output,
        new AbortController().signal,
      ),
    ).rejects.toThrow('timed out')
  } finally {
    await timed.close()
  }
  const abort = new AbortController()
  const rendering = worker.renderFull(resolve('tests/fixtures/sony-zv1.ARW'), output, abort.signal)
  const timer = setTimeout(() => abort.abort(), 100)
  try {
    await expect(rendering).rejects.toThrow('cancelled')
    const crashed = worker.renderFull(
      resolve('tests/fixtures/sony-zv1.ARW'),
      output,
      new AbortController().signal,
    )
    const stopped = expect(crashed).rejects.toThrow('stopped')
    await worker.close(true)
    await stopped
    expect(
      await worker.renderFull(
        resolve('tests/fixtures/photos/alpine-lake.jpg'),
        output,
        new AbortController().signal,
      ),
    ).toMatchObject({ width: 1920, height: 1280 })
  } finally {
    clearTimeout(timer)
    await worker.close()
  }
})
