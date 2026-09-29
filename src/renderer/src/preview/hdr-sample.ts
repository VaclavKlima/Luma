import type { HdrWorkingAsset } from '../../../shared/hdr'
/** A single active source sample; replacing it releases the previous photograph's data. */
let current: { hash: string; data: Float32Array } | undefined
const listeners = new Set<() => void>()
export function publishHdrSample(hash: string, data: Float32Array) {
  current = { hash, data }
  for (const listener of listeners) listener()
}
export function observeHdrSample(hash: string, accept: (data: Float32Array) => void) {
  const notify = () => {
    if (current?.hash === hash) accept(current.data)
  }
  listeners.add(notify)
  notify()
  return () => {
    listeners.delete(notify)
  }
}
export function collectHdrSample(asset: HdrWorkingAsset) {
  const total = asset.width * asset.height,
    count = Math.min(65536, total)
  const sample = new Float32Array(count * 4)
  let next = 0
  return {
    sample,
    add(data: Float32Array, row: number) {
      const start = row * asset.width,
        end = start + data.length / 4
      while (next < count) {
        const position = Math.floor(((next + 0.5) * total) / count)
        if (position >= end) break
        sample.set(data.subarray((position - start) * 4, (position - start) * 4 + 4), next++ * 4)
      }
    },
  }
}
