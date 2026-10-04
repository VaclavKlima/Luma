import type { MergeTransform } from '../../shared/merge'

/** Exact center membership for exposure validation, before conservative dilation. */
export function excludedCenters(
  transform: MergeTransform,
  width: number,
  height: number,
  nativeWidth: number,
  nativeHeight: number,
) {
  const result = new Uint8Array(width * height),
    xs = Float64Array.from({ length: width }, (_, x) => ((x + 0.5) * nativeWidth) / width - 0.5),
    ys = Float64Array.from({ length: height }, (_, y) => ((y + 0.5) * nativeHeight) / height - 0.5)
  const lower = (coordinates: Float64Array, value: number) => {
    let lo = 0,
      hi = coordinates.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (coordinates[mid] < value) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  for (const box of transform.diagnostics?.movingRegions ?? []) {
    const left = lower(xs, box.left),
      right = lower(xs, box.left + box.width),
      first = lower(ys, box.top),
      last = lower(ys, box.top + box.height)
    for (let y = first; y < last; y++) result.fill(1, y * width + left, y * width + right)
  }
  return result
}

/** Registration uncertainty excludes only its source, in frozen reference coordinates. */
export function excludedBand(
  transform: MergeTransform,
  width: number,
  height: number,
  nativeWidth: number,
  nativeHeight: number,
  top: number,
  rows: number,
) {
  const result = new Uint8Array(width * rows),
    sx = width / nativeWidth,
    sy = height / nativeHeight
  for (const box of transform.diagnostics?.movingRegions ?? []) {
    const left = Math.max(0, Math.floor(box.left * sx)),
      right = Math.min(width, Math.ceil((box.left + box.width) * sx)),
      first = Math.max(top, Math.floor(box.top * sy)),
      last = Math.min(top + rows, Math.ceil((box.top + box.height) * sy))
    for (let y = first; y < last; y++)
      result.fill(1, (y - top) * width + left, (y - top) * width + right)
  }
  return result
}
