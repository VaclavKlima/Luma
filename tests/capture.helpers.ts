import { CAPTURE_METADATA_VERSION, type CaptureMetadata } from '../src/shared/capture-sequence'

export function sequenceMetadata(
  frame: number,
  preciseTime = `2026-10-04T14:42:32.${String(frame * 80).padStart(3, '0')}`,
): CaptureMetadata {
  return {
    version: CAPTURE_METADATA_VERSION,
    make: 'SONY',
    model: 'ZV-1A',
    format: 'ARW',
    releaseMode: 2,
    releaseMode2: 1,
    releaseMode3: 1,
    sequenceLength: 0,
    sequenceNumber: frame,
    sequenceImageNumber: frame,
    sequenceFileNumber: frame,
    preciseTime,
  }
}
export function sequenceFrames(count = 4) {
  return Array.from({ length: count }, (_, index) => ({
    id: (index + 1).toString(16).padStart(64, '0'),
    metadata: sequenceMetadata(index + 1),
  }))
}
