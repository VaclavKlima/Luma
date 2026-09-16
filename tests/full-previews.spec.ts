import { expect, test } from '@playwright/test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { LibRaw } from '@colorhythm/libraw-wasm'
import { FullPreviews, PREVIEW_VERSION } from '../src/main/full-previews'
import { PreviewEngine } from '../src/main/preview-engine'
import { PreviewProcess } from '../src/main/preview-process'
import type { FullPreviewProcessor, FullPreviewResult } from '../src/main/preview-types'
import { automaticLensSettings, type ProcessingOptions } from '../src/shared/lens'
import { unavailableProfile } from '../src/main/processing/metadata'

async function writeFrame(
  output: string,
  bytes = Buffer.alloc(12 * 8 * 4),
  width = 12,
  height = 8,
): Promise<FullPreviewResult> {
  await writeFile(join(output, 'full.rgba'), bytes)
  await writeFile(join(output, 'placeholder.png'), 'placeholder')
  return {
    width,
    height,
    format: 'rgba8-srgb',
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    renderId: 'libraw-ahd-srgb-cpu-1',
    placeholderBytes: 11,
  }
}

const ids = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]
const original = (id: string) =>
  ids.includes(id) ? resolve('tests/fixtures/sony-zv1.ARW') : undefined

test('correction variants share the cache budget, carry the current revision and survive restart', async () => {
  const root = test.info().outputPath('variants')
  let renders = 0
  let options: ProcessingOptions = {
    metadata: { version: 1, lensProfile: unavailableProfile },
    settings: { ...automaticLensSettings },
    revision: 0,
  }
  const processor: FullPreviewProcessor = {
    renderFull: async (_path, output, _signal, options) => {
      renders++
      return { ...(await writeFrame(output)), appliedCorrections: options?.settings }
    },
    close: async () => {},
  }
  const create = () => new FullPreviews(root, original, processor, undefined, async () => options)
  let cache = create()
  try {
    await cache.open()
    const first = await cache.request(ids[0], randomUUID())
    options = { ...options, revision: 1, settings: { ...options.settings, distortion: false } }
    cache.settingsChanged(ids[0])
    const second = await cache.request(ids[0], randomUUID())
    expect(second.url).not.toBe(first.url)
    expect(second.settingsRevision).toBe(1)
    options = { ...options, revision: 2, settings: { ...automaticLensSettings } }
    cache.settingsChanged(ids[0])
    expect(await cache.request(ids[0], randomUUID())).toMatchObject({
      url: first.url,
      settingsRevision: 2,
    })
    expect(renders).toBe(2)
    await cache.close()
    cache = create()
    await cache.open()
    expect(await cache.requestCached(ids[0], randomUUID())).toMatchObject({
      url: first.url,
      settingsRevision: 2,
      appliedCorrections: automaticLensSettings,
    })
    const stream = cache.acquire(new URL(first.url))!
    await cache.beginRemoval(ids[0])
    cache.endRemoval(ids[0], true)
    expect(cache.acquire(new URL(second.url))).toBeUndefined()
    expect(await readFile(stream.path)).toHaveLength(12 * 8 * 4)
    stream.release()
    await cache.release()
    expect(await readdir(join(root, PREVIEW_VERSION))).toHaveLength(0)
  } finally {
    await cache.close()
  }
})

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

test('preserves native raster size, rotates once, converts profiles, and retains alpha', async () => {
  const info = test.info()
  const engine = new PreviewEngine()
  const source = info.outputPath('sources')
  await mkdir(source, { recursive: true })
  const small = join(source, 'small.png')
  const portrait = join(source, 'portrait.tiff')
  await sharp({
    create: {
      width: 80,
      height: 40,
      channels: 4,
      background: { r: 12, g: 100, b: 200, alpha: 0.5 },
    },
  })
    .png()
    .toFile(small)
  await sharp({ create: { width: 70, height: 30, channels: 3, background: '#da9012' } })
    .toColourspace('rgb16')
    .withMetadata({ orientation: 6 })
    .withIccProfile('p3')
    .tiff()
    .toFile(portrait)
  try {
    for (const [path, dimensions] of [
      [small, [80, 40]],
      [portrait, [30, 70]],
      [resolve('tests/fixtures/photos/alpine-lake.jpg'), [1920, 1280]],
    ] as const) {
      const output = info.outputPath(randomUUID())
      await mkdir(output)
      expect(await engine.renderFull(path, output)).toMatchObject({
        width: dimensions[0],
        height: dimensions[1],
      })
      const actual = await readFile(join(output, 'full.rgba'))
      const expected = await sharp(path)
        .autoOrient()
        .withIccProfile('srgb')
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer()
      expect(actual.equals(expected)).toBe(true)
      if (path === small) expect(actual[3]).toBe(128)
    }
  } finally {
    await engine.close()
  }
})

