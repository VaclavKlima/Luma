/** Shared preview preference and isolated diagnostic helpers; physical output is unverified. */
export type PreviewPreference = 'auto' | 'hdr' | 'sdr'
export interface DiagnosticTarget {
  generation: number
  requested: PreviewPreference
  mode: 'hdr' | 'sdr'
  headroom: number | null
  reason: string
  verified: false
}

export function linearHeadroom(stops: unknown): number | null {
  if (typeof stops !== 'number' || !Number.isFinite(stops) || stops < 0) return null
  const ratio = 2 ** stops
  return Number.isFinite(ratio) ? ratio : null
}

export function diagnosticTarget(
  requested: PreviewPreference,
  stops: unknown,
  unavailable: string | null,
  generation: number,
): DiagnosticTarget {
  const headroom = linearHeadroom(stops)
  const reason =
    unavailable ||
    (requested === 'sdr'
      ? 'SDR comparison selected.'
      : headroom === null
        ? 'Display headroom is unavailable.'
        : headroom <= 1
          ? 'The display reports no HDR headroom.'
          : '')
  return {
    generation,
    requested,
    mode: reason ? 'sdr' : 'hdr',
    headroom,
    reason: reason || 'Extended canvas candidate; physical output is unverified.',
    verified: false,
  }
}

/** Extended sRGB/Display-P3 encoding, applied once before the float canvas. */
export function encodeDiagnosticChannel(linear: number): number {
  if (!Number.isFinite(linear)) throw new Error('Non-finite diagnostic channel.')
  const magnitude = Math.abs(linear)
  return (
    Math.sign(linear) *
    (magnitude <= 0.0031308 ? 12.92 * magnitude : 1.055 * magnitude ** (1 / 2.4) - 0.055)
  )
}

export const diagnosticLevels = [0, 0.18, 1, 2, 4, 16] as const
export const diagnosticColors = [
  { name: 'Neutral', rgb: [1, 1, 1] },
  { name: 'Red', rgb: [1, 0.1, 0.1] },
  { name: 'Green', rgb: [0.1, 1, 0.1] },
  { name: 'Blue', rgb: [0.1, 0.1, 1] },
] as const
