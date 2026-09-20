import { neutralAdjustments } from '../../../shared/adjustments'
import type { PreviewTools } from '../hooks/usePreviewTools'
import { usePreviewAnalysis, type ClippingMask } from '../hooks/usePreviewAnalysis'
import type { AdjustmentParameters } from '../../../shared/adjustments'
import { PreviewPresenter } from '../preview/presenter'
import { useWorkingPreview } from '../hooks/useWorkingPreview'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { ChevronLeft, ChevronRight, FileImage, Maximize, Minus, Monitor, Plus } from 'lucide-react'
import type { Photo } from '../../../shared/contracts'
import {
  constrain,
  INITIAL_VIEW,
  minimumScale,
  replaceDimensions,
  stepScale,
  wheelScale,
  zoomAt,
  ZOOM_STOPS,
  type Size,
  type View,
} from '../preview/geometry'
import layout from '../App.module.css'
import styles from './PhotoPreview.module.css'
import { useFullPreview } from '../hooks/useFullPreview'
import { ProgressSpinner } from './ProgressSpinner'

interface Model {
  loaded: boolean
  image: Size
  viewport: Size
  view: View
}
interface Props {
  tools: PreviewTools
  gesturing: boolean
  adjustments: AdjustmentParameters
  onEditingReady: (photoId: string | null) => void
  photo: Photo | null
  total: number
  position: number
  onNavigate: (direction: -1 | 1) => Promise<void>
  onImport: () => void
  onContextMenu: (photo: Photo, element: HTMLElement, x: number, y: number) => void
}

