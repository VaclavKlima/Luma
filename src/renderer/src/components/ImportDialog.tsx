import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, FileImage, FolderOpen, Images, X } from 'lucide-react'
import { PAGE_SIZE, type ImportCandidate, type ImportReview } from '../../../shared/contracts'
import styles from '../App.module.css'

export function ImportDialog({
  onClose,
  onStarted,
}: {
  onClose: () => void
  onStarted: (sessionId: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [review, setReview] = useState<ImportReview | null>(null)
  const [offset, setOffset] = useState(0)
  const [recursive, setRecursive] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const scanning = review?.phase === 'scanning'
  const importing = review?.phase === 'importing'
  const busy = pending || scanning || importing
  const terminal = review?.phase === 'complete' || review?.phase === 'cancelled'

  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const refresh = useCallback(async () => {
    if (sessionId) setReview(await window.luma.getReview(sessionId, offset))
  }, [sessionId, offset])
  useEffect(() => {
    let active = true
    const update = () => {
      if (sessionId)
        void window.luma.getReview(sessionId, offset).then(
          (value) => {
            if (active) setReview(value)
          },
          (error) => {
            if (active) setError(String(error))
          },
        )
    }
    update()
    const unsubscribe = window.luma.onLibraryEvent((event) => {
      if (event.sessionId === sessionId) update()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [sessionId, offset])

  async function action(work: () => Promise<void>) {
    setPending(true)
    setError('')
    try {
      await work()
    } catch (error) {
      setError(String(error))
    } finally {
      setPending(false)
    }
  }
  function choose(kind: 'files' | 'folder') {
    void action(async () => {
      const id = await window.luma.chooseSource(kind, recursive)
      if (id) {
        setReview(null)
        setOffset(0)
        setSessionId(id)
      }
    })
  }
  function close() {
    if (pending) return
    void action(async () => {
      if (sessionId) {
        await window.luma.cancelImport(sessionId)
        await window.luma.disposeImport(sessionId)
      }
      dialog.current?.close()
      onClose()
    })
  }

  function toggle(candidate: ImportCandidate, selected: boolean) {
    setReview((current) =>
      current
        ? {
            ...current,
            candidates: current.candidates.map((item) =>
              item.id === candidate.id ? { ...item, selected } : item,
            ),
            selected: current.selected + (selected ? 1 : -1),
            selectedBytes: current.selectedBytes + (selected ? candidate.bytes : -candidate.bytes),
          }
        : current,
    )
    void action(async () => {
      try {
        await window.luma.selectCandidates(sessionId!, [candidate.id], selected)
      } finally {
        await refresh()
      }
    })
  }

  return (
    <dialog
      ref={dialog}
      className={styles.importDialog}
      aria-labelledby="import-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <header className={styles.importHeader}>
        <div>
          <h1 id="import-title">Import photographs</h1>
          <p>Review your selection. Originals will be copied into your library.</p>
        </div>
        <button
          className={styles.iconButton}
          onClick={close}
          disabled={pending}
          aria-label="Close import"
        >
          <X size={18} />
        </button>
      </header>
      <div className={styles.importSources}>
        <button className={styles.secondaryButton} disabled={busy} onClick={() => choose('files')}>
          <Images size={15} /> Choose photos
        </button>
        <button className={styles.secondaryButton} disabled={busy} onClick={() => choose('folder')}>
          <FolderOpen size={15} /> Choose folder
        </button>
        <label>
          <input
            type="checkbox"
            checked={recursive}
            disabled={busy}
            onChange={(event) => setRecursive(event.target.checked)}
          />{' '}
          Include subfolders
        </label>
      </div>
      {error && (
        <p className={styles.errorBanner} role="alert">
          {error}
        </p>
      )}
      {review ? (
        <>
          <div className={styles.importSummary} role="status" data-testid="import-status">
            <strong>
              {scanning
                ? 'Scanning and generating previews…'
                : importing
                  ? 'Copying originals…'
                  : terminal
                    ? review.phase === 'cancelled'
                      ? 'Import cancelled'
                      : 'Import complete'
                    : 'Ready to import'}
            </strong>
            <span>
              {review.total} found · {review.ready} new · {review.duplicates} duplicates ·{' '}
              {review.errors} errors · {review.imported} imported
              {review.skipped ? ` · ${review.skipped} skipped` : ''}
            </span>
            <span className={styles.importSourceName}>{review.source}</span>
          </div>
          <div className={styles.importSelection}>
            <button
              disabled={busy || terminal}
              onClick={() =>
                void action(async () => {
                  await window.luma.selectCandidates(sessionId!, null, true)
                  await refresh()
                })
              }
            >
              Select all
            </button>
            <button
              disabled={busy || terminal}
              onClick={() =>
                void action(async () => {
                  await window.luma.selectCandidates(sessionId!, null, false)
                  await refresh()
                })
              }
            >
              Deselect all
            </button>
            <span>
              {review.selected} selected · {formatBytes(review.selectedBytes)}
            </span>
          </div>
          <div className={styles.importGrid} aria-label="Import candidates">
            {review.candidates.map((candidate) => (
              <label
                key={candidate.id}
                className={`${styles.importCard} ${candidate.selected ? styles.importSelected : ''}`}
                title={candidate.relativePath}
              >
                <div className={styles.importThumbnail}>
                  {candidate.thumbnailUrl ? (
                    <img src={candidate.thumbnailUrl} alt="" loading="lazy" />
                  ) : (
                    <FileImage size={30} strokeWidth={1} />
                  )}
                  <input
                    type="checkbox"
                    aria-label={`Import ${candidate.filename}`}
                    checked={candidate.selected}
                    disabled={busy || terminal || candidate.status !== 'ready'}
                    onChange={(event) => toggle(candidate, event.target.checked)}
                  />
                </div>
                <strong>{candidate.filename}</strong>
                <span>
                  {candidate.message ??
                    (candidate.status === 'imported'
                      ? 'Imported'
                      : candidate.status === 'processing'
                        ? 'Generating preview…'
                        : formatBytes(candidate.bytes))}
                </span>
              </label>
            ))}
            {!review.total && !scanning && (
              <p className={styles.importEmpty}>No supported photographs found in this folder.</p>
            )}
          </div>
          {review.total > PAGE_SIZE && (
            <nav className={styles.pageControls} aria-label="Import pages">
              <button disabled={offset === 0} onClick={() => setOffset(offset - PAGE_SIZE)}>
                Previous
              </button>
              <span>
                {Math.floor(offset / PAGE_SIZE) + 1} / {Math.ceil(review.total / PAGE_SIZE)}
              </span>
              <button
                disabled={offset + PAGE_SIZE >= review.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </button>
            </nav>
          )}
        </>
      ) : (
        <div className={styles.importEmpty}>
          <FolderOpen size={38} strokeWidth={1} />
          <h2>Start with a photo or a folder</h2>
          <p>JPEG, PNG, TIFF, and Sony ARW files are supported.</p>
          <p>All new photographs are selected by default.</p>
        </div>
      )}
      <footer className={styles.importFooter}>
        <span>
          {scanning || importing
            ? 'You can cancel; completed imports will stay in your library.'
            : 'Original files stay untouched.'}
        </span>
        <button className={styles.secondaryButton} disabled={pending} onClick={close}>
          {terminal ? 'Done' : 'Cancel'}
        </button>
        {!terminal && (
          <button
            className={styles.primaryButton}
            disabled={busy || !review?.selected}
            onClick={() =>
              void action(async () => {
                await window.luma.importSelected(sessionId!)
                dialog.current?.close()
                onStarted(sessionId!)
              })
            }
          >
            <Check size={15} /> Import {review?.selected ?? 0} photos
          </button>
        )}
      </footer>
    </dialog>
  )
}

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
