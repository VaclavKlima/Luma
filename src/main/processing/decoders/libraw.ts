import { readFile, stat } from 'node:fs/promises'
import { LibRaw } from '@colorhythm/libraw-wasm'
import type { RawDecoder, LinearFrame } from '../contracts'
import { readGpuSource } from '../../gpu/raw-source'
import { rawDecoderDefinitions } from '../formats'

export const librawDecoder: RawDecoder = {
  ...rawDecoderDefinitions[0],
  async open(path) {
    if ((await stat(path)).size > 512 * 1024 * 1024)
      throw new Error('This RAW exceeds the 512 MB decoder limit.')
    await LibRaw.initialize()
    const decoder = new LibRaw()
    await decoder.waitUntilReady()
    try {
      const bytes = await readFile(path)
      decoder.open(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      decoder.setHalfSize(0)
      decoder.setDemosaic(3)
      decoder.setUseCameraWb(1)
      decoder.setOutputColor(1)
      decoder.setOutputBps(8)
      const dimensions = {
        width: decoder.getActiveWidth(),
        height: decoder.getActiveHeight(),
        flip: decoder.getFlip(),
      }
      let unpacked = false
      const unpack = () => {
        if (!unpacked) {
          decoder.unpack()
          unpacked = true
        }
      }
      const camera = decoder.getIParams()
      return {
        metadata: {
          make: camera.normalized_make,
          model: camera.normalized_model,
          rawWidth: decoder.getRawWidth(),
          rawHeight: decoder.getRawHeight(),
          left: decoder.getLeftMargin(),
          top: decoder.getTopMargin(),
          colors: decoder.getColors(),
          cfa: [decoder.color(0, 0), decoder.color(0, 1), decoder.color(1, 0), decoder.color(1, 1)],
        },
        dimensions,
        unpack,
        gpuSource: () => readGpuSource(decoder),
        display(halfSize = false) {
          // Quick fallback previews retain LibRaw's existing default curve.
          if (!halfSize) {
            decoder.setGamma(0, 1 / 2.4)
            decoder.setGamma(1, 12.92)
          }
          decoder.setHalfSize(Number(halfSize))
          unpack()
          decoder.dcrawProcess()
          const decoded = decoder.dcrawMakeMemImage()
          if (decoded.type_ !== 'LIBRAW_IMAGE_BITMAP' || decoded.bits !== 8 || decoded.colors !== 3)
            throw new Error('The RAW decoder returned an unsupported pixel format.')
          return { data: decoded.data, width: decoded.width, height: decoded.height }
        },
        linear(): LinearFrame {
          const { width, height, flip } = dimensions
          if (width * height * 16 > 384 * 1024 ** 2)
            throw new Error('This photo exceeds the linear processing memory limit.')
          const matrix = [0, 1, 2].flatMap((r) => [0, 1, 2, 3].map((c) => decoder.getRgbCam(r, c)))
          decoder.setOutputColor(0)
          decoder.setOutputBps(16)
          decoder.setGamma(0, 1)
          decoder.setGamma(1, 1)
          decoder.setNoAutoBright(1)
          unpack()
          decoder.dcrawProcess()
          const decoded = decoder.dcrawMakeMemImage()
          if (
            decoded.type_ !== 'LIBRAW_IMAGE_BITMAP' ||
            decoded.bits !== 16 ||
            decoded.colors !== 3 ||
            decoded.width * decoded.height !== width * height ||
            !matrix.every(Number.isFinite)
          )
            throw new Error('The decoder did not provide a supported linear camera frame.')
          const pixels = new Uint16Array(
            decoded.data.buffer,
            decoded.data.byteOffset,
            decoded.data.byteLength / 2,
          )
          const data = new Float32Array(width * height * 4)
          // LibRaw's public memory-image API includes orientation. Normalize its storage
          // to sensor coordinates here; the pipeline applies the final presentation flip.
          for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
              let sx = flip & 1 ? width - 1 - x : x,
                sy = flip & 2 ? height - 1 - y : y
              if (flip & 4) [sx, sy] = [sy, sx]
              const from = (sy * decoded.width + sx) * 3,
                to = (y * width + x) * 4
              for (let c = 0; c < 3; c++) data[to + c] = pixels[from + c] / 65535
              data[to + 3] = 1
            }
          return { data, width, height, flip, matrix }
        },
        close: () => decoder.dispose(),
      }
    } catch (error) {
      decoder.dispose()
      throw error
    }
  },
}
