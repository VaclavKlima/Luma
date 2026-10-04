import {
  ALIGNMENT_CONSTANTS,
  MergeError,
  type AlignmentDiagnostics,
  type MergeTransform,
} from '../../shared/merge'
import { median, sample, type Plane } from './math'
import { identityMatrix, point, resizeMatrix, validateGeometry } from './matrix'
import { openCv } from './opencv'

export { ALIGNMENT_CONSTANTS } from '../../shared/merge'
const normalized = new WeakMap<Plane, Plane>(),
  pyramids = new WeakMap<Plane, Plane[]>()
export function normalizedPlane(p: Plane): Plane {
  const cached = normalized.get(p)
  if (cached) return cached
  const values: number[] = []
  for (let i = 0; i < p.data.length; i += 3)
    if ((!p.mask || p.mask[i]) && p.data[i] > 0.004) values.push(p.data[i])
  const scale = values.length ? median(values) : 1
  const data = new Float32Array(p.data.length),
    mask = new Uint8Array(p.data.length)
  for (let i = 0; i < data.length; i++) {
    const v = p.data[i]
    data[i] = Math.sqrt(Math.max(0, v) / scale) / 3
    mask[i] = (!p.mask || p.mask[i]) && v > 0.004 ? 255 : 0
  }
  const result = { width: p.width, height: p.height, data, mask }
  normalized.set(p, result)
  return result
}
export function reducePlane(p: Plane): Plane {
  const width = Math.floor(p.width / 2),
    height = Math.floor(p.height / 2),
    data = new Float32Array(width * height),
    mask = new Uint8Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const indices = [
        y * 2 * p.width + x * 2,
        y * 2 * p.width + x * 2 + 1,
        (y * 2 + 1) * p.width + x * 2,
        (y * 2 + 1) * p.width + x * 2 + 1,
      ]
      if (indices.every((i) => !p.mask || p.mask[i])) {
        data[y * width + x] = indices.reduce((v, i) => v + p.data[i], 0) / 4
        mask[y * width + x] = 255
      }
    }
  return { width, height, data, mask }
}
function cells(points: number[][], width: number, height: number): number {
  return new Set(
    points.map(
      (p) =>
        Math.min(3, Math.floor((p[0] * 4) / width)) +
        4 * Math.min(3, Math.floor((p[1] * 4) / height)),
    ),
  ).size
}
export function alignmentFailure(message: string, diagnostics: AlignmentDiagnostics[] = []): never {
  throw new MergeError({ code: 'alignment', message, filenames: [], diagnostics })
}
/** Independent candidates; the caller validates native patches before preferring similarity. */
export async function registrationCandidates(
  reference: Plane,
  source: Plane,
  projectiveOnly?: boolean,
  coarseOnly = false,
): Promise<MergeTransform[]> {
  const start = performance.now(),
    cv = await openCv(),
    a = normalizedPlane(reference),
    b = normalizedPlane(source)
  const matches = cv.matches(a, b),
    candidates: MergeTransform[] = []
  for (const projective of projectiveOnly === undefined ? [false, true] : [projectiveOnly]) {
    const fit = cv.fit(matches, projective, ALIGNMENT_CONSTANTS.ransacPixels)
    const support = fit ? matches.filter((_, i) => fit.inliers[i]) : []
    const diagnostics: AlignmentDiagnostics = {
      algorithm: ALIGNMENT_CONSTANTS.version,
      model: projective ? 'projective' : 'similarity',
      matches: matches.length,
      inliers: support.length,
      cells: cells(support, a.width, a.height),
      nativePatches: [],
      movingRegions: [],
      runtimeMs: 0,
      wasmMemoryBytes: cv.memory(),
    }
    if (!fit || support.length < 30 || diagnostics.cells < 6) continue
    let matrix = fit.matrix,
      correlation = 0
    try {
      validateGeometry(matrix, a.width, a.height)
    } catch {
      continue
    }
    // ORB outliers spatially identify moving content; intensity residuals then
    // exclude changing pixels in both template and source before each ECC pass.
    const pyramid = (p: Plane) => {
      let levels = pyramids.get(p)
      if (!levels) {
        levels = [p]
        while (levels.at(-1)!.width > 320 && levels.at(-1)!.height > 240)
          levels.push(reducePlane(levels.at(-1)!))
        pyramids.set(p, levels)
      }
      return levels
    }
    const ap = pyramid(a),
      bp = pyramid(b)
    for (let level = ap.length - 1; level >= 0; level--) {
      if (coarseOnly && level < ap.length - 1) break
      const aa = ap[level],
        bb = bp[level]
      let local = resizeMatrix(matrix, aa.width / a.width, aa.height / a.height)
      for (let iteration = 0; iteration < 3; iteration++) {
        const mask = new Uint8Array(aa.mask!),
          residuals: number[] = []
        for (let y = 0; y < aa.height; y += 3)
          for (let x = 0; x < aa.width; x += 3) {
            const [sx, sy] = point(local, x, y),
              v = sample(bb, sx, sy),
              i = y * aa.width + x
            if (mask[i] && Number.isFinite(v)) residuals.push(Math.abs(aa.data[i] - v))
          }
        const threshold = Math.max(0.06, (residuals.length ? median(residuals) : 1) * 5)
        for (let y = 0; y < aa.height; y++)
          for (let x = 0; x < aa.width; x++) {
            const [sx, sy] = point(local, x, y),
              v = sample(bb, sx, sy),
              i = y * aa.width + x
            if (!Number.isFinite(v) || Math.abs(aa.data[i] - v) > threshold) mask[i] = 0
          }
        const refined = cv.ecc({ ...aa, mask }, bb, local, projective ? 3 : 2, coarseOnly ? 20 : 60)
        if (refined.correlation < 0) break
        let next = refined.matrix
        if (!projective) {
          // Project affine ECC onto the four-parameter similarity family.
          const c = (next[0] + next[4]) / 2,
            s = (next[3] - next[1]) / 2
          next = [c, -s, next[2], s, c, next[5], 0, 0, 1]
        }
        try {
          validateGeometry(next, aa.width, aa.height)
        } catch {
          break
        }
        local = next
        correlation = refined.correlation
      }
      matrix = resizeMatrix(local, a.width / aa.width, a.height / aa.height)
    }
    diagnostics.runtimeMs = performance.now() - start
    diagnostics.wasmMemoryBytes = cv.memory()
    candidates.push({ x: 0, y: 0, angle: 0, correlation, matrix, diagnostics })
  }
  if (!candidates.length)
    alignmentFailure(
      'Low-confidence alignment: fewer than 30 consistent features spanning six grid cells. More texture or usable exposure overlap is required.',
    )
  return candidates
}
export function identityTransform(): MergeTransform {
  return { x: 0, y: 0, angle: 0, correlation: 1, matrix: identityMatrix() }
}
