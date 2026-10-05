import type { Photo } from './contracts'
import type { HdrWorkingAsset } from './hdr'
import type { ProcessingMetadata } from './lens'

export const MERGE_VERSION = 'sony-merge-v3'
export type MergeVersion = 'sony-merge-v1' | 'sony-merge-v2' | typeof MERGE_VERSION
export const MERGE_PIPELINE = Object.freeze({
  preparation: 'sensor-white-rec2020-v3',
  alignment: 'masked-tile-native-v3',
  accumulation: 'tiled-inverse-variance-v3',
})
export interface MergeMeasurements {
  stages: Record<
    | 'decoding'
    | 'preparation'
    | 'matching'
    | 'nativeValidation'
    | 'accumulation'
    | 'output'
    | 'publication',
    number
  >
  preparation: {
    backend: 'gpu' | 'cpu'
    adapter?: string
    fallback?: string
    reused: boolean
    decodingMs: number
    preparationMs: number
  }[]
  accumulation: {
    backend: 'gpu' | 'cpu'
    kernel?: 'sensor-warp' | 'prepared-bands'
    referenceReused?: boolean
    adapter?: string
    fallback?: string
    batches?: {
      rows: number
      sourceBytes: number
      readingMs: number
      uploadMs: number
      dispatchMs: number
      readbackMs: number
      writingMs: number
    }
  }
  coverage?: { backend: 'gpu' | 'cpu'; fallback?: string }
  output?: { backend: 'gpu' | 'cpu'; fallback?: string }
  attempts: {
    sourceId: string
    referenceId: string
    success: boolean
    runtimeMs: number
    patches?: { samplingMs: number; optimizationMs: number; count: number; pixels: number }
  }[]
  disk: { readBytes: number; writtenBytes: number }
  peak: { workerBytes: number; gpuBytes: number; wasmBytes: number }
  runtimeMs: number
}
export const MERGE_LIMITS = Object.freeze({
  minSources: 2,
  maxSources: 32,
  noiseSpreadEv: 0.1,
  rotationDegrees: 5,
  translationFraction: 0.1,
  coverage: 0.7,
  maxPixels: 24_000_000,
  stripRows: 64,
  previewEdge: 1024,
  exposureToleranceEv: 0.25,
  minimumOverlapSamples: 128,
  readNoise: 0.0015,
  shotNoise: 0.0001,
  maskRadius: 3,
})
export const ALIGNMENT_CONSTANTS = Object.freeze({
  version: 'opencv-4.13.0-orb-tile-ic-v3' as const,
  minimumInliers: 30,
  minimumCells: 6,
  grid: 4,
  ransacPixels: 2,
  nativeAccuracy: 0.5,
  minimumPatchAgreement: 0.7,
  minimumPatches: 8,
  nativePatchEdge: 160,
  trainingGrid: 12,
  validationGrid: 11,
  motionValidationGrid: 19,
  shadowFloor: 0.004,
  motionPatchEdge: 320,
  motionTrainingGrid: 16,
  motionPatchCorrelation: 0.98,
  motionValidFraction: 0.25,
  motionConsensusPixels: 0.8,
  maximumTileOffsetPixels: 3,
  maximumCompetingSupport: 0.4,
  minimumNativeCells: 4,
})
export type MergeMode = 'hdr' | 'noise'
export interface MergeSettings {
  mode: MergeMode
  autoAlign: boolean
  deghost: boolean
  strength: number
  referenceId: string
  autoCrop: boolean
}
export interface MergeCapture {
  shutterSeconds: number
  iso: number
  aperture: number
  focalLength: number
  focusDistance?: number
}
export interface MergeSource {
  photo: Photo
  capture: MergeCapture
  relativeEv: number
  metadata: ProcessingMetadata
}
export type MergeMatrix = [number, number, number, number, number, number, number, number, number]
export interface AlignmentDiagnostics {
  algorithm: typeof ALIGNMENT_CONSTANTS.version
  model: 'similarity' | 'projective' | 'identity'
  matches: number
  inliers: number
  cells: number
  nativePatches: {
    x: number
    y: number
    dx: number
    dy: number
    correlation: number
    accepted: boolean
  }[]
  movingRegions: { left: number; top: number; width: number; height: number }[]
  via?: string
  runtimeMs: number
  wasmMemoryBytes: number
}
export interface MergeFailure {
  code: 'alignment' | 'exposure' | 'coverage' | 'cancelled' | 'processing'
  message: string
  filenames: string[]
  diagnostics: AlignmentDiagnostics[]
  measurements?: MergeMeasurements
}
export class MergeError extends Error {
  constructor(readonly failure: MergeFailure) {
    super(failure.message)
    this.name = 'MergeError'
  }
}
export function mergeFailure(error: unknown): MergeFailure {
  if (error instanceof MergeError) return error.failure
  return {
    code: 'processing',
    message:
      error instanceof Error && 'code' in error
        ? 'Merge processing could not read or write its managed working data.'
        : error instanceof Error
          ? error.message
          : 'Merge processing failed.',
    filenames: [],
    diagnostics: [],
  }
}
export interface MergeDiagnostics {
  reviewId: string
  revision: number
  status: 'pending' | 'ready' | 'failed'
  sources: { id: string; filename: string; diagnostics?: AlignmentDiagnostics }[]
  error?: MergeFailure
  measurements?: MergeMeasurements
}
/** Inverse warp from reference coordinates to source, rotating about the image center. */
export interface MergeTransform {
  x: number
  y: number
  angle: number
  correlation: number
  matrix?: MergeMatrix
  diagnostics?: AlignmentDiagnostics
  tiles?: { columns: number; rows: number; width: number; height: number; offsets: number[] }
}
export interface MergeCrop {
  left: number
  top: number
  width: number
  height: number
}
export interface MergeRecipe {
  resolution: 'preview' | 'native'
  maskDimensions: { width: number; height: number }
  version: MergeVersion
  constants: typeof MERGE_LIMITS
  alignment?: typeof ALIGNMENT_CONSTANTS
  pipeline?: typeof MERGE_PIPELINE
  measurements?: MergeMeasurements
  settings: MergeSettings
  sources: {
    id: string
    filename: string
    capture: MergeCapture
    scale: number
    transform: MergeTransform
    decoder: string
    cameraProfile: string
    lensIdentity: string
  }[]
  width: number
  height: number
  crop: MergeCrop
  affectedPercent: number
  referenceClippedPercent: number
  maskSha256: string
}
export interface MergeReview {
  id: string
  revision: number
  sources: MergeSource[]
  settings: MergeSettings
  scratchBytes: number
}
export interface MergePreview {
  reviewId: string
  revision: number
  resultUrl: string
  referenceUrl: string
  overlayUrl: string
  width: number
  height: number
  recipe: MergeRecipe
}
export interface MergeManifest {
  version: MergeVersion
  asset: HdrWorkingAsset
  recipe: MergeRecipe
  photo: Photo
  metadata: ProcessingMetadata
}
export function mergeUnavailable(count: number): string | undefined {
  return count < 2
    ? 'Select at least two verified Sony RAW photographs.'
    : count > 32
      ? 'Select no more than 32 photographs.'
      : undefined
}
export function validateMergeSettings(value: MergeSettings, ids: string[]): void {
  if (
    !value ||
    Object.keys(value).sort().join() !== 'autoAlign,autoCrop,deghost,mode,referenceId,strength' ||
    !['hdr', 'noise'].includes(value.mode) ||
    !ids.includes(value.referenceId) ||
    !Number.isInteger(value.strength) ||
    value.strength < 0 ||
    value.strength > 100 ||
    ![value.autoAlign, value.autoCrop, value.deghost].every((v) => typeof v === 'boolean')
  )
    throw new Error('Invalid merge settings.')
}
export function exposure(capture: MergeCapture): number {
  return (capture.shutterSeconds * capture.iso) / capture.aperture ** 2
}
export function validateMergeSources(sources: MergeSource[], mode: MergeMode): void {
  const unavailable = mergeUnavailable(sources.length)
  if (unavailable) throw new Error(unavailable)
  if (new Set(sources.map((s) => s.photo.id)).size !== sources.length)
    throw new Error('Duplicate merge sources.')
  const first = sources[0]
  for (const s of sources) {
    const m = s.metadata,
      c = s.capture
    if (
      s.photo.assetKind === 'derived' ||
      !m.hdrEligible ||
      !['ZV-1', 'ZV-1A'].includes(m.model ?? '') ||
      !m.whiteBalance ||
      ![c.shutterSeconds, c.iso, c.aperture, c.focalLength].every(
        (v) => Number.isFinite(v) && v > 0,
      )
    )
      throw new Error(
        `${s.photo.filename}: a verified Sony RAW with numeric capture metadata is required.`,
      )
    if (
      m.model !== first.metadata.model ||
      s.photo.width !== first.photo.width ||
      s.photo.height !== first.photo.height ||
      c.aperture !== first.capture.aperture ||
      c.focalLength !== first.capture.focalLength ||
      (c.focusDistance !== undefined &&
        first.capture.focusDistance !== undefined &&
        c.focusDistance !== first.capture.focusDistance)
    )
      throw new Error(
        `${s.photo.filename}: camera, dimensions, focal length, aperture or focus differs.`,
      )
  }
  const evs = sources.map((s) => Math.log2(exposure(s.capture)))
  if (mode === 'noise' && Math.max(...evs) - Math.min(...evs) > MERGE_LIMITS.noiseSpreadEv + 1e-9)
    throw new Error(
      'Noise reduction requires exposures within 0.1 EV. Use HDR mode for this selection.',
    )
}
