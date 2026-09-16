import type { RawDecoder } from './contracts'
import { librawDecoder } from './decoders/libraw'
import { rawDecoderId } from './formats'

export const rawDecoders: readonly RawDecoder[] = [librawDecoder]
export function rawDecoder(path: string, decoders = rawDecoders) {
  return decoders.find((decoder) => decoder.id === rawDecoderId(path))
}