test('reuses cache across restarts and regenerates missing or explicitly invalidated entries', async () => {
  const info = test.info()
  const root = info.outputPath('cache')
  const bytes = Buffer.alloc(12 * 8 * 4, 100)
  let renders = 0
  const processor: FullPreviewProcessor = {
    renderFull: async (_path, output) => {
      renders++
      return writeFrame(output, bytes)
    },
    close: async () => {},
  }
  let cache = new FullPreviews(root, original, processor)
  try {
    await cache.open()
    expect(await cache.requestCached(ids[0], randomUUID())).toBeNull()
    expect(renders).toBe(0)
    const first = await cache.request(ids[0], randomUUID())
    await cache.close()
    cache = new FullPreviews(root, original, processor)
    await cache.open()
    const again = (await cache.requestCached(ids[0], randomUUID()))!
    expect(again.url).toBe(first.url)
    expect(renders).toBe(1)
    const lease = cache.acquire(new URL(first.url))!
    await rm(lease.path)
    lease.release()
    expect(await cache.requestCached(ids[0], randomUUID())).toBeNull()
    const repaired = await cache.request(ids[0], randomUUID())
    expect(repaired.url).not.toBe(first.url)
    expect(renders).toBe(2)
    const regenerated = await cache.request(ids[0], randomUUID(), true)
    expect(regenerated.url).not.toBe(repaired.url)
    expect(renders).toBe(3)
    expect(cache.acquire(new URL(repaired.url))).toBeUndefined()
    expect(cache.acquire(new URL(regenerated.url + '?path=/etc/passwd'))).toBeUndefined()
    await expect(cache.request('../bad', randomUUID())).rejects.toThrow('Invalid')
  } finally {
    await cache.close()
  }
})

test('bounds disk use with LRU eviction while protecting active previews and open streams', async () => {
  const info = test.info()
  const root = info.outputPath('cache')
  const bytes = Buffer.alloc(12 * 8 * 4)
  const processor: FullPreviewProcessor = {
    renderFull: async (_path, output) => {
      return writeFrame(output, bytes)
    },
    close: async () => {},
  }
  const cache = new FullPreviews(root, original, processor, bytes.length + 11)
  try {
    await cache.open()
    const a = await cache.request(ids[0], randomUUID())
    const stream = cache.acquire(new URL(a.url))!
    const b = await cache.request(ids[1], randomUUID())
    expect(await readFile(stream.path)).toEqual(bytes)
    expect(await readdir(join(root, PREVIEW_VERSION))).toHaveLength(2)
    stream.release()
    await cache.request(ids[1], randomUUID())
    expect(cache.acquire(new URL(a.url))).toBeUndefined()
    expect(await readdir(join(root, PREVIEW_VERSION))).toHaveLength(1)
    const c = await cache.request(ids[2], randomUUID())
    expect(cache.acquire(new URL(b.url))).toBeUndefined()
    const current = cache.acquire(new URL(c.url))!
    current.release()
    expect(await readdir(join(root, PREVIEW_VERSION))).toHaveLength(1)
  } finally {
    await cache.close()
  }
})

