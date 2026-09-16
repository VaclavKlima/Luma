import { useEffect, useRef, useState } from 'react'
import { correctionKinds, type CorrectionKind, type LensState } from '../../../shared/lens'
import styles from '../App.module.css'

const labels: Record<CorrectionKind, string> = {
  distortion: 'Distortion',
  vignetting: 'Vignetting',
  chromaticAberration: 'Lateral chromatic aberration',
}

export function LensCorrections({ photoId }: { photoId: string }) {
  const [state, setState] = useState<LensState | null>(null)
  const [error, setError] = useState('')
  const pending = useRef(0)
  useEffect(() => {
    let active = true
    const refresh = () => {
      void window.luma
        .getLensSettings(photoId)
        .then((next) => {
          if (active && pending.current === 0)
            setState((previous) =>
              !previous || next.revision >= previous.revision ? next : previous,
            )
        })
        .catch((error: unknown) => {
          if (active) setError(String(error))
        })
    }
    refresh()
    const unsubscribe = window.luma.onLibraryEvent((event) => {
      if (event.lensChanged?.photoId === photoId) refresh()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [photoId])
  const update = async (kind: CorrectionKind, enabled: boolean) => {
    setError('')
    pending.current++
    setState((previous) =>
      previous ? { ...previous, settings: { ...previous.settings, [kind]: enabled } } : previous,
    )
    try {
      await window.luma.updateLensSettings(photoId, kind, enabled)
    } catch (error) {
      setError(String(error))
    } finally {
      pending.current--
      if (pending.current === 0) {
        try {
          const next = await window.luma.getLensSettings(photoId)
          if (pending.current === 0)
            setState((previous) =>
              !previous || next.revision >= previous.revision ? next : previous,
            )
        } catch (error) {
          setError(String(error))
        }
      }
    }
  }

  return (
    <section className={styles.adjustmentSection} aria-labelledby="lens-heading">
      <h3 id="lens-heading" className={styles.lensHeading}>
        Lens corrections
      </h3>
      <div
        className={styles.sectionContent}
        data-testid="lens-corrections"
        data-revision={state?.revision}
      >
        <p className={styles.lensProfile}>{state?.profile.label ?? 'Reading lens metadata…'}</p>
        {correctionKinds.map((kind) => (
          <div key={kind} className={styles.lensCorrection}>
            <label>
              <input
                type="checkbox"
                checked={!!state?.settings[kind] && !!state.profile[kind]}
                disabled={!state?.profile[kind]}
                aria-describedby={!state?.profile[kind] ? `lens-${kind}-reason` : undefined}
                onChange={(event) => void update(kind, event.target.checked)}
              />
              {labels[kind]}
            </label>
            {state?.profile.unavailable[kind] && (
              <p id={`lens-${kind}-reason`}>{state.profile.unavailable[kind]}</p>
            )}
          </div>
        ))}
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
  )
}
