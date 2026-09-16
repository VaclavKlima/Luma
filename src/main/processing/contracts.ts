import type { ProcessingMetadata, LensProfile } from '../../shared/lens'
import type { RawSource } from '../gpu/raw-source'

export interface CameraProfile {
  id: string
  version: string
  make: string
  aliases: readonly string[]
  gpu?: { algorithm: 'bayer-ahd'; cfa: readonly [0, 1, 3, 2]; colors: 3; pixelAspect: 1 }
  coordinates: 'active-sensor'
  orientation: 'decoder-flip-once'
}

/** Worker-owned, unrotated, interleaved RGBA float camera RGB in 0..1 sensor units.
 * Alpha is padding. White balance is applied; no matrix, display curve or lens correction.
 * Buffers are owned copies, never views into a decoder's disposable native memory.
 */
export interface LinearFrame {
  data: Float32Array<ArrayBuffer>
  width: number
  height: number
  flip: number
  matrix: number[]
}
export interface RawMetadata {
  make: string
  model: string
  rawWidth: number
  rawHeight: number
  left: number
  top: number
  colors: number
  cfa: number[]
}
export interface RawSession {
  metadata: RawMetadata
  dimensions: { width: number; height: number; flip: number }
  unpack(): void
  gpuSource(): RawSource | null
  linear(): LinearFrame
  display(halfSize?: boolean): { data: Uint8Array; width: number; height: number }
  close(): void
}
export interface RawDecoder {
  id: string
  version: string
  extensions: readonly string[]
  open(path: string): Promise<RawSession>
}
export interface LensCorrectionProvider {
  id: string
  version: string
  resolve(
    metadata: Omit<ProcessingMetadata, 'lensProfile'>,
    tags: Record<string, unknown>,
  ): LensProfile | null
}
