import { useCallback, useEffect, useRef, useState } from 'react'
import {
  neutralAdjustments,
  type WorkingFrame,
  type AdjustmentParameters,
} from '../../../shared/adjustments'
import {
  adjustHdr,
  hdrAdjustmentMatrix,
  luminance,
  outputHdr,
  type DisplayTarget,
} from '../../../shared/hdr'
import type { HdrAnalysisDomain } from '../../../shared/hdr-statistics'
import { streamHdr } from '../preview/hdr-stream'
export function useHdrPixel(
  frame: WorkingFrame | null,
  parameters: AdjustmentParameters,
  target: DisplayTarget,
  domain: HdrAnalysisDomain,
) {
  const [readout, setReadout] = useState({ key: '', value: '' })
  const pending = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const key = JSON.stringify(parameters)
  const identity = `${frame?.identity}:${key}:${domain}:${domain === 'output' ? target.generation : ''}`
  useEffect(() => {
    return () => {
      pending.current?.abort()
      clearTimeout(timer.current)
    }
  }, [frame, key, target, domain])
  const inspect = useCallback(
    (x: number, y: number, before = false) => {
      pending.current?.abort()
      clearTimeout(timer.current)
      if (!frame?.hdr || x < 0 || y < 0 || x >= frame.width || y >= frame.height) return
      const asset = frame.hdr,
        abort = new AbortController()
      pending.current = abort
      timer.current = setTimeout(() => {
        void (async () => {
          const px = Math.floor(x),
            py = Math.floor(y)
          for await (const { data, row } of streamHdr(asset, abort.signal, Math.floor(py / 64))) {
            const index = ((py - row) * asset.width + px) * 4
            const p = before ? neutralAdjustments : (JSON.parse(key) as AdjustmentParameters)
            const rgb = adjustHdr(
              [data[index], data[index + 1], data[index + 2]],
              p,
              hdrAdjustmentMatrix(p, asset.whiteBalance) ?? undefined,
            )
            const output = outputHdr(rgb, target),
              values = domain === 'working-hdr' ? rgb : output.rgb
            const y = domain === 'working-hdr' ? luminance(rgb) : output.luminance
            if (!abort.signal.aborted)
              setReadout({
                key: identity,
                value: `${before ? 'Before' : 'After'} · ${domain === 'working-hdr' ? 'Working HDR · Rec.2020' : `Output · ${target.colorSpace}`} · ${px}, ${py} · RGB ${values.map((v) => v.toFixed(4)).join(', ')} · ${y.toFixed(4)}× white · ${y > 0 ? `${Math.log2(y).toFixed(2)} stops` : y === 0 ? 'zero luminance' : 'negative luminance'} · α ${data[index + 3].toFixed(2)}`,
              })
          }
        })().catch((error) => {
          if (!abort.signal.aborted)
            setReadout({ key: identity, value: `Pixel inspection unavailable: ${String(error)}` })
        })
      }, 100)
    },
    [frame, key, target, domain, identity],
  )
  return { inspect, readout: readout.key === identity ? readout.value : '' }
}
