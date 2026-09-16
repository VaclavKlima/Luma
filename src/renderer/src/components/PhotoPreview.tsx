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
  total,
  position,
  onNavigate,
  onImport,
  onContextMenu,
}: Props) {
  const viewport = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLCanvasElement>(null)
  const [model, setModel] = useState<Model>({
    loaded: false,
    image: { width: photo?.width ?? 0, height: photo?.height ?? 0 },
    viewport: { width: 0, height: 0 },
    view: INITIAL_VIEW,
  })
  const current = useRef(model)
  const full = useFullPreview(photo?.id)
  const [displayedUrl, setDisplayedUrl] = useState('')
  const fullVisible = Boolean(full.preview && displayedUrl === full.preview.url)
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
  const displayCanvas = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      image.current = canvas
      if (!canvas || !renderedFrame || !pixels) return
      try {
        const context = canvas.getContext('2d', { colorSpace: 'srgb' })
        if (!context) throw new Error('Canvas is unavailable')
        canvas.width = renderedFrame.width
        canvas.height = renderedFrame.height
        context.drawImage(pixels, 0, 0)
        const dimensions = { width: canvas.width, height: canvas.height }
        setDisplayedUrl(renderedFrame.url)
        change((model) => ({
          ...model,
          loaded: true,
          image: dimensions,
          view: replaceDimensions(model.view, model.image, dimensions, model.viewport),
        }))
      } catch {
        displayFailed()
      }
    },
    [renderedFrame, pixels, change, displayFailed],
  )

  useEffect(() => {
    const canvas = image.current
    return () => {
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
    }
  }, [])

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
    if (event.key === '+' || event.key === '=') step(1)
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
                ref={displayCanvas}
                className={styles.image}
                role="img"
                aria-label={photo.filename}
                data-testid="main-preview"
                data-src={full.preview?.url}
                tabIndex={0}
                aria-keyshortcuts="+ - 0 1 ArrowLeft ArrowRight ArrowUp ArrowDown"
                style={{
                  width: model.image.width || undefined,
                  height: model.image.height || undefined,
                  visibility: fullVisible && ready ? 'visible' : 'hidden',
                  transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                }}
              />
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
                'Full resolution'
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
          <button aria-label="Zoom in" disabled={!ready || view.scale >= 4} onClick={() => step(1)}>
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