test('supersedes obsolete work, ignores old releases, and cancels before removal and shutdown', async () => {
  const info = test.info()
  let entered!: () => void
  let started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let slow = true
  let active = 0
  let maximum = 0
  const processor: FullPreviewProcessor = {
    renderFull: async (_path, output, signal) => {
      active++
      maximum = Math.max(maximum, active)
      try {
        await writeFile(join(output, 'partial'), 'unfinished')
        entered()
        if (slow)
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', () => resolve(), { once: true })
          })
        signal.throwIfAborted()
        return writeFrame(output)
      } finally {
        active--
      }
    },
    close: async () => {},
  }
  const root = info.outputPath('cache')
  const cache = new FullPreviews(root, original, processor)
  try {
    await cache.open()
    const oldToken = randomUUID()
    const a = cache.request(ids[0], oldToken).catch((error: Error) => error)
    await started
    // Removal of another photo must finish without waiting for this deliberately blocked render.
    await cache.beginRemoval(ids[1])
    await cache.endRemoval(ids[1], true)
    slow = false
    const b = cache.request(ids[1], randomUUID()).catch((error: Error) => error)
    const c = cache.request(ids[2], randomUUID())
    await cache.release(oldToken)
    expect(await a).toBeInstanceOf(Error)
    expect(await b).toBeInstanceOf(Error)
    const result = await c
    expect(result.photoId).toBe(ids[2])
    expect(maximum).toBe(1)
    await cache.beginRemoval(ids[2])
    await expect(cache.request(ids[2], randomUUID())).rejects.toThrow('unavailable')
    await cache.endRemoval(ids[2], true)
    expect(cache.acquire(new URL(result.url))).toBeUndefined()
    slow = true
    started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const removing = cache.request(ids[0], randomUUID()).catch((error: Error) => error)
    await started
    await cache.beginRemoval(ids[0])
    expect(await removing).toBeInstanceOf(Error)
    await cache.endRemoval(ids[0], false)
    started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const shutdown = cache.request(ids[0], randomUUID()).catch((error: Error) => error)
    await started
    await cache.close()
    expect(await shutdown).toBeInstanceOf(Error)
    expect(await readdir(join(root, PREVIEW_VERSION))).toEqual([])
  } finally {
    await cache.close()
  }
})

test('waits for a superseded worker to stop before removal without waiting for the next photo', async () => {
  let enteredA!: () => void
  let enteredB!: () => void
  let stopA!: () => void
  const startedA = new Promise<void>((resolve) => {
    enteredA = resolve
  })
  const startedB = new Promise<void>((resolve) => {
    enteredB = resolve
  })
  const stoppedA = new Promise<void>((resolve) => {
    stopA = resolve
  })
  const cache = new FullPreviews(test.info().outputPath('cache'), (id) => id, {
    renderFull: async (id, _output, signal) => {
      if (id === ids[0]) enteredA()
      else enteredB()
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      if (id === ids[0]) await stoppedA
      signal.throwIfAborted()
      return writeFrame(_output, Buffer.alloc(4), 1, 1)
    },
    close: async () => {},
  })
  try {
    await cache.open()
    const a = cache.request(ids[0], randomUUID()).catch((error: Error) => error)
    await startedA
    const b = cache.request(ids[1], randomUUID()).catch((error: Error) => error)
    let removalFinished = false
    const removal = cache.beginRemoval(ids[0]).then(() => {
      removalFinished = true
    })
    await Promise.resolve()
    expect(removalFinished).toBe(false)
    stopA()
    await removal
    expect(await a).toBeInstanceOf(Error)
    await startedB
    await cache.endRemoval(ids[0], true)
    await cache.release()
    expect(await b).toBeInstanceOf(Error)
  } finally {
    stopA()
    await cache.close()
  }
})

test('cleans interrupted and obsolete entries, and recovers after rendering failure', async () => {
  const info = test.info()
  const root = info.outputPath('cache')
  await mkdir(join(root, 'v0', 'obsolete'), { recursive: true })
  await mkdir(join(root, PREVIEW_VERSION, '.tmp-interrupted'), { recursive: true })
  await mkdir(join(root, PREVIEW_VERSION, `${ids[0]}-${randomUUID()}`), { recursive: true })
  let fail = true
  const cache = new FullPreviews(root, original, {
    renderFull: async (_path, output) => {
      await writeFile(join(output, 'full.rgba'), 'partial')
      if (fail) throw new Error('Disk write failed')
      return writeFrame(output, Buffer.alloc(4), 1, 1)
    },
    close: async () => {},
  })
  try {
    await cache.open()
    expect(await readdir(root)).toEqual([PREVIEW_VERSION])
    expect(await readdir(join(root, PREVIEW_VERSION))).toEqual([])
    await expect(cache.request(ids[0], randomUUID())).rejects.toThrow('Disk write failed')
    expect(await readdir(join(root, PREVIEW_VERSION))).toEqual([])
    fail = false
    expect((await cache.request(ids[0], randomUUID(), true)).width).toBe(1)
  } finally {
    await cache.close()
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
