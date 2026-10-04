import type { PreparedSource } from './prepare'
import { nativePlane, nativeBand } from './native-plane'
import type { MergeTransform } from '../../shared/merge'
import { ALIGNMENT_CONSTANTS, alignmentFailure, identityTransform } from './alignment'
import { identityMatrix, point, validateGeometry } from './matrix'
import { openCv } from './opencv'
const identicalReference = new WeakMap<
  PreparedSource,
  Promise<Awaited<ReturnType<typeof patches>>>
>()

export async function patches(
  reference: PreparedSource,
  source: PreparedSource,
  t: MergeTransform,
  grid: number,
  offset: number,
  checkpoint: () => Promise<void>,
  options: {
    edge?: number
    validFraction?: number
    include?: (x: number, y: number) => boolean
    identical?: boolean
    coarse?: boolean
  } = {},
) {
  const cv = await openCv(),
    results = []
  const edge = Math.min(
    options.edge ?? ALIGNMENT_CONSTANTS.nativePatchEdge,
    Math.floor(Math.min(reference.width, reference.height) / 4),
  )
  for (let gy = 0; gy < grid; gy++) {
    await checkpoint()
    const y = Math.round(((gy + offset) * reference.height) / grid)
    const top = Math.max(0, Math.min(reference.height - edge, y - Math.floor(edge / 2)))
    const ar = await nativeBand(reference, identityTransform(), top, edge, checkpoint),
      br = await nativeBand(source, t, top, edge, checkpoint),
      centers: number[][] = []
    for (let gx = 0; gx < grid; gx++) {
      const x = Math.round(((gx + offset) * reference.width) / grid),
        left = Math.max(0, Math.min(reference.width - edge, x - Math.floor(edge / 2)))
      if (!options.include || options.include(left + (edge - 1) / 2, top + (edge - 1) / 2))
        centers.push([left, top])
    }
    if (centers.length)
      results.push(
        ...cv.patches(
          ar,
          br,
          reference.width,
          reference.height,
          t.matrix!,
          centers,
          edge,
          options.validFraction ?? 0.6,
          t.tiles,
          options.identical,
          options.coarse,
        ),
      )
  }
  return results
}
/** Training and held-out native patches use distinct centers and no downsampled pixels. */
export async function validateGlobalNative(
  reference: PreparedSource,
  source: PreparedSource,
  t: MergeTransform,
  checkpoint: () => Promise<void>,
  fast = false,
): Promise<MergeTransform> {
  const cv = await openCv(),
    start = performance.now(),
    diagnostics = structuredClone(t.diagnostics!)
  let matrix = t.matrix!
  if (
    reference.width === source.width &&
    reference.height === source.height &&
    reference.strips.length === source.strips.length &&
    reference.strips.every((sha, i) => sha === source.strips[i])
  ) {
    let proof = identicalReference.get(reference)
    if (!proof) {
      proof = (async () => {
        await nativePlane(reference, checkpoint)
        return patches(
          reference,
          reference,
          identityTransform(),
          ALIGNMENT_CONSTANTS.validationGrid,
          0.5,
          checkpoint,
          { identical: true },
        )
      })()
      identicalReference.set(reference, proof)
    }
    await nativePlane(source, checkpoint)
    const measured = await proof
    const cells = new Set(
      measured.map(
        (p) =>
          Math.floor((p.x * 4) / reference.width) + 4 * Math.floor((p.y * 4) / reference.height),
      ),
    )
    if (
      measured.length < ALIGNMENT_CONSTANTS.minimumPatches ||
      cells.size < ALIGNMENT_CONSTANTS.minimumCells
    )
      alignmentFailure('Identical native sources lack observable independent patches.', [
        diagnostics,
      ])
    // Whole-strip equality is stronger than estimating a subpixel displacement.
    diagnostics.model = 'identity'
    diagnostics.cells = cells.size
    diagnostics.nativePatches = measured.map((p) => ({
      ...p,
      dx: 0,
      dy: 0,
      correlation: 1,
      accepted: true,
    }))
    diagnostics.runtimeMs += performance.now() - start
    diagnostics.wasmMemoryBytes = cv.memory()
    return { ...identityTransform(), diagnostics }
  }
  // A sparse training check can reject competing scene motions before full
  // global refinement. Successful results still require the independent grid below.
  const preliminary = await patches(reference, source, t, 5, 0.25, checkpoint),
    preliminaryPoints = preliminary.map((p) => [
      p.x,
      p.y,
      ...point(matrix, p.x + p.dx, p.y + p.dy),
    ]),
    preliminaryFit = cv.fit(
      preliminaryPoints,
      diagnostics.model === 'projective',
      ALIGNMENT_CONSTANTS.nativeAccuracy,
    )
  if (
    preliminary.length >= ALIGNMENT_CONSTANTS.minimumPatches &&
    (!preliminaryFit ||
      (fast &&
        preliminaryFit.inliers.filter((v) => !v).length >= 2 &&
        preliminaryFit.inliers.filter(Boolean).length / preliminary.length < 0.9) ||
      preliminaryFit.inliers.filter(Boolean).length / preliminary.length <
        ALIGNMENT_CONSTANTS.minimumPatchAgreement)
  ) {
    diagnostics.nativePatches = preliminary
    alignmentFailure('Competing native scene motions require masked tile registration.', [
      diagnostics,
    ])
  }
  if (fast && preliminaryFit) {
    matrix = preliminaryFit.matrix
    try {
      validateGeometry(matrix, reference.width, reference.height)
    } catch (error) {
      alignmentFailure((error as Error).message, [diagnostics])
    }
  }
  // The fast global path fits independent sparse training observations, then
  // runs the complete held-out native grid. Rejected models enter tile training.
  for (let iteration = 0; iteration < (fast ? 0 : 2); iteration++) {
    const measured = await patches(
      reference,
      source,
      { ...t, matrix },
      ALIGNMENT_CONSTANTS.trainingGrid,
      0.5,
      checkpoint,
      { coarse: true },
    )
    diagnostics.nativePatches = measured
    const points = measured
      .filter((p) => Math.hypot(p.dx, p.dy) < 32)
      .map((p) => [p.x, p.y, ...point(matrix, p.x + p.dx, p.y + p.dy)])
    const fit = cv.fit(points, diagnostics.model === 'projective', iteration === 0 ? 1.5 : 0.65)
    if (!fit || fit.inliers.filter(Boolean).length < 8)
      alignmentFailure('Inconsistent geometric match: too few usable native-resolution patches.', [
        diagnostics,
      ])
    matrix = fit.matrix
    try {
      validateGeometry(matrix, reference.width, reference.height)
    } catch (error) {
      alignmentFailure((error as Error).message, [diagnostics])
    }
  }
  const corners = [
    [0, 0],
    [reference.width - 1, 0],
    [0, reference.height - 1],
    [reference.width - 1, reference.height - 1],
  ]
  if (
    corners.every(([x, y]) => {
      const q = point(matrix, x, y)
      return Math.hypot(q[0] - x, q[1] - y) < 1e-4
    })
  )
    matrix = identityMatrix()
  const measured = await patches(
    reference,
    source,
    { ...t, matrix },
    ALIGNMENT_CONSTANTS.validationGrid,
    0.5,
    checkpoint,
  )
  diagnostics.nativePatches = measured.map((p) => ({
    ...p,
    accepted: Math.hypot(p.dx, p.dy) <= ALIGNMENT_CONSTANTS.nativeAccuracy,
  }))
  const consistent = diagnostics.nativePatches.filter((p) => p.accepted)
  // Failed native checks remain visible; they are never silently relabeled as motion.
  const cells = new Set(
    consistent.map(
      (p) => Math.floor((p.x * 4) / reference.width) + 4 * Math.floor((p.y * 4) / reference.height),
    ),
  )
  diagnostics.runtimeMs += performance.now() - start
  diagnostics.wasmMemoryBytes = cv.memory()
  if (measured.length < 8 || cells.size < 6 || consistent.length / measured.length < 0.7)
    alignmentFailure(
      `Inconsistent geometric match: ${consistent.length}/${measured.length} independent native patches agree within 0.5 pixels. Possible parallax or subject movement.`,
      [diagnostics],
    )
  diagnostics.movingRegions = measured
    .filter((p) => Math.hypot(p.dx, p.dy) > 1.5)
    .map((p) => ({
      left: Math.max(0, p.x - 80),
      top: Math.max(0, p.y - 80),
      width: 160,
      height: 160,
    }))
  return { ...t, matrix, diagnostics }
}
