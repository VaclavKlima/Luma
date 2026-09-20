import type { ImageStatistics } from '../shared/statistics'
import type { AdjustmentParameters } from '../shared/adjustments'
import type { LensSettings, ProcessingMetadata, ProcessingOptions } from '../shared/lens'
import type { PhotoMetadata, Photo, LinearAsset } from '../shared/contracts'

export type PreviewStage = 'unpack' | 'gpu' | 'cpu' | 'cache'
export type PreviewWorkerRequest =
  | { type: 'close' }
  | { type: 'release' }
  | {
      type: 'process' | 'full' | 'metadata' | 'statistics'
      path: string
      output: string
      options?: ProcessingOptions
      frame?: { width: number; height: number; sha256: string }
    }
export type PreviewWorkerResponse =
  | { type: 'stage'; stage: PreviewStage }
  | {
      type: 'result'
      result: PreviewResult | FullPreviewResult | ProcessingMetadata | ImageStatistics
    }
  | { type: 'error'; error: string }

export interface PreviewResult {
  processing?: ProcessingMetadata
  metadata: PhotoMetadata
  source: Photo['previewSource']
}

export interface PreviewProcessor {
  process(path: string, output: string, signal: AbortSignal): Promise<PreviewResult>
  close(): Promise<void>
}

export interface FullPreviewResult {
  statistics?: ImageStatistics
  adjustments?: AdjustmentParameters
  linear?: LinearAsset
  settingsRevision?: number
  appliedCorrections?: LensSettings
  width: number
  height: number
  format: 'rgba8-srgb'
  byteLength: number
  sha256: string
  renderId: string
  placeholderBytes: number
  diagnostics?: {
    backend: 'cpu' | 'gpu'
    adapter?: string
    fallback?: string
    timings: Record<string, number>
  }
}

export interface FullPreviewProcessor {
  statistics?(
    path: string,
    frame: { width: number; height: number; sha256: string },
    signal: AbortSignal,
  ): Promise<ImageStatistics>
  renderFull(
    path: string,
    output: string,
    signal: AbortSignal,
    options?: ProcessingOptions,
  ): Promise<FullPreviewResult>
  close(): Promise<void>
  releaseFrame?(): void
}
