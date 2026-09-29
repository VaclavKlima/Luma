import { validateHdrSource, type HdrWorkingAsset } from '../../../shared/hdr'
import { frameByteLength } from '../../../shared/preview-frame'
import { validateWhiteBalanceProfile } from '../../../shared/white-balance'
import { HDR_TRANSPORT_CHUNK_BYTES } from './hdr-memory'

export function validateHdrAsset(asset: HdrWorkingAsset) {
  validateHdrSource(asset?.source)
  if (
    !asset ||
    asset.kind !== 'hdr-working-v1' ||
    !asset.url ||
    asset.source.processing !== 'hdr-v1' ||
    asset.source.colorSpace !== 'rec2020' ||
    asset.source.transfer !== 'linear' ||
    asset.source.alpha !== 'straight' ||
    asset.byteLength !== frameByteLength(asset.width, asset.height) * 4 ||
    asset.byteLength > 512 * 1024 ** 2 ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    asset.strips.length !== Math.ceil(asset.height / 64) ||
    !Number.isFinite(asset.source.normalization.referenceWhite) ||
    asset.source.normalization.referenceWhite <= 0
  )
    throw new Error('Invalid HDR working asset.')
  if (asset.whiteBalance) validateWhiteBalanceProfile(asset.whiteBalance)
}
export async function readHdrStrip(asset: HdrWorkingAsset, index: number, signal?: AbortSignal) {
  const offset = index * asset.width * 64 * 16
  const strip = asset.strips[index]
  const expected = Math.min(asset.width * 64 * 16, asset.byteLength - offset)
  if (!strip || strip.byteLength !== expected || !/^[a-f0-9]{64}$/.test(strip.sha256))
    throw new Error('Invalid HDR strip dimensions.')
  const started = performance.now()
  const response = await fetch(asset.url!, {
    signal,
    cache: 'no-store',
    headers: { Range: `bytes=${offset}-${offset + expected - 1}` },
  })
  if (response.status !== 206 || Number(response.headers.get('content-length')) !== expected)
    throw new Error('Incomplete HDR strip.')
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength !== expected) throw new Error('Incomplete HDR strip.')
  const fetched = performance.now()
  return validateHdrStrip(asset, index, bytes, fetched - started)
}

export async function validateHdrStrip(
  asset: HdrWorkingAsset,
  index: number,
  bytes: ArrayBuffer,
  readMs: number,
) {
  const strip = asset.strips[index]
  if (!strip || bytes.byteLength !== strip.byteLength) throw new Error('Incomplete HDR strip.')
  const fetched = performance.now()
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('')
  if (digest !== strip.sha256) throw new Error('Damaged HDR strip.')
  const hashed = performance.now()
  const data = new Float32Array(bytes)
  for (let i = 0; i < data.length; i += 4) {
    if (
      !Number.isFinite(data[i]) ||
      !Number.isFinite(data[i + 1]) ||
      !Number.isFinite(data[i + 2]) ||
      !Number.isFinite(data[i + 3]) ||
      data[i + 3] < 0 ||
      data[i + 3] > 1
    )
      throw new Error('Invalid HDR sample.')
  }
  return {
    data,
    row: index * 64,
    timings: {
      readMs,
      hashMs: hashed - fetched,
      validateMs: performance.now() - hashed,
    },
  }
}

/** One leased response; callers bound outstanding strips while hashes run concurrently. */
export async function* readHdrUploadBytes(asset: HdrWorkingAsset, signal?: AbortSignal) {
  validateHdrAsset(asset)
  const response = await fetch(asset.url!, { signal, cache: 'no-store' })
  if (
    response.status !== 200 ||
    Number(response.headers.get('content-length')) !== asset.byteLength ||
    !response.body
  ) {
    await response.body?.cancel()
    throw new Error('Incomplete HDR source.')
  }
  const reader = response.body.getReader()
  let pending = new Uint8Array(0),
    offset = 0
  try {
    for (let index = 0; index < asset.strips.length; index++) {
      const started = performance.now()
      const expected = Math.min(
        asset.width * 64 * 16,
        asset.byteLength - index * asset.width * 64 * 16,
      )
      const strip = asset.strips[index]
      if (strip.byteLength !== expected || !/^[a-f0-9]{64}$/.test(strip.sha256))
        throw new Error('Invalid HDR strip dimensions.')
      const bytes = new Uint8Array(expected)
      let filled = 0
      while (filled < expected) {
        if (offset === pending.byteLength) {
          const next = await reader.read()
          if (next.done) throw new Error('Incomplete HDR strip.')
          // Chromium delivers bounded network chunks; refuse an unexpected unbounded response.
          if (next.value.byteLength > HDR_TRANSPORT_CHUNK_BYTES)
            throw new Error('HDR transport chunk exceeds its memory limit.')
          pending = next.value
          offset = 0
        }
        const count = Math.min(expected - filled, pending.byteLength - offset)
        bytes.set(pending.subarray(offset, offset + count), filled)
        filled += count
        offset += count
      }
      yield { index, bytes: bytes.buffer, readMs: performance.now() - started }
    }
    if (offset !== pending.byteLength || !(await reader.read()).done)
      throw new Error('Unexpected HDR source bytes.')
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}
export async function* streamHdr(asset: HdrWorkingAsset, signal?: AbortSignal, onlyStrip?: number) {
  validateHdrAsset(asset)
  for (let index = 0; index < asset.strips.length; index++) {
    if (onlyStrip !== undefined && index !== onlyStrip) continue
    yield await readHdrStrip(asset, index, signal)
  }
}
