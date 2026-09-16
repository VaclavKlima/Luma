import { LensCorrections } from './LensCorrections'
import { useState } from 'react'
import { ChevronDown, ChevronRight, Info, SlidersHorizontal, Sun, Thermometer } from 'lucide-react'
import type { Photo } from '../../../shared/contracts'
import styles from '../App.module.css'

export function Inspector({ photo }: { photo: Photo | null }) {
  const [lightOpen, setLightOpen] = useState(true)
  const [metadataOpen, setMetadataOpen] = useState(true)
  return (
    <aside className={styles.inspector} aria-label="Adjustments" data-testid="adjustments-panel">
      <div className={styles.panelHeading}>
        <h2>
          <SlidersHorizontal size={14} /> Adjustments
        </h2>
      </div>
      <div className={styles.inspectorScroll}>
        <p className={styles.demoNote}>
          Light and color editing will be available in a future version.
        </p>
        {photo && <LensCorrections key={photo.id} photoId={photo.id} />}
        <section className={styles.adjustmentSection}>
          <button
            className={styles.sectionToggle}
            aria-expanded={lightOpen}
            aria-controls="light-controls"
            onClick={() => setLightOpen(!lightOpen)}
          >
            <Sun size={14} />
            Light{lightOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          {lightOpen && (
            <div className={styles.sectionContent} id="light-controls">
              {['Exposure', 'Contrast', 'Highlights', 'Shadows', 'Whites', 'Blacks'].map(
                (label) => (
                  <div className={styles.sliderControl} key={label}>
                    <div className={styles.sliderLabel}>
                      <label htmlFor={`${label}-slider`}>{label}</label>
                      <span>—</span>
                    </div>
                    <input
                      className={styles.range}
                      type="range"
                      id={`${label}-slider`}
                      min={-100}
                      max={100}
                      value={0}
                      disabled
                    />
                  </div>
                ),
              )}
            </div>
          )}
        </section>
        <section className={styles.adjustmentSection}>
          <button className={styles.sectionToggle} disabled>
            <Thermometer size={14} />
            Color
          </button>
        </section>
        <section className={styles.adjustmentSection}>
          <button
            className={styles.sectionToggle}
            aria-expanded={metadataOpen}
            aria-controls="photo-metadata"
            onClick={() => setMetadataOpen(!metadataOpen)}
          >
            <Info size={14} />
            Metadata{metadataOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          {metadataOpen && (
            <div className={styles.sectionContent} id="photo-metadata">
              <dl className={styles.metadata} data-testid="photo-metadata">
                {Object.entries({
                  Filename: photo?.filename,
                  Camera: photo?.camera,
                  Lens: photo?.lens,
                  Captured: photo?.capturedAt,
                  Dimensions: photo ? `${photo.width} × ${photo.height}` : undefined,
                  Format: photo?.format,
                  Aperture: photo?.aperture,
                  Shutter: photo?.shutter,
                  ISO: photo?.iso,
                  Focal: photo?.focalLength,
                  'Quick preview': photo
                    ? photo.previewSource === 'decoded'
                      ? 'Rendered from RAW · sRGB'
                      : photo.previewSource === 'embedded'
                        ? 'Embedded preview · sRGB'
                        : 'sRGB'
                    : undefined,
                }).map(([label, value]) => (
                  <MetadataRow key={label} label={label} value={value} />
                ))}
              </dl>
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}

function MetadataRow({ label, value }: { label: string; value?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value || '—'}</dd>
    </>
  )
}
