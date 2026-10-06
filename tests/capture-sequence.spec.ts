import { test, expect } from '@playwright/test'
import {
  captureMetadata,
  detectCaptureSequences,
  preciseCaptureTime,
} from '../src/shared/capture-sequence'
import { sequenceFrames, sequenceMetadata } from './capture.helpers'

test('capture extraction retains all fractional digits including leading zeros', () => {
  const tags = {
    'IFD0:Make': 'SONY',
    'IFD0:Model': 'ZV-1A',
    'ExifIFD:DateTimeOriginal': '2026:10:04 14:42:33',
    'ExifIFD:SubSecTimeOriginal': '0060',
    'ExifIFD:OffsetTimeOriginal': '+02:00',
  }
  const metadata = captureMetadata(tags, 'arw')
  expect(metadata.subSecTimeOriginal).toBe('0060')
  expect(metadata.preciseTime).toBe('2026-10-04T14:42:33.0060+02:00')
  expect(preciseCaptureTime(metadata.preciseTime)).toBe(
    preciseCaptureTime('2026-10-04T12:42:33.006Z'),
  )
  expect(preciseCaptureTime('2026-02-30T12:42:33.006')).toBeNull()
  expect(preciseCaptureTime('2026-10-04T12:42:33')).toBeNull()
  expect(preciseCaptureTime('2026-10-04T12:42:33.1+99:00')).toBeNull()
  expect(
    captureMetadata({ ...tags, 'ExifIFD:SubSecTimeOriginal': 915 }, 'ARW').subSecTimeOriginal,
  ).toBe('915')
})

test('shuffled imports group only the contiguous verified camera pattern', () => {
  const photos = sequenceFrames()
  expect(detectCaptureSequences([photos[2], photos[0], photos[3], photos[1]])[0].ids).toEqual(
    photos.map((p) => p.id),
  )
})

for (const [label, patch] of [
  ['conflicting counters', { sequenceFileNumber: 8 }],
  ['missing counter', { sequenceImageNumber: undefined }],
  ['conflicting drive modes', { releaseMode3: 0 }],
  ['bracket mode', { releaseMode3: 2 }],
  ['unsupported camera', { model: 'ZV-1' }],
  ['unsupported format', { format: 'JPG' }],
  ['missing precise time', { preciseTime: undefined }],
  ['different drive metadata', { driveMode: 2 }],
] as const)
  test(`${label} remains available for manual grouping`, () => {
    const photos = sequenceFrames(3).map((p) => ({ ...p, metadata: { ...p.metadata, ...patch } }))
    expect(detectCaptureSequences(photos)).toEqual([])
  })

test('missing frames, absent starts, nonincreasing timestamps and long gaps reject the whole candidate', () => {
  const photos = sequenceFrames()
  for (const items of [
    photos.slice(1),
    [photos[0], photos[2], photos[3]],
    photos.map((p, i) =>
      i === 1
        ? { ...p, metadata: { ...p.metadata, preciseTime: photos[0].metadata.preciseTime } }
        : p,
    ),
    photos.map((p, i) =>
      i === 3 ? { ...p, metadata: { ...p.metadata, preciseTime: '2026-10-04T14:42:34.321' } } : p,
    ),
  ])
    expect(detectCaptureSequences(items)).toEqual([])
})

test('unknown timing combined with incomplete drive metadata cannot silently shorten a burst', () => {
  const photos = sequenceFrames(3)
  photos[2].metadata = { ...photos[2].metadata, releaseMode3: undefined, preciseTime: undefined }
  expect(detectCaptureSequences(photos)).toEqual([])
  photos[2].metadata = { ...photos[2].metadata, releaseMode3: 0 }
  expect(detectCaptureSequences(photos)).toEqual([])
})

test('counter resets define independent sequences; ambiguous simultaneous captures are rejected', () => {
  const first = sequenceFrames(3),
    second = sequenceFrames(3).map((p, i) => ({
      id: `a${p.id.slice(1)}`,
      metadata: sequenceMetadata(i + 1, `2026-10-04T14:42:33.${String(i * 80).padStart(3, '0')}`),
    }))
  expect(detectCaptureSequences([...second, ...first]).map((s) => s.ids)).toEqual([
    first.map((p) => p.id),
    second.map((p) => p.id),
  ])
  expect(
    detectCaptureSequences([...first, ...first.map((p) => ({ ...p, id: `b${p.id.slice(1)}` }))]),
  ).toEqual([])
})

test('single-shot exposure series and time-only neighbors are never automatic sequences', () => {
  const single = sequenceFrames(9).map((p) => ({
    ...p,
    metadata: {
      ...p.metadata,
      releaseMode: 0,
      releaseMode2: 0,
      releaseMode3: 0,
      sequenceNumber: 0,
      sequenceImageNumber: 1,
      sequenceFileNumber: 1,
      sequenceLength: 1,
    },
  }))
  expect(detectCaptureSequences(single)).toEqual([])
  const burst = sequenceFrames(3)
  expect(
    detectCaptureSequences([
      ...burst,
      ...single.map((p) => ({
        ...p,
        id: `c${p.id.slice(1)}`,
        metadata: {
          ...p.metadata,
          preciseTime: p.metadata.preciseTime!.replace('14:42:32', '14:43:32'),
        },
      })),
    ]),
  ).toHaveLength(1)
})
