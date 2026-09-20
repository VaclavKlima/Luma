import { expect, test } from '@playwright/test'
import { cameraProfile } from '../src/main/processing/cameras'
import type {
  CameraProfile,
  LensCorrectionProvider,
  LinearFrame,
} from '../src/main/processing/contracts'
import {
  correctCpu,
  correctionPlan,
  interpolate,
  radial,
} from '../src/main/processing/lens-correction'
import { processingMetadata } from '../src/main/processing/metadata'
import { automaticLensSettings, noLensSettings, type LensProfile } from '../src/shared/lens'

const tags = {
  'IFD0:Make': 'SONY',
  'IFD0:Model': 'ZV-1A',
  'SubIFD:DistortionCorrParams': '3 100 0 -100',
  'SubIFD:VignettingCorrParams': '4 0 100 200 300',
  'SubIFD:ChromaticAberrationCorrParams': '6 0 128 256 0 -128 -256',
  'Sony:DistortionCorrParams': '0 0 0',
}
test('Sony tables are independent, group-qualified and strictly validated', () => {
  const profile = processingMetadata(tags).lensProfile
  expect(profile.distortion?.values).toHaveLength(3)
  expect(profile.vignetting?.values).toHaveLength(4)
  expect(profile.chromaticAberration?.red.values).toHaveLength(3)
  expect(profile.unavailable).toEqual({})
  expect(interpolate(profile.distortion, 0)).toBeCloseTo(1 + 100 / 16384)
  for (const value of [
    undefined,
    '3 1 NaN 2',
    '3 1 2',
    '3 1 2 3 7',
    '3 0 0 65535',
    '3 0 -32000 0',
  ]) {
    const invalid = processingMetadata({
      ...tags,
      'SubIFD:DistortionCorrParams': value,
    }).lensProfile
    expect(invalid.distortion).toBeUndefined()
    expect(invalid.vignetting).toBeDefined()
    expect(invalid.chromaticAberration).toBeDefined()
    expect(invalid.identity).not.toBe(profile.identity)
  }
  const invalid = processingMetadata({
    ...tags,
    'SubIFD:ChromaticAberrationCorrParams': '5 0 0 0 0 0',
  }).lensProfile
  expect(invalid.chromaticAberration).toBeUndefined()
  expect(invalid.distortion).toBeDefined()
})

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]
const constant = (value: number) => ({ radii: [0, 1], values: [value, value] })
function synthetic(width = 96, height = 64): LinearFrame {
  const data = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data.set(
        [0.1 + (x / width) * 0.4, 0.1 + (x / width) * 0.4, 0.1 + (x / width) * 0.4, 1],
        (y * width + x) * 4,
      )
  return { data, width, height, flip: 0, matrix: identity }
}
const profile: LensProfile = {
  provider: 'synthetic',
  version: '1',
  label: 'Test calibration',
  identity: 'test-1',
  unavailable: {},
  distortion: constant(1.1),
  vignetting: constant(1.3),
  chromaticAberration: { red: constant(1.02), blue: constant(0.98) },
}

test('vignetting flattens a synthetic falloff and color-fringe mapping aligns shifted channels', () => {
  const frame = synthetic(120, 80)
  const vignette: LensProfile = { ...profile, vignetting: { radii: [0, 1], values: [1, 2] } }
  const settings = { ...noLensSettings, vignetting: true }
  const plan = correctionPlan(frame.width, frame.height, vignette, settings)
  const cx = (frame.width - 1) / 2,
    cy = (frame.height - 1) / 2
  for (let y = 0; y < frame.height; y++)
    for (let x = 0; x < frame.width; x++) {
      const gain = radial(plan.lut, Math.hypot(x - cx, y - cy) / Math.hypot(cx, cy), 3)
      for (let c = 0; c < 3; c++) frame.data[(y * frame.width + x) * 4 + c] = 0.3 / gain
    }
  const corrected = correctCpu(frame, plan)
  const channel = [...corrected.data].filter((_, i) => i % 4 === 0)
  expect(Math.max(...channel) - Math.min(...channel)).toBeLessThanOrEqual(1)
  // Three deliberately different radial scales of the same linear signal.
  const scales = [1.1, 1, 0.9]
  for (let y = 0; y < frame.height; y++)
    for (let x = 0; x < frame.width; x++)
      for (let c = 0; c < 3; c++)
        frame.data[(y * frame.width + x) * 4 + c] = 0.3 + ((x - cx) / frame.width / scales[c]) * 0.3
  const ca = {
    ...profile,
    chromaticAberration: { red: constant(scales[0]), blue: constant(scales[2]) },
  }
  const aligned = correctCpu(
    frame,
    correctionPlan(frame.width, frame.height, ca, { ...noLensSettings, chromaticAberration: true }),
  )
  let maximum = 0
  for (let i = 0; i < aligned.data.length; i += 4)
    maximum = Math.max(
      maximum,
      Math.abs(aligned.data[i] - aligned.data[i + 1]),
      Math.abs(aligned.data[i + 2] - aligned.data[i + 1]),
    )
  expect(maximum).toBeLessThanOrEqual(1)
})

