import { expect, test } from '@playwright/test'
import {
  constrain,
  fitScale,
  INITIAL_VIEW,
  minimumScale,
  stepScale,
  wheelScale,
  zoomAt,
} from '../src/renderer/src/preview/geometry'

const image = { width: 2000, height: 1000 }
const viewport = { width: 800, height: 600 }

test('fits both orientations, never enlarges small images, and supports very small viewports', () => {
  expect(fitScale(image, viewport)).toBe(0.4)
  expect(fitScale({ width: 1000, height: 2000 }, viewport)).toBe(0.3)
  expect(fitScale({ width: 80, height: 40 }, viewport)).toBe(1)
  expect(minimumScale(image, { width: 100, height: 40 })).toBe(0.04)
  expect(constrain(INITIAL_VIEW, image, viewport)).toEqual({ fit: true, scale: 0.4, x: 0, y: 0 })
})

test('keeps the image point under the pointer unchanged during zoom and clamps at edges', () => {
  const before = { fit: false, scale: 1, x: -100, y: 30 }
  const pointer = { x: 120, y: -80 }
  const after = zoomAt(before, 2, pointer, image, viewport)
  expect((pointer.x - after.x) / after.scale).toBe((pointer.x - before.x) / before.scale)
  expect((pointer.y - after.y) / after.scale).toBe((pointer.y - before.y) / before.scale)
  expect(constrain({ fit: false, scale: 1, x: 9000, y: -9000 }, image, viewport)).toEqual({
    fit: false,
    scale: 1,
    x: 600,
    y: -200,
  })
  expect(zoomAt(after, 0.1, pointer, image, viewport)).toEqual({
    fit: false,
    scale: 0.1,
    x: 0,
    y: 0,
  })
  expect(zoomAt(after, 20, pointer, image, viewport).scale).toBe(4)
})

test('preserves manual center coordinates on resize and normalizes wheel and preset steps', () => {
  const manual = { fit: false, scale: 2, x: 150, y: -80 }
  expect(constrain(manual, image, { width: 1200, height: 800 })).toEqual(manual)
  expect(constrain(manual, image, { width: 6000, height: 3000 })).toEqual({ ...manual, x: 0, y: 0 })
  expect(wheelScale(1, 1, 1, 600)).toBe(wheelScale(1, 16, 0, 600))
  expect(wheelScale(1, 1, 2, 100)).toBe(wheelScale(1, 100, 0, 600))
  expect(stepScale(0.4, 1, 0.1)).toBe(0.5)
  expect(stepScale(0.4, -1, 0.1)).toBe(0.25)
  expect(stepScale(0.1, -1, 0.04)).toBe(0.04)
  expect(stepScale(4, 1, 0.1)).toBe(4)
})
