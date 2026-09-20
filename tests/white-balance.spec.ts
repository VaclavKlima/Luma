import { expect, test } from '@playwright/test'
import {
  asShot,
  customGains,
  estimateWhiteBalance,
  identityMatrix,
  illuminant,
  inverseMatrix,
  locusUv,
  validateWhiteBalanceProfile,
  WHITE_BALANCE_MODEL,
  whiteBalanceMatrix,
  type WhiteBalanceProfile,
} from '../src/shared/white-balance'
import { neutralAdjustments, renderAdjustments, srgbTransform } from '../src/shared/adjustments'
import { validatePatch } from '../src/shared/edits'
import { resolveWhiteBalance } from '../src/main/processing/white-balance'
const profile: WhiteBalanceProfile = {
  provider: 'synthetic',
  version: '1',
  identity: 'synthetic-1',
  model: WHITE_BALANCE_MODEL,
  asShotGains: [2, 1, 1.5],
  xyzToCamera: [0.7, 0.2, 0.1, 0.1, 0.8, 0.1, 0.1, 0.1, 0.8],
  cameraToWorking: [1.4, -0.3, -0.1, -0.1, 1.2, -0.1, 0, -0.1, 1.1],
  ranges: { kelvin: [2000, 25000], tint: [-100, 100] },
  estimate: { kelvin: 6500, tint: 0 },
}
test('white balance follows Kang reference, green illuminant tint and positive green-normalized gains', () => {
  const xyz = illuminant(6504.38938305, 0),
    sum = xyz.reduce((a, b) => a + b, 0)
  expect(xyz[0] / sum).toBeCloseTo(0.313426, 5)
  expect(xyz[1] / sum).toBeCloseTo(0.3235959, 5)
  const gains = customGains(profile, 6500, 100),
    neutral = customGains(profile, 6500, 0)
  expect(gains[0] + gains[2]).toBeGreaterThan(neutral[0] + neutral[2])
  expect(customGains(profile, 2000, 0)[0]).toBeLessThan(customGains(profile, 25000, 0)[0])
  for (const kelvin of [2000, 4000, 6500, 25000])
    for (const tint of [-100, 0, 100]) {
      const gains = customGains(profile, kelvin, tint)
      expect(gains.every((v) => v > 0 && Number.isFinite(v))).toBe(true)
      expect(gains[1]).toBe(1)
    }
  expect(locusUv(6500).every(Number.isFinite)).toBe(true)
})
test('As Shot bypass is byte exact, signed channels transform before clamping and alpha is preserved', () => {
  const data = new Float32Array([-0.1, 0.4, 1.4, 0.5, 0.2, 0.8, 0.1, 0])
  const transform = { ...srgbTransform, whiteBalance: profile }
  expect(whiteBalanceMatrix(asShot, profile)).toBeNull()
  expect(
    renderAdjustments(data, { ...neutralAdjustments, whiteBalance: asShot }, transform),
  ).toEqual(renderAdjustments(data, neutralAdjustments, srgbTransform))
  const parameters = {
    ...neutralAdjustments,
    whiteBalance: { mode: 'custom' as const, kelvin: 8000, tint: 40 },
  }
  const matrix = whiteBalanceMatrix(parameters.whiteBalance, profile)!
  const manual = new Float32Array(data)
  for (let i = 0; i < data.length; i += 4)
    for (let r = 0; r < 3; r++)
      manual[i + r] =
        matrix[r * 3] * data[i] + matrix[r * 3 + 1] * data[i + 1] + matrix[r * 3 + 2] * data[i + 2]
  const output = renderAdjustments(data, parameters, transform),
    reference = renderAdjustments(manual, neutralAdjustments, srgbTransform)
  expect([...output].every((v, i) => Math.abs(v - reference[i]) <= 1)).toBe(true)
  expect(output[3]).toBe(128)
  expect(output[7]).toBe(0)
})
test('invalid edits, matrices and gains fail; providers are modular and unknown cameras unavailable', () => {
  for (const whiteBalance of [
    null,
    { mode: 'auto' },
    { mode: 'as-shot', tint: 0 },
    { mode: 'custom', kelvin: 6501, tint: 0 },
    { mode: 'custom', kelvin: 6500, tint: 101 },
  ])
    expect(() => validatePatch({ whiteBalance })).toThrow()
  expect(() => inverseMatrix(Array(9).fill(0))).toThrow()
  expect(() => validateWhiteBalanceProfile({ ...profile, asShotGains: [0, 1, 1] })).toThrow()
  expect(() => whiteBalanceMatrix({ mode: 'custom', kelvin: 6500, tint: 0 })).toThrow('unavailable')
  const metadata = {
    make: 'Second',
    model: 'Test',
    rawWidth: 2,
    rawHeight: 2,
    left: 0,
    top: 0,
    colors: 3,
    cfa: [0, 1, 3, 2],
  }
  expect(resolveWhiteBalance(metadata)).toBeUndefined()
  expect(
    resolveWhiteBalance(metadata, [{ id: 'second', version: '1', resolve: () => profile }]),
  ).toBe(profile)
  expect(inverseMatrix(identityMatrix)).toEqual(identityMatrix)
  const estimated = estimateWhiteBalance({
    ...profile,
    asShotGains: customGains(profile, 6500, 20),
  })
  expect(estimated.kelvin).toBe(6500)
  expect(estimated.tint).toBe(20)
})
