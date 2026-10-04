import { registrationCandidates } from './alignment'
import { validateGlobalNative } from './native-alignment'
import { motionMeasurements, validateMotionNative } from './motion-alignment'
import { multiply, resizedTransform, validateGeometry } from './matrix'
import {
  MergeError,
  mergeFailure,
  type MergeFailure,
  type MergeTransform,
} from '../../shared/merge'
import type { PreparedSource } from './prepare'
import { ALIGNMENT_CONSTANTS } from '../../shared/merge'
import { identityTransform } from './alignment'

/** Similarity first; projective work is deferred until native evidence requires it. */
export async function registerNative(
  reference: PreparedSource,
  neighbor: PreparedSource,
  source: PreparedSource,
  neighborTransform: MergeTransform,
  checkpoint: () => Promise<void>,
) {
  const failures: MergeFailure[] = [],
    motionCandidates: MergeTransform[] = [],
    timings = { matching: 0, nativeValidation: 0 }
  if (
    reference.width === source.width &&
    reference.height === source.height &&
    reference.strips.length === source.strips.length &&
    reference.strips.every((sha, i) => sha === source.strips[i])
  ) {
    const start = performance.now(),
      transform = await validateGlobalNative(
        reference,
        source,
        {
          ...identityTransform(),
          diagnostics: {
            algorithm: ALIGNMENT_CONSTANTS.version,
            model: 'identity',
            matches: 0,
            inliers: 0,
            cells: 0,
            nativePatches: [],
            movingRegions: [],
            runtimeMs: 0,
            wasmMemoryBytes: 0,
          },
        },
        checkpoint,
      )
    timings.nativeValidation = performance.now() - start
    return { transform, timings }
  }
  for (const projective of [false, true]) {
    await checkpoint()
    let candidate: MergeTransform
    const start = performance.now()
    try {
      candidate = (await registrationCandidates(neighbor.plane, source.plane, projective, true))[0]
    } catch (error) {
      failures.push(mergeFailure(error))
      continue
    } finally {
      timings.matching += performance.now() - start
    }
    const native = resizedTransform(
      candidate,
      neighbor.plane.width,
      neighbor.plane.height,
      reference.width,
      reference.height,
    )
    native.matrix = multiply(native.matrix!, neighborTransform.matrix!)
    try {
      validateGeometry(native.matrix, reference.width, reference.height)
    } catch (error) {
      failures.push(mergeFailure(error))
      continue
    }
    const validation = performance.now()
    try {
      const result = await validateGlobalNative(reference, source, native, checkpoint, true)
      return { transform: result, timings }
    } catch (error) {
      failures.push(mergeFailure(error))
    } finally {
      timings.nativeValidation += performance.now() - validation
    }
    motionCandidates.unshift(native)
  }
  // A failed global similarity needs projective evidence before spending native
  // work on competing subject/camera motions. Keep similarity as a validated fallback.
  if (motionCandidates.length) {
    const start = performance.now()
    try {
      // Similarity seeds immutable measurements once; projective refinement
      // consumes the same absolute observations without re-registering tiles.
      await motionMeasurements(reference, source, motionCandidates.at(-1)!, checkpoint)
    } catch (error) {
      failures.push(mergeFailure(error))
    } finally {
      timings.nativeValidation += performance.now() - start
    }
  }
  for (const native of motionCandidates) {
    const motion = performance.now()
    try {
      return {
        transform: await validateMotionNative(reference, source, native, checkpoint),
        timings,
      }
    } catch (error) {
      failures.push(mergeFailure(error))
    } finally {
      timings.nativeValidation += performance.now() - motion
    }
  }
  throw Object.assign(
    new MergeError({
      code: 'alignment',
      message: failures.at(-1)?.message ?? 'No validated registration path.',
      filenames: [],
      diagnostics: failures.flatMap((f) => f.diagnostics),
    }),
    { timings },
  )
}
