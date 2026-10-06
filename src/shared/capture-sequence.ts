export const CAPTURE_METADATA_VERSION = 1
export const CAPTURE_SEQUENCE_PROFILE = 'sony-zv1a-arw-continuous-v1'

/** Capture facts are independent of processing metadata and immutable merge recipes. */
export interface CaptureMetadata {
  version: number
  make?: string
  model?: string
  serial?: string
  format: string
  dateTimeOriginal?: string
  subSecTimeOriginal?: string
  offsetTimeOriginal?: string
  preciseTime?: string
  driveMode?: number
  releaseMode?: number
  releaseMode2?: number
  releaseMode3?: number
  sequenceNumber?: number
  sequenceImageNumber?: number
  sequenceFileNumber?: number
  sequenceLength?: number
}

export function captureMetadata(tags: Record<string, unknown>, format: string): CaptureMetadata {
  const string = (key: string) =>
    typeof tags[key] === 'string' ? (tags[key] as string) : undefined
  const number = (key: string) =>
    typeof tags[key] === 'number' && Number.isSafeInteger(tags[key])
      ? (tags[key] as number)
      : undefined
  const rawDate = string('ExifIFD:DateTimeOriginal')
  const date = rawDate?.replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T')
  // readRaw preserves these ASCII digits. Never convert a fractional field to a number.
  const rawFraction = tags['ExifIFD:SubSecTimeOriginal']
  const fraction =
    typeof rawFraction === 'string'
      ? rawFraction
      : typeof rawFraction === 'number' && Number.isSafeInteger(rawFraction) && rawFraction >= 0
        ? String(rawFraction)
        : undefined
  const offset = string('ExifIFD:OffsetTimeOriginal')
  return {
    version: CAPTURE_METADATA_VERSION,
    format: format.toUpperCase(),
    make: string('IFD0:Make'),
    model: string('IFD0:Model'),
    serial: string('ExifIFD:BodySerialNumber') ?? string('Sony:SerialNumber'),
    dateTimeOriginal: rawDate,
    subSecTimeOriginal: fraction,
    offsetTimeOriginal: offset,
    preciseTime:
      date && fraction && /^\d+$/.test(fraction) ? `${date}.${fraction}${offset ?? ''}` : undefined,
    driveMode: number('Sony:DriveMode'),
    releaseMode: number('Sony:ReleaseMode'),
    releaseMode2: number('Sony:ReleaseMode2'),
    releaseMode3: number('Sony:ReleaseMode3'),
    sequenceNumber: number('Sony:SequenceNumber'),
    sequenceImageNumber: number('Sony:SequenceImageNumber'),
    sequenceFileNumber: number('Sony:SequenceFileNumber'),
    sequenceLength: number('Sony:SequenceLength'),
  }
}

const precision = 10n ** 18n
export function preciseCaptureTime(value?: string): bigint | null {
  const parts = value?.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{1,18})(Z|[+-]\d{2}:\d{2})?$/,
  )
  if (!parts) return null
  const local = Date.parse(`${parts[1]}Z`)
  if (!Number.isFinite(local) || new Date(local).toISOString().slice(0, 19) !== parts[1])
    return null
  let offset = 0
  if (parts[3] && parts[3] !== 'Z') {
    const hours = Number(parts[3].slice(1, 3)),
      minutes = Number(parts[3].slice(4))
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null
    offset = (hours * 60 + minutes) * (parts[3][0] === '-' ? -1 : 1)
  }
  return BigInt(local / 1000 - offset * 60) * precision + BigInt(parts[2].padEnd(18, '0'))
}

export interface CaptureSequence {
  key: string
  profile: typeof CAPTURE_SEQUENCE_PROFILE
  ids: string[]
}

function verifiedMode(m: CaptureMetadata): boolean {
  return (
    m.version === CAPTURE_METADATA_VERSION &&
    m.make?.toUpperCase() === 'SONY' &&
    m.model === 'ZV-1A' &&
    m.format === 'ARW' &&
    m.releaseMode === 2 &&
    m.releaseMode2 === 1 &&
    m.releaseMode3 === 1 &&
    m.sequenceLength === 0 &&
    // This supplied profile has no DriveMode tag. Additional combinations need evidence.
    m.driveMode === undefined
  )
}
function frame(m: CaptureMetadata): number | null {
  const n = m.sequenceNumber
  return verifiedMode(m) &&
    n !== undefined &&
    n >= 1 &&
    Number.isSafeInteger(n) &&
    n === m.sequenceImageNumber &&
    n === m.sequenceFileNumber
    ? n
    : null
}
function singleShot(m: CaptureMetadata): boolean {
  return m.releaseMode === 0 && m.releaseMode2 === 0 && m.releaseMode3 === 0
}

/** Refuse incomplete or ambiguous sequences rather than grouping by elapsed time alone. */
export function detectCaptureSequences(
  photos: { id: string; metadata: CaptureMetadata }[],
): CaptureSequence[] {
  const cameras = new Map<string, typeof photos>()
  for (const photo of photos) {
    const m = photo.metadata
    const key = JSON.stringify([m.make, m.model, m.serial, m.format, m.offsetTimeOriginal])
    const list = cameras.get(key) ?? []
    list.push(photo)
    cameras.set(key, list)
  }
  const result: CaptureSequence[] = []
  for (const [camera, photos] of cameras) {
    // A continuous frame with unknown timing could overlap any candidate from this camera.
    if (
      photos.some(
        (p) => !singleShot(p.metadata) && preciseCaptureTime(p.metadata.preciseTime) === null,
      )
    )
      continue
    const ordered = photos
      .map((p) => ({
        ...p,
        time: preciseCaptureTime(p.metadata.preciseTime),
        frame: frame(p.metadata),
      }))
      .filter((p): p is typeof p & { time: bigint } => p.time !== null)
      .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.id.localeCompare(b.id)))
    let candidate: typeof ordered = [],
      valid = false
    const finish = () => {
      if (valid && candidate.length >= 2)
        result.push({
          key: `${CAPTURE_SEQUENCE_PROFILE}:${camera}:${candidate[0].metadata.preciseTime}`,
          profile: CAPTURE_SEQUENCE_PROFILE,
          ids: candidate.map((p) => p.id),
        })
    }
    for (let index = 0; index < ordered.length; index++) {
      const p = ordered[index],
        previous = ordered[index - 1]
      const overlap = previous?.time === p.time || ordered[index + 1]?.time === p.time
      if (p.frame === 1) {
        finish()
        candidate = [p]
        valid = !overlap
      } else if (candidate.length) {
        const last = candidate[candidate.length - 1]
        if (p.frame === null) {
          // An unrelated single shot ends a burst. Conflicting continuous facts invalidate it.
          if (singleShot(p.metadata)) {
            finish()
            candidate = []
            valid = false
          } else valid = false
        } else {
          valid &&=
            !overlap &&
            p.frame === (last.frame ?? 0) + 1 &&
            p.time > last.time &&
            p.time - last.time <= precision
          candidate.push(p)
        }
      }
    }
    finish()
  }
  return result
}
