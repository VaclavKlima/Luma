import { probeHdrCanvas } from '../src/renderer/src/preview/hdr-device'
import { expect, test } from '@playwright/test'
import {
  diagnosticTarget,
  encodeDiagnosticChannel,
  linearHeadroom,
} from '../src/shared/hdr-display'

test('headroom is logarithmic and missing or invalid values fail closed', () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity, -1, '2', 1024])
    expect(linearHeadroom(value)).toBeNull()
  expect(linearHeadroom(0)).toBe(1)
  expect(linearHeadroom(1)).toBe(2)
  expect(linearHeadroom(2)).toBe(4)
  expect(linearHeadroom(0.5)).toBeCloseTo(Math.SQRT2, 14)
})

test('requested HDR never bypasses unavailable hardware or missing headroom', () => {
  for (const mode of ['auto', 'hdr'] as const) {
    expect(diagnosticTarget(mode, undefined, null, 7)).toMatchObject({
      mode: 'sdr',
      headroom: null,
      generation: 7,
    })
    expect(diagnosticTarget(mode, 0, null, 8).mode).toBe('sdr')
    expect(diagnosticTarget(mode, 2, 'Software adapter', 9)).toMatchObject({
      mode: 'sdr',
      reason: 'Software adapter',
    })
    expect(diagnosticTarget(mode, 2, null, 10)).toMatchObject({
      mode: 'hdr',
      headroom: 4,
      verified: false,
    })
  }
  expect(diagnosticTarget('sdr', 2, null, 11)).toMatchObject({
    mode: 'sdr',
    requested: 'sdr',
    headroom: 4,
  })
})

test('diagnostic transfer preserves extended values and has an independent inverse', () => {
  const inverse = (value: number) =>
    Math.sign(value) *
    (Math.abs(value) <= 0.04045
      ? Math.abs(value) / 12.92
      : ((Math.abs(value) + 0.055) / 1.055) ** 2.4)
  for (const linear of [-16, -1, -0.18, -0.001, 0, 0.001, 0.18, 1, 2, 4, 16])
    expect(inverse(encodeDiagnosticChannel(linear))).toBeCloseTo(linear, 12)
  expect(encodeDiagnosticChannel(0.18)).toBeCloseTo(0.4613561295, 9)
  expect(encodeDiagnosticChannel(4)).toBeGreaterThan(1)
  expect(() => encodeDiagnosticChannel(Infinity)).toThrow('Non-finite')
})

test('capability probes release scopes on failure and retry extended sRGB after P3 validation failure', async () => {
  let scopes = 0,
    configured: GPUCanvasConfiguration | null = null,
    calls = 0,
    releases = 0
  const device = {
    pushErrorScope: () => {
      scopes++
    },
    popErrorScope: async () => {
      scopes--
      return calls === 1 ? { message: 'P3 unsupported' } : null
    },
  } as unknown as GPUDevice
  const context = {
    configure: (value: GPUCanvasConfiguration) => {
      calls++
      configured = value
    },
    getConfiguration: () => configured,
    unconfigure: () => {
      releases++
    },
  } as unknown as GPUCanvasContext
  expect(await probeHdrCanvas(device, context)).toEqual({ p3: false, extended: true })
  expect(scopes).toBe(0)
  expect(releases).toBe(2)
  context.configure = () => {
    throw new Error('No float canvas')
  }
  await expect(probeHdrCanvas(device, context)).rejects.toThrow('No float canvas')
  expect(scopes).toBe(0)
  expect(releases).toBe(4)
})
