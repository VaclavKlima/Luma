import { test, expect } from '@playwright/test'
import {
  coverage,
  warp,
  motionDifferent,
  noiseVariance,
  sample,
  median,
} from '../src/main/merge/math'
import { registrationCandidates, reducePlane } from '../src/main/merge/alignment'
import {
  inverse,
  point,
  resizeMatrix,
  transformMatrix,
  validateGeometry,
} from '../src/main/merge/matrix'
import { mergeUnavailable, validateMergeSettings, type MergeMatrix } from '../src/shared/merge'
import { excludedCenters } from '../src/main/merge/exclusions'
import { identityTransform } from '../src/main/merge/alignment'
import { ALIGNMENT_CONSTANTS } from '../src/shared/merge'

function scene(width = 640, height = 480) {
  // Fixed random multiscale texture, independently bilinearly sampled below.
  let seed = 19281
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const data = new Float32Array(width * height).fill(0.12)
  for (let k = 0; k < 2200; k++) {
    const x = Math.floor(random() * width),
      y = Math.floor(random() * height),
      r = 2 + Math.floor(random() * 9),
      v = random() * 0.5
    for (let j = Math.max(0, y - r); j < Math.min(height, y + r); j++)
      for (let i = Math.max(0, x - r); i < Math.min(width, x + r); i++)
        data[j * width + i] = v + 0.08
  }
  return { width, height, data, mask: new Uint8Array(width * height).fill(255) }
}

test('exposure median selection matches the sorted upper median for uneven and repeated samples', () => {
  let seed = 7341
  for (const count of [1, 2, 3, 17, 256, 8191, 8192]) {
    const random = Array.from({ length: count }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return (seed % 2000) / 8192
    })
    for (const values of [
      random,
      [...random].sort((a, b) => a - b),
      [...random].sort((a, b) => b - a),
      random.map((v) => Math.round(v * 10)),
    ])
      expect(median([...values])).toBe([...values].sort((a, b) => a - b)[Math.floor(count / 2)])
  }
})

test('exposure exclusions preserve exact native pixel-center membership at reduced sizes', () => {
  const width = 49,
    height = 37,
    nativeWidth = 5496,
    nativeHeight = 3672,
    boxes = [
      { left: 0, top: 0, width: 270, height: 200 },
      { left: 1670, top: 1143, width: 412, height: 490 },
      { left: (25.5 * nativeWidth) / width - 0.5, top: 0, width: 540, height: nativeHeight },
    ],
    transform = {
      ...identityTransform(),
      diagnostics: {
        algorithm: ALIGNMENT_CONSTANTS.version,
        model: 'identity' as const,
        matches: 0,
        inliers: 0,
        cells: 0,
        nativePatches: [],
        movingRegions: boxes,
        runtimeMs: 0,
        wasmMemoryBytes: 0,
      },
    },
    excluded = excludedCenters(transform, width, height, nativeWidth, nativeHeight)
  const expected = new Uint8Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const nx = ((x + 0.5) * nativeWidth) / width - 0.5,
        ny = ((y + 0.5) * nativeHeight) / height - 0.5
      expected[y * width + x] = Number(
        boxes.some(
          (b) => nx >= b.left && nx < b.left + b.width && ny >= b.top && ny < b.top + b.height,
        ),
      )
    }
  expect(excluded).toEqual(expected)
})

test('merge bounds, projective geometry and shared coverage reject invalid input', () => {
  expect(mergeUnavailable(1)).toContain('at least two')
  expect(mergeUnavailable(33)).toContain('32')
  expect(() => validateMergeSettings({} as never, [])).toThrow('Invalid')
  const identity = { x: 0, y: 0, angle: 0, correlation: 1 }
  expect(coverage(20, 12, [identity]).crop).toEqual({ left: 0, top: 0, width: 20, height: 12 })
  expect(coverage(20, 12, [identity, { ...identity, x: 2 }]).crop).toEqual({
    left: 0,
    top: 0,
    width: 18,
    height: 12,
  })
  expect(() => coverage(20, 12, [identity, { ...identity, x: 10 }])).toThrow('70%')
  for (const m of [
    [1, 0, 0, 0, 1, 0, -0.01, 0, 1],
    [0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1.2, 0, 0, 0, 1.2, 0, 0, 0, 1],
  ])
    expect(() => validateGeometry(m as MergeMatrix, 640, 480)).toThrow()
})
test('ORB and masked ECC resolve rotation, translation, perspective, exposure and moving foreground', async () => {
  const reference = scene(),
    { width, height } = reference
  for (const expected of [
    transformMatrix({ x: 3.2, y: -2.4, angle: 0.04, correlation: 1 }, width, height),
    transformMatrix({ x: -30, y: 15, angle: -0.07, correlation: 1 }, width, height),
    [1.015, 0.012, 5, -0.009, 1.01, -4, 0.00002, -0.000014, 1] as MergeMatrix,
  ]) {
    const inv = inverse(expected),
      source = scene()
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const [sx, sy] = point(inv, x, y),
          v = sample(reference, sx, sy),
          i = y * width + x
        source.data[i] = Number.isFinite(v) ? v * 1.4 : 0
        source.mask[i] = Number.isFinite(v) ? 255 : 0
        if (x > 280 && x < 340 && y > 190 && y < 300) source.data[i] = 0.85
      }
    const candidates = await registrationCandidates(reference, source)
    const errors = candidates.map((actual) => {
      const values: number[] = []
      for (let y = 20; y < height - 20; y += 30)
        for (let x = 20; x < width - 20; x += 30) {
          const a = warp(x, y, width, height, actual),
            b = point(expected, x, y)
          values.push(Math.hypot(a[0] - b[0], a[1] - b[1]))
        }
      values.sort((a, b) => a - b)
      return values[Math.floor(values.length * 0.95)]
    })
    expect(Math.min(...errors)).toBeLessThanOrEqual(0.5)
  }
})
test('invalid samples cannot enter reduction or interpolation', () => {
  const p = {
    width: 4,
    height: 4,
    data: new Float32Array(16).fill(0.2),
    mask: new Uint8Array(16).fill(255),
  }
  p.mask[0] = 0
  p.data[0] = 100
  const reduced = reducePlane(p)
  expect(reduced.mask![0]).toBe(0)
  expect(reduced.data[0]).toBe(0)
  expect(sample(p, 0.5, 0.5)).toBeNaN()
})
test('pixel-center matrix conversion is equivalent at preview and native resolutions', () => {
  const m: MergeMatrix = [1, 0.012, 3, -0.009, 1, -2, 0.00001, -0.000014, 1],
    sx = 5.367,
    sy = 5.371
  const n = resizeMatrix(m, sx, sy)
  for (const [x, y] of [
    [0, 0],
    [120, 350],
    [639, 479],
  ]) {
    const a = point(m, x, y),
      b = point(n, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5)
    expect(b[0]).toBeCloseTo((a[0] + 0.5) * sx - 0.5, 8)
    expect(b[1]).toBeCloseTo((a[1] + 0.5) * sy - 0.5, 8)
  }
})
test('registration rejects inadequate texture and deghost sensitivity does not blend', async () => {
  const plane = { width: 128, height: 96, data: new Float32Array(128 * 96).fill(0.5) }
  await expect(registrationCandidates(plane, plane)).rejects.toThrow('confidence')
  expect(motionDifferent(0.1, 0.8, noiseVariance(0.1, 1), 0)).toBe(false)
  expect(motionDifferent(0.1, 0.8, noiseVariance(0.1, 1), 50)).toBe(true)
})
