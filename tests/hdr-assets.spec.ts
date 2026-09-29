import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHdrStrips } from '../src/main/processing/hdr-processing'
import { DisplayState } from '../src/main/display-state'
import {
  readHdrUploadBytes,
  validateHdrAsset,
  validateHdrStrip,
} from '../src/renderer/src/preview/hdr-stream'
import type { HdrWorkingAsset } from '../src/shared/hdr'

test('HDR streams reject interrupted writes, damaged hashes and nonfinite samples', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-hdr-assets-')),
    path = join(root, 'pixels')
  const data = new Float32Array([-0.1, 2, 16, 1, 0, 0.18, 1, 0]),
    bytes = Buffer.from(data.buffer)
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const asset = workingAsset(bytes, 2, 1)
  const scan = async () => {
    for await (const data of readHdrStrips(path, asset)) expect(data.length).toBe(8)
  }
  try {
    validateHdrAsset(asset)
    await writeFile(path, bytes)
    await scan()
    await writeFile(path, bytes.subarray(0, 16))
    await expect(scan()).rejects.toThrow('Incomplete')
    await writeFile(path, Buffer.alloc(32))
    await expect(scan()).rejects.toThrow('Damaged')
    data[0] = NaN
    const corrupt = Buffer.from(data.buffer)
    asset.sha256 = asset.strips[0].sha256 = hash(corrupt)
    await writeFile(path, corrupt)
    await expect(scan()).rejects.toThrow('Invalid HDR pixels')
    expect(() => validateHdrAsset({ ...asset, byteLength: 16 })).toThrow('Invalid')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('HDR upload streams validate fragmented bytes and cancel incomplete or superseded reads', async () => {
  const values = new Float32Array(2 * 130 * 4)
  for (let i = 0; i < values.length; i += 4) values.set([-0.1, 2, 16, 1], i)
  const bytes = Buffer.from(values.buffer)
  const asset = workingAsset(bytes, 2, 130)
  const originalFetch = globalThis.fetch
  let cancelled = 0,
    requests = 0
  const serve = (body: Uint8Array, chunk = 73, keepOpen = false) => {
    globalThis.fetch = async (_url, options) => {
      requests++
      let offset = 0
      const response = new Response(
        new ReadableStream({
          start(controller) {
            options?.signal?.addEventListener(
              'abort',
              () => controller.error(options.signal!.reason),
              { once: true },
            )
          },
          pull(controller) {
            if (offset < body.byteLength) {
              controller.enqueue(body.subarray(offset, offset + chunk))
              offset += chunk
            } else if (!keepOpen) controller.close()
          },
          cancel() {
            cancelled++
          },
        }),
        { headers: { 'Content-Length': String(asset.byteLength) } },
      )
      return response
    }
  }
  const scan = async () => {
    let strips = 0
    for await (const next of readHdrUploadBytes(asset)) {
      const strip = await validateHdrStrip(asset, next.index, next.bytes, next.readMs)
      expect(strip.row).toBe(strips++ * 64)
      expect(strip.data[0]).toBeCloseTo(-0.1)
    }
    return strips
  }
  try {
    serve(bytes)
    expect(await scan()).toBe(3)
    expect(requests).toBe(1)
    serve(bytes.subarray(0, bytes.byteLength - 1))
    await expect(scan()).rejects.toThrow('Incomplete')
    serve(Buffer.concat([bytes, Buffer.from([0])]))
    await expect(scan()).rejects.toThrow('Unexpected')
    const damaged = Buffer.from(bytes)
    damaged[0] ^= 1
    serve(damaged)
    await expect(scan()).rejects.toThrow('Damaged')
    serve(new Uint8Array(1024 * 1024 + 1), 1024 * 1024 + 1)
    await expect(scan()).rejects.toThrow('memory limit')
    serve(bytes, 73, true)
    const reader = readHdrUploadBytes(asset)
    await reader.next()
    const before = cancelled
    await reader.return()
    expect(cancelled).toBe(before + 1)
    const abort = new AbortController()
    const pending = readHdrUploadBytes(asset, abort.signal)
    await pending.next()
    abort.abort(new Error('Superseded'))
    await expect(pending.next()).rejects.toThrow('Superseded')
    values[3] = 2
    const invalid = Buffer.from(values.buffer)
    const invalidAsset = workingAsset(invalid, 2, 130)
    await expect(
      validateHdrStrip(invalidAsset, 0, values.buffer.slice(0, 2 * 64 * 16), 0),
    ).rejects.toThrow('Invalid HDR sample')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('workspace display generations and persistence never certify physical output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-display-state-'))
  try {
    const state = new DisplayState(root, () => {})
    await state.open()
    expect(state.get()).toMatchObject({ requested: 'auto', mode: 'sdr' })
    const hdr = state.report({
      hardware: true,
      extended: true,
      p3: true,
      headroomStops: 2,
      reason: '',
    })
    expect(hdr).toMatchObject({ mode: 'hdr', peak: 4, physicalOutputVerified: false })
    expect(
      state.report({ hardware: true, extended: true, p3: true, headroomStops: 2, reason: '' })
        .generation,
    ).toBe(hdr.generation)
    const sdr = await state.set('sdr')
    expect(sdr.peak).toBe(1)
    expect(sdr.generation).toBeGreaterThan(hdr.generation)
    const restarted = new DisplayState(root, () => {})
    await restarted.open()
    expect(restarted.get().requested).toBe('sdr')
    await state.set('hdr')
    state.invalidate('Device lost')
    expect(state.get()).toMatchObject({ mode: 'sdr', reason: 'Device lost' })
    expect(() =>
      state.report({ hardware: true, extended: true, p3: true, headroomStops: NaN, reason: '' }),
    ).toThrow('Invalid')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function workingAsset(bytes: Buffer, width: number, height: number): HdrWorkingAsset {
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  return {
    kind: 'hdr-working-v1',
    url: 'luma-photo://library/test',
    width,
    height,
    byteLength: bytes.byteLength,
    sha256: hash(bytes),
    strips: Array.from({ length: Math.ceil(height / 64) }, (_, index) => {
      const strip = bytes.subarray(index * width * 64 * 16, (index + 1) * width * 64 * 16)
      return { byteLength: strip.byteLength, sha256: hash(strip) }
    }),
    source: {
      version: 'hdr-source-v1',
      processing: 'hdr-v1',
      colorSpace: 'rec2020',
      whitePoint: 'D65',
      transfer: 'linear',
      alpha: 'straight',
      normalization: {
        black: [800, 800, 800, 800],
        maximum: 15580,
        gains: [2, 1, 1, 1],
        restoreGain: 2,
        referenceWhite: 1,
        sourceSaturation: null,
      },
      decoder: 'test',
      cameraProfile: 'test',
      orientation: 'applied-once',
    },
  }
}
