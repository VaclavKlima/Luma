import { useState } from 'react'
import type { PreviewTools } from '../hooks/usePreviewTools'
import layout from '../App.module.css'
import styles from './Histogram.module.css'
export function Histogram({ tools, ready }: { tools: PreviewTools; ready: boolean }) {
  const [open, setOpen] = useState(true),
    [bin, setBin] = useState(128)
  const data = tools.analysis
  const max = data ? Math.max(1, ...data.rgb.flat()) : 1
  const label = tools.mode === 'before' ? 'Before' : 'After'
  const percent = (count: number) => `${((100 * count) / (data?.visiblePixels || 1)).toFixed(2)}%`
  const readout = data
    ? `Value ${bin} · R ${percent(data.rgb[0][bin])} · G ${percent(data.rgb[1][bin])} · B ${percent(data.rgb[2][bin])}`
    : 'Preparing histogram…'
  return (
    <section className={layout.adjustmentSection}>
      <button
        className={layout.sectionToggle}
        aria-expanded={open}
        aria-controls="histogram"
        onClick={() => setOpen(!open)}
      >
        Histogram · {label}
      </button>
      {open && (
        <div id="histogram" className={styles.content}>
          <div className={styles.heading}>
            <span>sRGB · SDR</span>
            <span>Approximate · sampled</span>
          </div>
          <svg
            className={styles.plot}
            viewBox="0 0 256 96"
            preserveAspectRatio="none"
            role="slider"
            tabIndex={0}
            aria-label="Histogram tonal value"
            aria-valuemin={0}
            aria-valuemax={255}
            aria-valuenow={bin}
            aria-valuetext={readout}
            onPointerMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect()
              setBin(
                Math.max(
                  0,
                  Math.min(255, Math.floor(((event.clientX - box.left) / box.width) * 256)),
                ),
              )
            }}
            onKeyDown={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault()
                setBin(
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? 255
                      : Math.max(0, Math.min(255, bin + (event.key === 'ArrowLeft' ? -1 : 1))),
                )
              }
            }}
          >
            {data?.rgb.map((values, c) => (
              <path
                key={c}
                fill={['#d97676', '#75b483', '#779aca'][c]}
                fillOpacity="0.4"
                stroke={['#d97676', '#75b483', '#779aca'][c]}
                strokeWidth="0.6"
                d={`M0,96 ${values.map((count, i) => `L${i},${96 - (count / max) * 94}`).join(' ')} L255,96Z`}
              />
            ))}
            <line x1={bin} x2={bin} y1={0} y2={96} stroke="#aaa" strokeWidth="0.5" />
          </svg>
          <div className={styles.readout}>{readout}</div>
          <div className={styles.indicators}>
            {(['shadows', 'highlights'] as const).map((kind) => {
              const count = data
                ? kind === 'shadows'
                  ? data.shadowClipped
                  : data.highlightClipped
                : 0
              return (
                <button
                  key={kind}
                  disabled={!ready}
                  aria-pressed={tools[kind]}
                  aria-label={`${kind === 'shadows' ? 'Shadow' : 'Highlight'} clipping`}
                  title={`${count} sampled pixels (${percent(count)} approximately). SDR display endpoints; not proof of lost RAW sensor data.`}
                  onPointerEnter={() => tools.update({ hover: kind })}
                  onPointerLeave={() => tools.update({ hover: null })}
                  onFocus={() => tools.update({ hover: kind })}
                  onBlur={() => tools.update({ hover: null })}
                  onClick={() => tools.update({ [kind]: !tools[kind] })}
                >
                  {kind === 'shadows' ? '◀ Shadows' : 'Highlights ▶'}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}
