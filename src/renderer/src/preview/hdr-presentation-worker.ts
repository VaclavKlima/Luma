import { neutralAdjustments, type AdjustmentParameters } from '../../../shared/adjustments'
import {
  adjustHdr,
  hdrAdjustmentMatrix,
  outputHdr,
  encodeHdr,
  SDR_TARGET,
  type HdrWorkingAsset,
} from '../../../shared/hdr'
import { collectHdrSample } from './hdr-sample'
import { streamHdr } from './hdr-stream'
interface Request {
  asset: HdrWorkingAsset
  parameters: AdjustmentParameters
  generation: number
}
let pending: Request | undefined
let busy = false
self.onmessage = ({ data }: MessageEvent<Request>) => {
  pending = data
  if (!busy) void run()
}
async function run() {
  busy = true
  while (pending) {
    const request = pending
    pending = undefined
    try {
      const { asset, parameters, generation } = request
      if (asset.width * asset.height * 16 + 64 * 1024 ** 2 > 512 * 1024 ** 2)
        throw new Error('CPU presentation exceeds its memory limit.')
      const after = new Uint8ClampedArray(asset.width * asset.height * 4),
        before = new Uint8ClampedArray(after.length)
      const sample = collectHdrSample(asset)
      const wb = hdrAdjustmentMatrix(parameters, asset.whiteBalance) ?? undefined
      for await (const { data, row } of streamHdr(asset)) {
        if (pending) break
        sample.add(data, row)
        for (let i = 0; i < data.length; i += 4) {
          const rgb: [number, number, number] = [data[i], data[i + 1], data[i + 2]]
          const a = outputHdr(adjustHdr(rgb, parameters, wb), SDR_TARGET).rgb
          const b = outputHdr(adjustHdr(rgb, neutralAdjustments), SDR_TARGET).rgb
          const at = row * asset.width * 4 + i
          for (let c = 0; c < 3; c++) {
            after[at + c] = Math.round(encodeHdr(a[c]) * 255)
            before[at + c] = Math.round(encodeHdr(b[c]) * 255)
          }
          after[at + 3] = before[at + 3] = Math.round(data[i + 3] * 255)
        }
      }
      if (pending) continue
      const bitmap = await createImageBitmap(new ImageData(after, asset.width, asset.height))
      const neutral = await createImageBitmap(new ImageData(before, asset.width, asset.height))
      self.postMessage(
        { bitmap, neutral, generation, sample: sample.sample },
        { transfer: [bitmap, neutral, sample.sample.buffer] },
      )
    } catch (error) {
      self.postMessage({ error: String(error), generation: request.generation })
    }
  }
  busy = false
}
