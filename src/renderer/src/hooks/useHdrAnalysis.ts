import { observeHdrSample, reuseHdrContent } from '../preview/hdr-sample'
import { useEffect, useRef, useState } from 'react'
import type { WorkingFrame, AdjustmentParameters } from '../../../shared/adjustments'
import { SDR_TARGET, type DisplayTarget } from '../../../shared/hdr'
import type { HdrAnalysisDomain, HdrStatistics } from '../../../shared/hdr-statistics'
import type { ClippingMask } from './usePreviewAnalysis'
export function useHdrAnalysis(
  frame: WorkingFrame | null,
  parameters: AdjustmentParameters,
  target: DisplayTarget,
  domain: HdrAnalysisDomain,
  masks: boolean,
  statistics: (result?: HdrStatistics) => void,
  mask: (result?: ClippingMask) => void,
  gesturing = false,
  sampleStatistics = true,
) {
  const [failure, setFailure] = useState<{ generation: number; message: string }>()
  const worker = useRef<Worker | null>(null),
    generation = useRef(0)
  useEffect(() => {
    if (!frame?.hdr) return
    const instance = new Worker(new URL('../preview/hdr-analysis-worker.ts', import.meta.url), {
      type: 'module',
    })
    const unsubscribe = observeHdrSample(frame.hdr.sha256, (sample, draftSample) =>
      instance.postMessage({ sample, draftSample }),
    )
    worker.current = instance
    instance.postMessage({ asset: frame.hdr })
    instance.onmessage = ({ data }) => {
      if (data.error && (data.generation === undefined || data.generation === generation.current))
        setFailure({ generation: generation.current, message: data.error })
      if (data.generation !== generation.current) return
      if (data.statistics && sampleStatistics) {
        setFailure(undefined)
        statistics(
          domain === 'content-hdr'
            ? reuseHdrContent(frame.hdr!.sha256, data.parameters, data.statistics)
            : data.statistics,
        )
      }
      if (data.mask) mask(data.mask)
    }
    return () => {
      unsubscribe()
      instance.terminate()
      worker.current = null
    }
  }, [frame, statistics, mask, sampleStatistics, domain])
  const key = JSON.stringify(parameters)
  const selectedTarget = domain === 'working-hdr' ? SDR_TARGET : target
  useEffect(() => {
    if (!frame?.hdr) return
    const current = ++generation.current
    mask(undefined)
    if (!sampleStatistics && !masks) return
    worker.current?.postMessage({
      request: {
        parameters: JSON.parse(key),
        target: selectedTarget,
        domain,
        masks,
        generation: current,
        sampleCount: gesturing ? 8192 : 65536,
        sampleStatistics,
      },
    })
  }, [frame, key, selectedTarget, domain, masks, mask, statistics, gesturing, sampleStatistics])
  return failure?.message
}
