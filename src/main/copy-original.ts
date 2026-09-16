import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export async function copyOriginal(
  source: string,
  destination: string,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(
    createReadStream(source, { signal }),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk)
        onProgress(chunk.length)
        callback(null, chunk)
      },
    }),
    createWriteStream(destination, { flags: 'wx', flush: true }),
    { signal },
  )
  return hash.digest('hex')
}
