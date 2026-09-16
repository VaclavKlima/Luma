import type { LensSettings, ProcessingMetadata, ProcessingOptions } from '../shared/lens'
import type { PhotoMetadata, Photo } from '../shared/contracts'

export type PreviewStage = 'unpack' | 'gpu' | 'cpu' | 'cache'
export type PreviewWorkerRequest =
  | { type: 'close' }
  | { type: 'release' }
  | {
      type: 'process' | 'full' | 'metadata'
      path: string
      output: string
      options?: ProcessingOptions
    }
export type PreviewWorkerResponse =
  | { type: 'stage'; stage: PreviewStage }
  | { type: 'result'; result: PreviewResult | FullPreviewResult | ProcessingMetadata }
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
  renderFull(
    path: string,
    output: string,
    signal: AbortSignal,
    options?: ProcessingOptions,
  ): Promise<FullPreviewResult>
  close(): Promise<void>
  releaseFrame?(): void
}
