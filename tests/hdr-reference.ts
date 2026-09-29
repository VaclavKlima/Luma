// Independent Float64 reference: scalar luminance operators and XYZ primary conversion.
// D65 matrices from CSS Color 4 sample conversion code; no production math imports.
import type { AdjustmentParameters } from '../src/shared/adjustments'
const weights = [0.2627002120112671, 0.6779980715188708, 0.059301716469862]
const toXYZ = [
  0.6369580483012914, 0.14461690358620832, 0.1688809751641721, 0.2627002120112671,
  0.6779980715188708, 0.05930171646986196, 0, 0.028072693049087428, 1.060985057710791,
]
const fromXYZ = {
  srgb: [
    3.2409699419045226, -1.537383177570094, -0.4986107602930034, -0.9692436362808796,
    1.8759675015077202, 0.04155505740717559, 0.05563007969699366, -0.20397695888897652,
    1.0569715142428786,
  ],
  'display-p3': [
    2.493496911941425, -0.9313836179191239, -0.40271078445071684, -0.8294889695615747,
    1.7626640603183463, 0.023624685841943577, 0.03584583024378447, -0.07617238926804182,
    0.9568845240076872,
  ],
}
const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0)
const mul = (m: number[], v: number[]) => [0, 1, 2].map((r) => dot(m.slice(r * 3, r * 3 + 3), v))
export function referenceAdjust(input: number[], p: AdjustmentParameters) {
  let rgb = input.map((v) => v * Math.pow(2, p.exposureEv))
  const scale = (next: (y: number) => number) => {
    const y = dot(weights, rgb)
    if (y > 0) rgb = rgb.map((v) => (v * next(y)) / y)
  }
  scale((y) =>
    y >= 1
      ? y
      : y <= 0.18
        ? 0.18 * Math.pow(y / 0.18, Math.pow(2, p.contrast / 100))
        : 1 - 0.82 * Math.pow((1 - y) / 0.82, Math.pow(2, p.contrast / 100)),
  )
  scale((y) =>
    y <= 0.18 ? y : y + (p.highlights / 100) * (y - 0.18 - (0.82 * (y - 0.18)) / (y + 0.64)),
  )
  scale((y) =>
    y >= 0.18 ? y : y * Math.pow(2, ((2 * p.shadows) / 100) * Math.pow(1 - y / 0.18, 2)),
  )
  scale((y) => {
    const t = Math.min(1, Math.max(0, (y - 0.18) / 0.82))
    return y * Math.pow(2, (p.whites / 100) * (3 * t * t - 2 * t * t * t))
  })
  const y = dot(weights, rgb),
    d = ((0.04 * p.blacks) / 100) * Math.pow(Math.max(0, 1 - y / 0.18), 3)
  if (y >= 0 && p.blacks > 0) rgb = rgb.map((v) => v + d)
  else if (y > 0 && p.blacks < 0) rgb = rgb.map((v) => (v * Math.max(0, y + d)) / y)
  return rgb
}
export function referenceOutput(rgb: number[], peak: number, space: keyof typeof fromXYZ) {
  const y = dot(weights, rgb)
  if (y <= 0) return [0, 0, 0]
  const mapped = y <= 0.75 ? y : 0.75 + ((peak - 0.75) * (y - 0.75)) / (peak + y - 1.5)
  const converted = mul(fromXYZ[space], mul(toXYZ, rgb)).map((v) => (v * mapped) / y)
  const delta = converted.map((v) => v - mapped)
  const extent = Math.max(0, ...delta.map((v) => (v > 0 ? v / (peak - mapped) : -v / mapped)))
  const factor = extent <= 0.9 ? 1 : (1 - 0.01 / (extent - 0.8)) / extent
  return delta.map((v) => Math.max(0, Math.min(peak, mapped + factor * v)))
}