test('distortion restores a known grid using one centered resampling', () => {
  const frame = synthetic(120, 80)
  const cx = (frame.width - 1) / 2,
    cy = (frame.height - 1) / 2
  const pattern = (x: number, y: number) =>
    (Math.cos((x * Math.PI) / 8) + Math.cos((y * Math.PI) / 8)) * 0.08 + 0.25
  for (let y = 0; y < frame.height; y++)
    for (let x = 0; x < frame.width; x++)
      for (let c = 0; c < 3; c++)
        frame.data[(y * frame.width + x) * 4 + c] = pattern((x - cx) / 1.1, (y - cy) / 1.1)
  const plan = correctionPlan(frame.width, frame.height, profile, {
    ...noLensSettings,
    distortion: true,
  })
  const corrected = correctCpu(frame, plan)
  const reference = synthetic(plan.width, plan.height)
  for (let y = 0; y < reference.height; y++)
    for (let x = 0; x < reference.width; x++)
      for (let c = 0; c < 3; c++)
        reference.data[(y * reference.width + x) * 4 + c] = pattern(
          x + plan.left - cx,
          y + plan.top - cy,
        )
  const expected = correctCpu(
    reference,
    correctionPlan(reference.width, reference.height, profile, noLensSettings),
  )
  let difference = 0
  for (let i = 0; i < expected.data.length; i++)
    difference += Math.abs(expected.data[i] - corrected.data[i])
  expect(difference / expected.data.length).toBeLessThan(0.5)
})

test('centered native crop contains every mapped channel and preserves portrait orientation', () => {
  const frame = synthetic()
  const plan = correctionPlan(frame.width, frame.height, profile, automaticLensSettings)
  expect(plan.width).toBeLessThan(frame.width)
  expect(Math.abs(plan.width / plan.height - frame.width / frame.height)).toBeLessThan(0.04)
  const cx = (frame.width - 1) / 2,
    cy = (frame.height - 1) / 2
  let cropFailure:
    { x: number; y: number; channel: number; mappedX: number; mappedY: number } | undefined
  for (let y = 0; y < plan.height && !cropFailure; y++)
    for (let x = 0; x < plan.width && !cropFailure; x++) {
      const qx = x + plan.left - cx,
        qy = y + plan.top - cy
      for (let c = 0; c < 3; c++) {
        const factor = radial(plan.lut, Math.hypot(qx, qy) / Math.hypot(cx, cy), c)
        const mappedX = Math.abs(qx * factor),
          mappedY = Math.abs(qy * factor)
        if (!(mappedX <= cx && mappedY <= cy)) {
          cropFailure = { x, y, channel: c, mappedX, mappedY }
          break
        }
      }
    }
  expect(cropFailure, 'First channel outside the native crop').toBeUndefined()
  const landscape = correctCpu(frame, plan)
  const portrait = correctCpu({ ...frame, flip: 6 }, plan)
  expect([portrait.width, portrait.height]).toEqual([landscape.height, landscape.width])
  let orientationFailure:
    { x: number; y: number; channel: number; actual: number; expected: number } | undefined
  for (let y = 0; y < plan.height && !orientationFailure; y++)
    for (let x = 0; x < plan.width && !orientationFailure; x++)
      for (let c = 0; c < 4; c++) {
        const actual = portrait.data[(x * plan.height + plan.height - 1 - y) * 4 + c]
        const expected = landscape.data[(y * plan.width + x) * 4 + c]
        if (!Object.is(actual, expected)) {
          orientationFailure = { x, y, channel: c, actual, expected }
          break
        }
      }
  expect(orientationFailure, 'First incorrectly rotated channel').toBeUndefined()
})

test('a second camera and provider extend the contracts without viewer changes', () => {
  const camera: CameraProfile = {
    id: 'test-camera',
    version: '1',
    make: 'Test',
    aliases: ['Example'],
    coordinates: 'active-sensor',
    orientation: 'decoder-flip-once',
  }
  const provider: LensCorrectionProvider = {
    id: 'test-calibration',
    version: '1',
    resolve: (metadata) => (metadata.model === 'Example' ? profile : null),
  }
  expect(cameraProfile('Test', 'Example', [camera])).toEqual(camera)
  const metadata = processingMetadata({ 'IFD0:Make': 'Test', 'IFD0:Model': 'Example' }, [provider])
  expect(metadata.lensProfile).toEqual(profile)
  const frame = synthetic()
  expect(
    correctCpu(
      frame,
      correctionPlan(frame.width, frame.height, metadata.lensProfile, automaticLensSettings),
    ).width,
  ).toBeLessThan(frame.width)
})
