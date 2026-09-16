import { Images, Plus } from 'lucide-react'
import { PAGE_SIZE, type Photo, type PhotoReference } from '../../../shared/contracts'
import type { SelectionModifiers } from '../hooks/useLibrary'
import styles from '../App.module.css'

interface LibraryProps {
  photos: Photo[]
  total: number
  offset: number
  selectedIds: Map<string, PhotoReference>
  activeId: string | null
  onSelect: (photo: Photo, modifiers: SelectionModifiers) => void
  onContextMenu: (photo: Photo, element: HTMLElement, x: number, y: number) => void
  onImport: () => void
  onPage: (offset: number) => void
}

export function Library({
  photos,
  total,
  offset,
  selectedIds,
  activeId,
  onContextMenu,
  onSelect,
  onImport,
  onPage,
}: LibraryProps) {
  return (
    <aside
      className={styles.library}
      aria-label="Photo library"
      data-testid="photo-library"
      tabIndex={-1}
    >
      <div className={styles.panelHeading}>
        <h2>Library</h2>
        <button className={styles.iconButton} aria-label="Add photos" onClick={onImport}>
          <Plus size={15} />
        </button>
      </div>
      <div className={styles.libraryScroll}>
        <div className={styles.galleryHeading}>
          <span>
            <Images size={13} /> All photographs
          </span>
          <span className={styles.count}>{total}</span>
        </div>
        <p className={styles.selectionCount} role="status" data-testid="selection-count">
          {selectedIds.size} selected
        </p>
        <div className={styles.photoList}>
          {photos.map((photo, index) => (
            <button
              className={`${styles.photoCard} ${selectedIds.has(photo.id) ? styles.selectedPhoto : ''} ${activeId === photo.id ? styles.activePhoto : ''}`}
              key={photo.id}
              aria-label={`Select ${photo.filename}`}
              aria-pressed={selectedIds.has(photo.id)}
              aria-current={activeId === photo.id ? 'true' : undefined}
              data-testid={`photo-card-${photo.id}`}
              onClick={(event) =>
                onSelect(photo, { shift: event.shiftKey, toggle: event.ctrlKey || event.metaKey })
              }
              onContextMenu={(event) => {
                event.preventDefault()
                onContextMenu(photo, event.currentTarget, event.clientX, event.clientY)
              }}
              onKeyDown={(event) => {
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault()
                  const box = event.currentTarget.getBoundingClientRect()
                  onContextMenu(photo, event.currentTarget, box.left + 15, box.top + 15)
                }
              }}
            >
              <div className={styles.thumbnailFrame}>
                <img src={photo.thumbnailUrl} alt="" loading="lazy" draggable={false} />
                <span className={styles.photoNumber}>{offset + index + 1}</span>
                <span className={styles.photoFormat}>{photo.format}</span>
              </div>
              <span className={styles.thumbnailCaption}>
                <span>{photo.filename}</span>
                <span className={styles.selectionDot} aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>
        {total > PAGE_SIZE && (
          <nav className={styles.pageControls} aria-label="Library pages">
            <button disabled={offset === 0} onClick={() => onPage(offset - PAGE_SIZE)}>
              Previous
            </button>
            <span>
              {Math.floor(offset / PAGE_SIZE) + 1} / {Math.ceil(total / PAGE_SIZE)}
            </span>
            <button
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => onPage(offset + PAGE_SIZE)}
            >
              Next
            </button>
          </nav>
        )}
      </div>
      <div className={styles.libraryFooter}>
        <span className={styles.statusDot} /> Stored on this device
      </div>
    </aside>
  )
}
