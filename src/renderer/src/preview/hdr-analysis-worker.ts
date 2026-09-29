import type { AdjustmentParameters } from '../../../shared/adjustments'
import type { DisplayTarget, HdrWorkingAsset } from '../../../shared/hdr'
import {
  analyzeHdr,
  hdrStatistics,
  reduceHdrMask,
  type HdrAnalysisDomain,
} from '../../../shared/hdr-statistics'
import { streamHdr } from './hdr-stream'
interface Request {
  parameters: AdjustmentParameters
  target: DisplayTarget
  domain: HdrAnalysisDomain
  generation: number
  masks: boolean
}
let asset: HdrWorkingAsset | undefined,
  sample: Float32Array<ArrayBuffer> | undefined,
  latest: Request | undefined
let running = false
self.onmessage = ({
  data,
}: MessageEvent<{
  asset?: HdrWorkingAsset
  request?: Request
  sample?: Float32Array<ArrayBuffer>
}>) => {
  if (data.asset) {
    asset = data.asset
  }
  if (data.sample) {
    sample = data.sample
    if (!running) void run()
  }
  if (data.request) {
    latest = data.request
    if (sample && !running) void run()
  }
}
async function run() {
  running = true
  while (latest && sample && asset) {
    const request = latest
    latest = undefined
    try {
      const statistics = hdrStatistics(request.domain, request.target, asset, false)
      analyzeHdr(sample, request.parameters, asset, request.target, statistics)
      self.postMessage({ statistics, generation: request.generation })
      if (request.masks) {
        const mask = new Uint8Array(asset.width * asset.height)
        const ignored = hdrStatistics(request.domain, request.target, asset)
        for await (const { data, row } of streamHdr(asset)) {
          if (latest) break
          analyzeHdr(
            data,
            request.parameters,
            asset,
            request.target,
            ignored,
            mask,
            row * asset.width,
          )
        }
        if (!latest) {
          const pyramid = reduceHdrMask(mask, asset.width, asset.height)
          self.postMessage(
            { mask: pyramid, generation: request.generation },
            { transfer: pyramid.levels.map((level) => level.data.buffer) },
          )
        }
      }
    } catch (error) {
      self.postMessage({ error: String(error), generation: request.generation })
    }
  }
  running = false
}
