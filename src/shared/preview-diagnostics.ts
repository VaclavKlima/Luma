export interface PreviewPresentation {
  photoId: string
  revision: number
  targetGeneration: number
  backend: 'webgpu-hdr' | 'canvas2d-hdr-sdr' | 'legacy'
  mode: 'hdr' | 'sdr'
  stage: 'loading' | 'presented' | 'failed'
  reason: string
  timings: Record<string, number>
}
export interface PreviewDiagnostics {
  photoId?: string
  revision?: number
  renderingIdentity?: string
  preparationBackend?: 'cpu' | 'gpu'
  cacheHit?: boolean
  loadingStage: 'idle' | 'preparing' | 'prepared' | 'failed'
  timings: Record<string, number>
  presentation?: PreviewPresentation
}
