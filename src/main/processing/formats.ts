// Lightweight decoder declarations can be used by main without importing native code.
export const rawDecoderDefinitions = [
  { id: 'libraw', version: '0.22.1-1', extensions: ['arw'] },
] as const
export const photoExtensions = [
  'jpg',
  'jpeg',
  'png',
  'tif',
  'tiff',
  ...rawDecoderDefinitions.flatMap((decoder) => decoder.extensions),
]
export function rawDecoderId(path: string): string | undefined {
  const extension = path.split('.').at(-1)?.toLowerCase()
  return rawDecoderDefinitions.find((decoder) =>
    (decoder.extensions as readonly string[]).includes(extension ?? ''),
  )?.id
}
