import { areaContributions } from './area'
import { createHash } from 'node:crypto'
import { open, writeFile } from 'node:fs/promises'
import type { PreparedSource } from './prepare'
import { noteMergeRead } from './sampling'

/** Area reduction of decoded linear data; no camera JPEG enters merge review. */
export async function reducedSource(
  source: PreparedSource,
  written: (bytes: number) => void = () => {},
): Promise<PreparedSource> {
  const { width, height } = source.plane
  if (width === source.width && height === source.height) return source
  if (source.review)
    return { ...source, path: source.review.path, width, height, strips: source.review.strips }
  const data = new Float32Array(width * height * 4),
    counts = new Float64Array(width * height)
  for (let i = 3; i < data.length; i += 4) data[i] = 1
  const xs = areaContributions(source.width, width),
    ys = areaContributions(source.height, height)
  const file = await open(source.path, 'r')
  try {
    for (let top = 0; top < source.height; top += 64) {
      const rows = Math.min(64, source.height - top),
        bytes = Buffer.alloc(source.width * rows * 16)
      const read = await file.read(bytes, 0, bytes.length, top * source.width * 16)
      noteMergeRead(read.bytesRead)
      if (
        read.bytesRead !== bytes.length ||
        createHash('sha256').update(bytes).digest('hex') !== source.strips[top / 64]
      )
        throw new Error('Damaged merge source strip.')
      const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < source.width; x++) {
          const i = (y * source.width + x) * 4
          for (const [px, wx] of xs[x])
            for (const [py, wy] of ys[top + y]) {
              const p = py * width + px,
                weight = wx * wy
              for (let c = 0; c < 3; c++) data[p * 4 + c] += floats[i + c] * weight
              if (floats[i + 3] === 0) data[p * 4 + 3] = 0
              counts[p] += weight
            }
        }
    }
  } finally {
    await file.close()
  }
  for (let p = 0; p < counts.length; p++) for (let c = 0; c < 3; c++) data[p * 4 + c] /= counts[p]
  const path = source.path.replace(/\.f32$/, '-review.f32'),
    bytes = Buffer.from(data.buffer),
    strips: string[] = []
  await writeFile(path, bytes)
  written(bytes.length)
  for (let top = 0; top < height; top += 64)
    strips.push(
      createHash('sha256')
        .update(bytes.subarray(top * width * 16, Math.min(bytes.length, (top + 64) * width * 16)))
        .digest('hex'),
    )
  source.review = { path, strips }
  return { ...source, path, width, height, strips }
}
