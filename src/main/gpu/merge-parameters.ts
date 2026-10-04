import { SRGB_TO_2020 } from '../../shared/hdr'
import type { CorrectionPlan } from '../processing/lens-correction'
import type { RawSource } from './raw-source'

/** Identical fixed sensor-white camera conversion for preparation and native warping. */
export function mergePreparationParameters(
  source: RawSource,
  correction: CorrectionPlan,
  gains: number[],
  reviewWidth = 0,
  reviewHeight = 0,
) {
  const parameters = new ArrayBuffer(144),
    ints = new Uint32Array(parameters),
    values = new Float32Array(parameters)
  ints.set([
    source.width,
    source.height,
    correction.width,
    correction.height,
    correction.left,
    correction.top,
    0,
    0,
    source.rawWidth,
    source.left,
    source.top,
    source.flip,
    ...source.cfa,
  ])
  values.set(source.normalization!.sourceSaturation!.thresholds, 16)
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      values[20 + r * 4 + c] =
        ((((SRGB_TO_2020[r * 3] * source.matrix[c] +
          SRGB_TO_2020[r * 3 + 1] * source.matrix[4 + c] +
          SRGB_TO_2020[r * 3 + 2] * source.matrix[8 + c]) *
          Math.max(...source.normalization!.gains)) /
          source.normalization!.gains[c]) *
          gains[c]) /
        Math.min(...gains)
  ints.set([reviewWidth, reviewHeight, 0, 0], 32)
  return parameters
}
