import { useCallback, useEffect, useRef, useState } from 'react'
import type { FullPreview } from '../../../shared/contracts'
import { cachedFrame, loadFrame, type FrameLease } from '../preview/frame-cache'

interface State {
  preview: FullPreview | null
  pixels: ImageBitmap | null
  placeholder: FullPreview | null
  error: string | null
}
const empty: State = { preview: null, pixels: null, placeholder: null, error: null }

export function useFullPreview(photoId: string | undefined) {
  const latestRevision = useRef(0)
  const displayedLease = useRef<FrameLease | null>(null)
  useEffect(
    () => () => {
      displayedLease.current?.release()
    },
    [],
  )
  const regenerateRevision = useRef(0)
  const [revision, setRevision] = useState(0)
  useEffect(
    () =>
      window.luma.onLibraryEvent((event) => {
        if (event.editsChanged && event.editsChanged.photoId === photoId) {
          latestRevision.current = event.editsChanged.revision
          setRevision(event.editsChanged.revision)
          if (event.lensChanged) setState(empty)
        }
      }),
    [photoId],
  )
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<State>(empty)
  useEffect(() => {
    if (!photoId) return
    const regenerate = attempt > 0 && revision === regenerateRevision.current
    const requestId = crypto.randomUUID()
    const abort = new AbortController()
    let cancelled = false
    let frame: FrameLease | undefined
    void (async () => {
      const started = performance.now()
      try {
        let preview = !regenerate
          ? await window.luma.requestCachedFullPreview(photoId, requestId)
          : null
        if (cancelled) return
        if (!preview) preview = await window.luma.requestFullPreview(photoId, requestId, regenerate)
        if (cancelled) return
        if ((preview.settingsRevision ?? 0) < latestRevision.current) return
        if (preview.photoId !== photoId || preview.requestId !== requestId)
          throw new Error('The preview response does not match this photo.')
        frame = cachedFrame(preview) ?? undefined
        if (!frame) {
          // The placeholder and frame share the exact rendering revision.
          setState((previous) => (previous.pixels ? previous : { ...empty, placeholder: preview }))
          frame = await loadFrame(preview, abort.signal)
        }
        if (cancelled || (preview.settingsRevision ?? 0) < latestRevision.current) {
          frame.release()
          return
        }
        displayedLease.current?.release()
        displayedLease.current = frame
        setState({ preview, pixels: frame.bitmap, placeholder: null, error: null })
        performance.measure('luma.full-preview.load', {
          start: started,
          detail: { photoId, renderId: preview.renderId },
        })
      } catch (error) {
        // An edit can cancel main-process work before React cleans up this effect.
        // A superseded request must not replace the working preview with an error.
        if (!cancelled && revision >= latestRevision.current) {
          setState((state) => ({
            ...state,
            preview: null,
            pixels: null,
            error: error instanceof Error ? error.message : String(error),
          }))
          void window.luma.releaseFullPreview(requestId).catch(() => undefined)
        }
      }
    })()
    return () => {
      cancelled = true
      abort.abort()
      if (frame && frame !== displayedLease.current) frame.release()
      void window.luma.releaseFullPreview(requestId).catch(() => undefined)
    }
  }, [photoId, attempt, revision])

  const retry = useCallback(() => {
    regenerateRevision.current = latestRevision.current
    setState(empty)
    setAttempt((value) => value + 1)
  }, [])
  const displayFailed = useCallback(
    () =>
      setState((state) => ({
        ...state,
        preview: null,
        pixels: null,
        error: 'The full-resolution image could not be displayed.',
      })),
    [],
  )
  return {
    ...state,
    retry,
    displayFailed,
  }
}
