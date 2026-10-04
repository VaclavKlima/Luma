import { ALIGNMENT_CONSTANTS, type MergeMatrix, type MergeTransform } from '../../shared/merge'

export const identityMatrix = (): MergeMatrix => [1, 0, 0, 0, 1, 0, 0, 0, 1]
export function multiply(a: MergeMatrix, b: MergeMatrix): MergeMatrix {
  return Array.from({ length: 9 }, (_, i) =>
    [0, 1, 2].reduce((v, k) => v + a[Math.floor(i / 3) * 3 + k] * b[k * 3 + (i % 3)], 0),
  ) as MergeMatrix
}
export function inverse(m: MergeMatrix): MergeMatrix {
  const [a, b, c, d, e, f, g, h, i] = m
  const out = [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ]
  const det = a * out[0] + b * out[3] + c * out[6]
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12)
    throw new Error('Singular alignment transform.')
  return out.map((v) => v / det) as MergeMatrix
}
export function point(m: MergeMatrix, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8]
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w]
}
export function tileOffset(t: MergeTransform, x: number, y: number): [number, number] {
  const tiles = t.tiles
  if (!tiles) return [0, 0]
  const px = Math.max(
      0,
      Math.min(tiles.columns - 1, ((x + 0.5) * tiles.columns) / tiles.width - 0.5),
    ),
    py = Math.max(0, Math.min(tiles.rows - 1, ((y + 0.5) * tiles.rows) / tiles.height - 0.5)),
    ix = Math.floor(px),
    iy = Math.floor(py),
    dx = px - ix,
    dy = py - iy
  let ox = 0,
    oy = 0
  for (let yy = 0; yy < 2; yy++)
    for (let xx = 0; xx < 2; xx++) {
      const k =
          (Math.min(tiles.rows - 1, iy + yy) * tiles.columns +
            Math.min(tiles.columns - 1, ix + xx)) *
          2,
        w = (xx ? dx : 1 - dx) * (yy ? dy : 1 - dy)
      ox += tiles.offsets[k] * w
      oy += tiles.offsets[k + 1] * w
    }
  return [ox, oy]
}
export function warpedPoint(
  t: MergeTransform,
  width: number,
  height: number,
  x: number,
  y: number,
): [number, number] {
  const q = point(transformMatrix(t, width, height), x, y)
  if (t.tiles) {
    const delta = tileOffset(t, x, y)
    q[0] += delta[0]
    q[1] += delta[1]
  }
  return q
}
export function transformMatrix(t: MergeTransform, width: number, height: number): MergeMatrix {
  if (t.matrix) return t.matrix
  const c = Math.cos(t.angle),
    s = Math.sin(t.angle),
    x = (width - 1) / 2,
    y = (height - 1) / 2
  return [c, -s, x + t.x - c * x + s * y, s, c, y + t.y - s * x - c * y, 0, 0, 1]
}
/** Pixel centers: native = (reduced + 0.5) * scale - 0.5. */
export function resizeMatrix(m: MergeMatrix, sx: number, sy: number): MergeMatrix {
  const scale: MergeMatrix = [sx, 0, (sx - 1) / 2, 0, sy, (sy - 1) / 2, 0, 0, 1]
  return multiply(multiply(scale, m), inverse(scale))
}
export function resizedTransform(
  t: MergeTransform,
  width: number,
  height: number,
  nextWidth: number,
  nextHeight: number,
): MergeTransform {
  return {
    ...t,
    x: (t.x * nextWidth) / width,
    y: (t.y * nextHeight) / height,
    matrix: resizeMatrix(transformMatrix(t, width, height), nextWidth / width, nextHeight / height),
    tiles: t.tiles
      ? {
          ...t.tiles,
          width: nextWidth,
          height: nextHeight,
          offsets: t.tiles.offsets.map(
            (v, i) => v * (i % 2 ? nextHeight / height : nextWidth / width),
          ),
        }
      : undefined,
  }
}
/** Validate the projective denominator and local Jacobian across the entire image. */
export function validateGeometry(m: MergeMatrix, width: number, height: number): void {
  if (m.length !== 9 || !m.every(Number.isFinite)) throw new Error('Invalid alignment matrix.')
  inverse(m)
  const center = point(m, (width - 1) / 2, (height - 1) / 2)
  if (
    Math.abs(center[0] - (width - 1) / 2) > width * 0.1 ||
    Math.abs(center[1] - (height - 1) / 2) > height * 0.1
  )
    throw new Error('Alignment exceeds the 10% translation envelope.')
  const sign = Math.sign(m[8])
  for (let gy = 0; gy <= 4; gy++)
    for (let gx = 0; gx <= 4; gx++) {
      const x = (gx * (width - 1)) / 4,
        y = (gy * (height - 1)) / 4,
        w = m[6] * x + m[7] * y + m[8],
        p = point(m, x, y)
      if (w * sign < 1e-5) throw new Error('Folded alignment transform.')
      const a = (m[0] - p[0] * m[6]) / w,
        b = (m[1] - p[0] * m[7]) / w,
        c = (m[3] - p[1] * m[6]) / w,
        d = (m[4] - p[1] * m[7]) / w
      const det = a * d - b * c,
        sum = a * a + b * b + c * c + d * d,
        delta = Math.sqrt(Math.max(0, sum * sum - 4 * det * det))
      const low = Math.sqrt((sum - delta) / 2),
        high = Math.sqrt((sum + delta) / 2)
      if (det <= 0 || low < 0.9 || high > 1.1)
        throw new Error('Alignment local scale exceeds 0.9–1.1.')
      if (Math.abs(Math.atan2(c - b, a + d)) > Math.PI / 36)
        throw new Error('Alignment exceeds the 5° rotation envelope.')
    }
}
export function validateTransform(t: MergeTransform, width: number, height: number) {
  validateGeometry(transformMatrix(t, width, height), width, height)
  const tiles = t.tiles
  if (!tiles) return
  if (
    !Number.isInteger(tiles.columns) ||
    tiles.columns < 2 ||
    tiles.columns > 32 ||
    tiles.rows !== tiles.columns ||
    tiles.width !== width ||
    tiles.height !== height ||
    tiles.offsets.length !== tiles.columns * tiles.rows * 2 ||
    !tiles.offsets.every(
      (v) =>
        Number.isFinite(v) && Math.abs(v) <= ALIGNMENT_CONSTANTS.maximumTileOffsetPixels + 1e-6,
    )
  )
    throw new Error('Invalid native tile warp.')
  for (let gy = 0; gy <= 4; gy++)
    for (let gx = 0; gx <= 4; gx++) {
      const x = (gx * (width - 1)) / 4,
        y = (gy * (height - 1)) / 4,
        q = warpedPoint(t, width, height, x, y),
        px = warpedPoint(t, width, height, x + 1, y),
        py = warpedPoint(t, width, height, x, y + 1),
        a = px[0] - q[0],
        b = py[0] - q[0],
        c = px[1] - q[1],
        d = py[1] - q[1],
        det = a * d - b * c,
        sum = a * a + b * b + c * c + d * d,
        delta = Math.sqrt(Math.max(0, sum * sum - 4 * det * det))
      if (
        det <= 0 ||
        Math.sqrt((sum - delta) / 2) < 0.9 ||
        Math.sqrt((sum + delta) / 2) > 1.1 ||
        Math.abs(Math.atan2(c - b, a + d)) > Math.PI / 36
      )
        throw new Error('Native tile warp exceeds the geometry envelope.')
    }
}
