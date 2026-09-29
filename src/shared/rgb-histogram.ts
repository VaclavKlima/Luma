import { encodeHdr, type DisplayTarget } from './hdr'
export const RGB_HISTOGRAM_VERSION = 'rgb-histogram-v1'
export interface RgbHistogram {
  version: typeof RGB_HISTOGRAM_VERSION
  targetGeneration: number
  mode: 'hdr' | 'sdr'
  colorSpace: DisplayTarget['colorSpace']
  mapping: 'encoded-sdr-256' | 'encoded-sdr-256-log2-hdr-256'
  referenceWhite: 1
  maxStops: number
  displayLimitStops: number
  rgb: [number[], number[], number[]]
  visiblePixels: number
}
export function rgbHistogram(target: DisplayTarget): RgbHistogram {
  const hdr = target.mode === 'hdr'
  return {
    version: RGB_HISTOGRAM_VERSION,
    targetGeneration: target.generation,
    mode: target.mode,
    colorSpace: target.colorSpace,
    mapping: hdr ? 'encoded-sdr-256-log2-hdr-256' : 'encoded-sdr-256',
    referenceWhite: 1,
    maxStops: hdr ? Math.max(4, Math.ceil(Math.log2(target.headroom ?? target.peak))) : 0,
    displayLimitStops: Math.log2(target.peak),
    rgb: [
      Array(hdr ? 512 : 256).fill(0),
      Array(hdr ? 512 : 256).fill(0),
      Array(hdr ? 512 : 256).fill(0),
    ],
    visiblePixels: 0,
  }
}
/** Reference white belongs to SDR's last bin. The HDR half uses equal log2 intervals. */
export function rgbHistogramBin(linear: number, histogram: RgbHistogram): number {
  if (linear <= 1 || histogram.mode === 'sdr')
    return Math.round(Math.max(0, Math.min(1, encodeHdr(linear))) * 255)
  return 256 + Math.min(255, Math.floor((Math.log2(linear) * 256) / histogram.maxStops))
}
export function addRgbHistogram(histogram: RgbHistogram, rgb: readonly number[], alpha: number) {
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1 || !rgb.every(Number.isFinite))
    throw new Error('Invalid RGB histogram sample.')
  if (!alpha) return
  histogram.visiblePixels++
  for (let c = 0; c < 3; c++) histogram.rgb[c][rgbHistogramBin(rgb[c], histogram)]++
}
