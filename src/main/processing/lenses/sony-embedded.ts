import { createHash } from 'node:crypto'
import type { LensCorrectionProvider } from '../contracts'
import type { RadialTable, LensProfile } from '../../../shared/lens'
import { cameraProfile } from '../cameras'

function samples(value: unknown, channels = 1): number[][] | undefined {
  const values =
    typeof value === 'string' && value.trim()
      ? value.trim().split(/\s+/).map(Number)
      : Array.isArray(value)
        ? value
        : []
  const count = values[0]
  if (
    !Number.isInteger(count) ||
    count < channels * 2 ||
    count > channels * 16 ||
    count % channels ||
    values.length < count + 1 ||
    values.length > channels * 16 + 1 ||
    !values.every(
      (n) => typeof n === 'number' && Number.isInteger(n) && n >= -32768 && n <= 32767,
    ) ||
    values.slice(count + 1).some((n) => n !== 0)
  )
    return
  return Array.from({ length: channels }, (_, c) =>
    values.slice(1 + (c * count) / channels, 1 + ((c + 1) * count) / channels),
  )
}
function table(values: number[], convert: (value: number) => number): RadialTable | undefined {
  const result = {
    radii: values.map((_, i) => (i + 0.5) / (values.length - 1)),
    values: values.map(convert),
  }
  if (result.values.some((n) => !Number.isFinite(n) || n < 0.5 || n > 4)) return
  return result
}

export const sonyEmbedded: LensCorrectionProvider = {
  id: 'sony-embedded',
  version: '1',
  resolve(metadata, tags) {
    if (cameraProfile(metadata.make ?? '', metadata.model ?? '')?.id !== 'sony-zv1-family')
      return null
    // SubIFD is authoritative. Sony:DistortionCorrParams is a different maker-note tag.
    const get = (tag: string) => tags[`SubIFD:${tag}`] ?? tags[`SR2SubIFD:${tag}`]
    const distortion = samples(get('DistortionCorrParams'))?.[0]
    const vignette = samples(get('VignettingCorrParams'))?.[0]
    const ca = samples(get('ChromaticAberrationCorrParams'), 2)
    const profile: LensProfile = {
      provider: this.id,
      version: this.version,
      label: `${metadata.model} embedded lens profile`,
      identity: '',
      unavailable: {},
      distortion: distortion && table(distortion, (n) => 1 + n / 16384),
      vignetting: vignette && table(vignette, (n) => 2 ** (2 ** (n / 8192 - 1) - 0.5)),
    }
    if (profile.distortion && !monotonic(profile.distortion)) profile.distortion = undefined
    if (ca) {
      const red = table(ca[0], (n) => 1 + n / 2097152),
        blue = table(ca[1], (n) => 1 + n / 2097152)
      if (red && blue && monotonic(red) && monotonic(blue))
        profile.chromaticAberration = { red, blue }
    }
    for (const kind of ['distortion', 'vignetting', 'chromaticAberration'] as const)
      if (!profile[kind])
        profile.unavailable[kind] = 'The embedded correction table is missing or invalid.'
    profile.identity = createHash('sha256').update(JSON.stringify(profile)).digest('hex')
    return profile
  },
}

function monotonic(table: RadialTable): boolean {
  return table.radii.every((r, i) => {
    if (i === 0) return true
    const previous = table.radii[i - 1]
    const slope = (table.values[i] - table.values[i - 1]) / (r - previous)
    return table.values[i] + r * slope > 0 && table.values[i - 1] + previous * slope > 0
  })
}
