import { useCallback, useMemo, useState } from 'react'
import type { ImageStatistics } from '../../../shared/statistics'
export type ComparisonMode = 'after' | 'before' | 'split'
export interface PreviewToolsState {
  mode: ComparisonMode
  split: number
  shadows: boolean
  highlights: boolean
  hover: 'shadows' | 'highlights' | null
  analysis?: ImageStatistics
}
const initial: PreviewToolsState = {
  mode: 'after',
  split: 0.5,
  shadows: false,
  highlights: false,
  hover: null,
}
export function usePreviewTools(photoId: string | undefined) {
  const [stored, setStored] = useState<{ id?: string; value: PreviewToolsState }>({
    value: initial,
  })
  const value = stored.id === photoId ? stored.value : initial
  const update = useCallback(
    (patch: Partial<PreviewToolsState>) => {
      setStored((previous) => ({
        id: photoId,
        value: { ...(previous.id === photoId ? previous.value : initial), ...patch },
      }))
    },
    [photoId],
  )
  const analyze = useCallback((analysis?: ImageStatistics) => update({ analysis }), [update])
  return useMemo(() => ({ ...value, update, analyze }), [value, update, analyze])
}
export type PreviewTools = ReturnType<typeof usePreviewTools>