// The parent keys this component by photo ID so every new photograph starts in Fit.
export function PhotoPreview({
  photo,
  adjustments,
  tools,
  gesturing,
  onEditingReady,
  total,
  position,
  onNavigate,
  onImport,
  onContextMenu,
}: Props) {
  const overlay = useRef<HTMLCanvasElement>(null)
  const divider = useRef<HTMLDivElement>(null)
  const dividerPointer = useRef<number | null>(null)
  const [mask, setMask] = useState<ClippingMask>()
  const viewport = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLCanvasElement>(null)
  const restoreCanvasFocus = useRef(false)
  const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas) restoreCanvasFocus.current = document.activeElement === image.current
    image.current = canvas
    if (canvas && restoreCanvasFocus.current) {
      canvas.focus({ preventScroll: true })
      restoreCanvasFocus.current = false
    }
  }, [])
  const [model, setModel] = useState<Model>({
    loaded: false,
    image: { width: photo?.width ?? 0, height: photo?.height ?? 0 },
    viewport: { width: 0, height: 0 },
    view: INITIAL_VIEW,
  })
  const current = useRef(model)
  const full = useFullPreview(photo?.id)
  const [displayedUrl, setDisplayedUrl] = useState('')
  const [fallback, setFallback] = useState(false)
  const presenter = useRef<PreviewPresenter | null>(null)
  const fullVisible = Boolean(full.preview && displayedUrl)
  const live = useWorkingPreview(full.preview, fullVisible)
  const { working, generation } = live
  const { mode, split, analyze, update } = tools
  const shadows = tools.shadows || tools.hover === 'shadows'
  const highlights = tools.highlights || tools.hover === 'highlights'
  usePreviewAnalysis(
    working,
    `${photo?.id}-${working?.identity ?? 'pending'}-${generation}`,
    mode === 'before' ? neutralAdjustments : adjustments,
    shadows || highlights,
    gesturing,
    analyze,
    setMask,
  )
  useEffect(() => {
    if (gesturing && mode === 'before') update({ mode: 'after' })
  }, [gesturing, mode, update])
  const editingSurface = !!working
  const placeholderView = constrain(model.view, full.placeholder ?? model.image, model.viewport)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const change = useCallback((action: (model: Model) => Model) => {
    const next = action(current.current)
    next.view = constrain(next.view, next.image, next.viewport)
    current.current = next
    setModel(next)
  }, [])
  const ready = Boolean(
    photo &&
    model.loaded &&
    model.image.width &&
    model.viewport.width &&
    model.viewport.height &&
    !full.error,
  )
  const { view } = model
  const panX = model.image.width * view.scale > model.viewport.width + 0.5
  const panY = model.image.height * view.scale > model.viewport.height + 0.5
  const minimum = minimumScale(model.image, model.viewport)

  const stopDrag = useCallback(() => {
    if (
      dividerPointer.current !== null &&
      divider.current?.hasPointerCapture(dividerPointer.current)
    )
      divider.current.releasePointerCapture(dividerPointer.current)
    dividerPointer.current = null
    const pointer = drag.current
    drag.current = null
    if (pointer) {
      dragged.current = pointer.moved
      if (viewport.current?.hasPointerCapture(pointer.id))
        viewport.current.releasePointerCapture(pointer.id)
    }
    setDragging(false)
  }, [])
  useEffect(
    () =>
      window.luma.onLibraryEvent((event) => {
        if (event.lensChanged && event.lensChanged.photoId === photo?.id) stopDrag()
      }),
    [photo?.id, stopDrag],
  )

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      stopDrag()
      change((model) => ({
        ...model,
        viewport: { width: entry.contentRect.width, height: entry.contentRect.height },
      }))
    })
    observer.observe(element)
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const model = current.current
      if (!model.loaded || !model.image.width || !model.viewport.width || !model.viewport.height)
        return
      stopDrag()
      const box = element.getBoundingClientRect()
      change((model) => ({
        ...model,
        view: zoomAt(
          model.view,
          wheelScale(model.view.scale, event.deltaY, event.deltaMode, model.viewport.height),
          {
            x: event.clientX - box.left - box.width / 2,
            y: event.clientY - box.top - box.height / 2,
          },
          model.image,
          model.viewport,
        ),
      }))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    window.addEventListener('blur', stopDrag)
    return () => {
      observer.disconnect()
      element.removeEventListener('wheel', wheel)
      window.removeEventListener('blur', stopDrag)
    }
  }, [change, stopDrag])

  const { preview: renderedFrame, pixels, displayFailed } = full
  useEffect(() => {
    const canvas = image.current
    if (!canvas) return
    try {
      presenter.current = new PreviewPresenter(canvas, fallback || !editingSurface, () =>
        setFallback(true),
      )
    } catch {
      // Canvas capability checks can require replacing the DOM canvas with a 2D surface.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFallback(true)
    }
    return () => {
      presenter.current?.dispose()
      presenter.current = null
    }
  }, [fallback, generation, editingSurface])

  useEffect(() => {
    if (!renderedFrame || !pixels || !presenter.current) return
    try {
      if (!editingSurface || fallback) presenter.current.setBitmap(pixels)
      const dimensions = { width: renderedFrame.width, height: renderedFrame.height }
      // The decoded frame establishes authoritative dimensions after presentation upload.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDisplayedUrl(renderedFrame.url)
      change((model) => ({
        ...model,
        loaded: true,
        image: dimensions,
        view: replaceDimensions(model.view, model.image, dimensions, model.viewport),
      }))
    } catch {
      if (!fallback) setFallback(true)
      else displayFailed()
    }
  }, [renderedFrame, pixels, change, displayFailed, fallback, generation, editingSurface])

  useEffect(() => {
    try {
      if (working) presenter.current?.setWorking(working)
      onEditingReady(working ? (photo?.id ?? null) : null)
    } catch {
      // Canvas capability checks can require replacing the DOM canvas with a 2D surface.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFallback(true)
    }
    return () => onEditingReady(null)
  }, [working, fallback, generation, photo?.id, onEditingReady])

  useEffect(() => {
    const started = performance.now()
    const id = requestAnimationFrame(() => {
      presenter.current?.setComparison(mode, split)
      presenter.current?.draw(model.image, model.viewport, model.view, {
        whiteBalance: adjustments.whiteBalance,
        exposureEv: adjustments.exposureEv,
        contrast: adjustments.contrast,
        highlights: adjustments.highlights,
        shadows: adjustments.shadows,
        whites: adjustments.whites,
        blacks: adjustments.blacks,
      })
      performance.measure('luma.preview.presentation', {
        start: started,
        detail: {
          exposureEv: adjustments.exposureEv,
          contrast: adjustments.contrast,
          highlights: adjustments.highlights,
          shadows: adjustments.shadows,
          whites: adjustments.whites,
          blacks: adjustments.blacks,
          scale: model.view.scale,
        },
      })
    })
    return () => cancelAnimationFrame(id)
  }, [
    model,
    adjustments.exposureEv,
    adjustments.contrast,
    adjustments.highlights,
    adjustments.shadows,
    adjustments.whites,
    adjustments.blacks,
    adjustments.whiteBalance,
    mode,
    split,
    working,
    fallback,
    generation,
  ])

  useEffect(() => {
    const canvas = overlay.current,
      context = canvas?.getContext('2d')
    if (!canvas || !context) return
    canvas.width = Math.max(1, Math.round(model.viewport.width))
    canvas.height = Math.max(1, Math.round(model.viewport.height))
    context.clearRect(0, 0, canvas.width, canvas.height)
    if (!mask || !working) return
    const { image, viewport, view } = model
    let levelIndex = 0
    while (levelIndex + 1 < mask.levels.length && view.scale * 2 ** levelIndex < 1) levelIndex++
    const level = mask.levels[levelIndex]
    const left = (viewport.width - image.width * view.scale) / 2 + view.x,
      top = (viewport.height - image.height * view.scale) / 2 + view.y
    const pixelWidth = (image.width * view.scale) / level.width,
      pixelHeight = (image.height * view.scale) / level.height
    const sx = Math.max(0, Math.floor(-left / pixelWidth)),
      sy = Math.max(0, Math.floor(-top / pixelHeight))
    const width = Math.max(
      0,
      Math.min(level.width, Math.ceil((viewport.width - left) / pixelWidth)) - sx,
    )
    const height = Math.max(
      0,
      Math.min(level.height, Math.ceil((viewport.height - top) / pixelHeight)) - sy,
    )
    if (!width || !height) return
    const compact = document.createElement('canvas')
    compact.width = width
    compact.height = height
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const bits = level.data[(sy + y) * level.width + sx + x],
          i = (y * width + x) * 4
        if (highlights && bits & 2) {
          pixels[i] = 255
          pixels[i + 3] = 180
        } else if (shadows && bits & 1) {
          pixels[i + 2] = 255
          pixels[i + 3] = 180
        }
      }
    compact.getContext('2d')!.putImageData(new ImageData(pixels, width, height), 0, 0)
    context.save()
    if (mode === 'split') {
      context.beginPath()
      context.rect(canvas.width * split, 0, canvas.width, canvas.height)
      context.clip()
    }
    context.imageSmoothingEnabled = false
    context.drawImage(
      compact,
      left + sx * pixelWidth,
      top + sy * pixelHeight,
      width * pixelWidth,
      height * pixelHeight,
    )
    context.restore()
  }, [mask, model, mode, split, shadows, highlights, working])

  function fit() {
    stopDrag()
    change((model) => ({ ...model, view: INITIAL_VIEW }))
  }
  function zoom(scale: number, point = { x: 0, y: 0 }) {
    stopDrag()
    change((model) => ({
      ...model,
      view: zoomAt(model.view, scale, point, model.image, model.viewport),
    }))
  }
  function step(direction: -1 | 1) {
    zoom(
      stepScale(
        current.current.view.scale,
        direction,
        minimumScale(current.current.image, current.current.viewport),
      ),
    )
  }
  function keyDown(event: KeyboardEvent) {
    if (
      (event.target as HTMLElement).closest(
        'select, input, textarea, [contenteditable], [role="menu"]',
      )
    )
      return
    if (photo && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      event.preventDefault()
      stopDrag()
      const box = viewport.current!.getBoundingClientRect()
      onContextMenu(
        photo,
        image.current ?? (event.currentTarget as HTMLElement),
        box.left + 20,
        box.top + 20,
      )
      return
    }
    if (!ready || event.ctrlKey || event.metaKey || event.altKey) return
    if (working && event.key === '\\') update({ mode: mode === 'before' ? 'after' : 'before' })
    else if (working && event.key.toLowerCase() === 'y')
      update({ mode: mode === 'split' ? 'after' : 'split' })
    else if (working && event.key.toLowerCase() === 'j')
      update({
        shadows: !(tools.shadows && tools.highlights),
        highlights: !(tools.shadows && tools.highlights),
      })
    else if (event.key === '+' || event.key === '=') step(1)
    else if (event.key === '-') step(-1)
    else if (event.key === '0') fit()
    else if (event.key === '1') zoom(1)
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      const amount = event.shiftKey ? 120 : 40
      change((model) => ({
        ...model,
        view: {
          ...model.view,
          x:
            model.view.x +
            (event.key === 'ArrowLeft' ? amount : event.key === 'ArrowRight' ? -amount : 0),
          y:
            model.view.y +
            (event.key === 'ArrowUp' ? amount : event.key === 'ArrowDown' ? -amount : 0),
        },
      }))
    } else return
    event.preventDefault()
    event.stopPropagation()
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || !ready) return
    event.preventDefault()
    image.current?.focus({ preventScroll: true })
    dragged.current = false
    if (!panX && !panY) return
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const pointer = drag.current
    if (!pointer || pointer.id !== event.pointerId) return
    if (!(event.buttons & 1)) {
      stopDrag()
      return
    }
    const x = event.clientX - pointer.x
    const y = event.clientY - pointer.y
    pointer.moved ||= Math.abs(x) + Math.abs(y) > 2
    pointer.x = event.clientX
    pointer.y = event.clientY
    change((model) => ({
      ...model,
      view: { ...model.view, x: model.view.x + x, y: model.view.y + y },
    }))
  }
  const exactPreset = ZOOM_STOPS.some((stop) => Math.abs(stop - view.scale) < 0.00001)
  const zoomValue = view.fit
    ? 'fit'
    : exactPreset
      ? String(ZOOM_STOPS.find((stop) => Math.abs(stop - view.scale) < 0.00001))
      : 'custom'

  return (
    <section className={styles.preview} aria-label="Image preview" onKeyDown={keyDown}>
      <div className={layout.previewArea}>
        <div
          ref={viewport}
          className={`${styles.viewport} ${ready && (panX || panY) ? styles.pannable : ''} ${dragging ? styles.dragging : ''}`}
          data-testid="preview-viewport"
          data-mode={view.fit ? 'fit' : 'manual'}
          data-scale={view.scale}
          data-pan-x={view.x}
          data-pan-y={view.y}
          data-loading={Boolean(photo && !fullVisible && !full.error)}
          data-resolution={fullVisible ? 'full' : full.placeholder ? 'placeholder' : 'loading'}
          data-image-width={model.image.width}
          data-image-height={model.image.height}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={stopDrag}
          onPointerCancel={stopDrag}
          onLostPointerCapture={stopDrag}
          onDoubleClick={(event) => {
            if (!ready || dragged.current) return
            const box = event.currentTarget.getBoundingClientRect()
            if (current.current.view.fit)
              zoom(1, {
                x: event.clientX - box.left - box.width / 2,
                y: event.clientY - box.top - box.height / 2,
              })
            else fit()
          }}
          onContextMenu={(event) => {
            if (photo) {
              event.preventDefault()
              stopDrag()
              onContextMenu(
                photo,
                image.current ?? event.currentTarget,
                event.clientX,
                event.clientY,
              )
            }
          }}
        >
          {photo ? (
            <>
              <canvas
                key={`${fallback}-${generation}-${editingSurface}`}
                ref={attachCanvas}
                className={styles.canvas}
                role="img"
                aria-label={photo.filename}
                data-testid="main-preview"
                data-src={full.preview?.url}
                tabIndex={0}
                aria-keyshortcuts="+ - 0 1 ArrowLeft ArrowRight ArrowUp ArrowDown"
                style={{
                  width: model.viewport.width || undefined,
                  height: model.viewport.height || undefined,
                  visibility: fullVisible && ready ? 'visible' : 'hidden',
                }}
              />
              <canvas
                ref={overlay}
                className={styles.overlay}
                aria-hidden="true"
                data-testid="clipping-overlay"
              />
              {working && mode !== 'after' && <span className={styles.beforeLabel}>Before</span>}
              {working && mode === 'split' && (
                <>
                  <span className={styles.afterLabel}>After</span>
                  <div
                    ref={divider}
                    className={styles.divider}
                    style={{ left: `${split * 100}%` }}
                    role="slider"
                    tabIndex={0}
                    aria-label="Before and After divider"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(split * 100)}
                    aria-orientation="horizontal"
                    onPointerDown={(event) => {
                      event.stopPropagation()
                      event.preventDefault()
                      event.currentTarget.focus()
                      dividerPointer.current = event.pointerId
                      event.currentTarget.setPointerCapture(event.pointerId)
                    }}
                    onPointerMove={(event) => {
                      event.stopPropagation()
                      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                      const box = viewport.current!.getBoundingClientRect()
                      update({
                        split: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
                      })
                    }}
                    onPointerUp={(event) => {
                      event.stopPropagation()
                      if (event.currentTarget.hasPointerCapture(event.pointerId))
                        event.currentTarget.releasePointerCapture(event.pointerId)
                    }}
                    onPointerCancel={(event) => {
                      event.stopPropagation()
                      if (event.currentTarget.hasPointerCapture(event.pointerId))
                        event.currentTarget.releasePointerCapture(event.pointerId)
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                        event.preventDefault()
                        update({
                          split:
                            event.key === 'Home'
                              ? 0
                              : event.key === 'End'
                                ? 1
                                : Math.max(
                                    0,
                                    Math.min(1, split + (event.key === 'ArrowLeft' ? -0.01 : 0.01)),
                                  ),
                        })
                      }
                    }}
                  />
                </>
              )}
              {!fullVisible && full.placeholder?.placeholderUrl && (
                <img
                  className={`${styles.image} ${styles.placeholder}`}
                  src={full.placeholder.placeholderUrl}
                  alt=""
                  aria-hidden="true"
                  data-testid="preview-placeholder"
                  style={{
                    width: full.placeholder.width,
                    height: full.placeholder.height,
                    transform: `translate(-50%, -50%) translate(${placeholderView.x}px, ${placeholderView.y}px) scale(${placeholderView.scale})`,
                  }}
                />
              )}
              {!fullVisible && (
                <div className={styles.message} role={full.error ? 'alert' : 'status'}>
                  {full.error ? (
                    <span>Could not load this preview.</span>
                  ) : (
                    <>
                      <ProgressSpinner />
                      <span>Loading preview…</span>
                    </>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className={layout.emptyLibrary} data-testid="empty-library">
              <FileImage size={38} strokeWidth={1} />
              <h1>Your photographs, at home.</h1>
              <p>Choose photos or a folder to start your library.</p>
              <button className={layout.primaryButton} onClick={onImport}>
                Import your first photos
              </button>
              <span>JPEG · PNG · TIFF · Sony ARW</span>
            </div>
          )}
        </div>
        {photo && (
          <div className={layout.imageCaption}>
            <div>
              <span className={layout.photoTitle}>{photo.filename}</span>
              <span className={layout.photographer}>
                {photo.width} × {photo.height} · {photo.format}
              </span>
            </div>
            <span
              className={styles.resolution}
              data-testid="preview-resolution"
              role="status"
              title={
                full.error ??
                (fullVisible
                  ? `${model.image.width} × ${model.image.height} · sRGB · Original preserved`
                  : 'Loading the full-resolution image.')
              }
            >
              {full.error ? (
                <>
                  <span>Full resolution unavailable</span>
                  <button onClick={full.retry}>Retry</button>
                </>
              ) : fullVisible ? (
                live.error ? (
                  <>
                    <span>{live.error}</span>
                    <button onClick={live.retry}>Retry live preview</button>
                  </>
                ) : working ? (
                  'Full resolution'
                ) : (
                  'Preparing live preview…'
                )
              ) : (
                <>
                  <ProgressSpinner />
                  <span>Loading full resolution…</span>
                </>
              )}
            </span>
          </div>
        )}
      </div>
      <div className={`${layout.canvasToolbar} ${styles.toolbar}`}>
        <div className={layout.photoPagination}>
          <button
            className={layout.iconButton}
            aria-label="Previous photo"
            disabled={!photo || position <= 0}
            onClick={() => void onNavigate(-1)}
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            <strong>{String(photo ? position + 1 : 0).padStart(2, '0')}</strong>
            <span> / {String(total).padStart(2, '0')}</span>
          </span>
          <button
            className={layout.iconButton}
            aria-label="Next photo"
            disabled={!photo || position + 1 >= total}
            onClick={() => void onNavigate(1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div
          className={styles.zoomControls}
          data-testid="zoom-controls"
          title="100% shows one full-resolution image pixel per CSS pixel. Higher zoom enlarges it."
        >
          <button
            aria-label="Zoom out"
            disabled={!ready || view.scale <= minimum + 0.00001}
            onClick={() => step(-1)}
          >
            <Minus size={13} />
          </button>
          <select
            aria-label="Preview zoom"
            disabled={!ready}
            value={zoomValue}
            onChange={(event) => {
              if (event.target.value === 'fit') fit()
              else zoom(Number(event.target.value))
            }}
          >
            <option value="fit">Fit</option>
            {!exactPreset && !view.fit && (
              <option value="custom">{Math.round(view.scale * 100)}%</option>
            )}
            {ZOOM_STOPS.map((scale) => (
              <option key={scale} value={scale}>
                {scale * 100}%
              </option>
            ))}
          </select>
          <button
            aria-label="Zoom in"
            disabled={!ready || view.scale >= 32}
            onClick={() => step(1)}
          >
            <Plus size={13} />
          </button>
          <button aria-label="Fit preview" title="Fit preview (0)" disabled={!ready} onClick={fit}>
            <Maximize size={13} />
          </button>
        </div>
        <div className={layout.canvasInfo}>
          <Monitor size={12} />
          <span>sRGB</span>
          <span className={layout.toolbarDivider} />
          <span>8-bit</span>
        </div>
      </div>
    </section>
  )
}
