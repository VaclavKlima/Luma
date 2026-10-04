import { useLayoutEffect, useRef } from 'react'
import { Trash2, Layers } from 'lucide-react'
import { mergeUnavailable, type MergeMode } from '../../../shared/merge'
import styles from './PhotoActions.module.css'

export function PhotoContextMenu({
  x,
  y,
  count,
  onDelete,
  onMerge,
  onClose,
}: {
  x: number
  y: number
  count: number
  onDelete: () => void
  onMerge: (mode: MergeMode) => void
  onClose: (restoreFocus?: boolean) => void
}) {
  const menu = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = menu.current!
    const box = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`
    element.style.top = `${Math.max(8, Math.min(y, innerHeight - box.height - 8))}px`
    element.querySelectorAll('button').item(2)?.focus()
    const outside = (event: PointerEvent) => {
      if (!element.contains(event.target as Node)) onClose(false)
    }
    const resize = () => onClose(true)
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', resize)
    }
  }, [x, y, onClose])
  return (
    <div
      ref={menu}
      role="menu"
      aria-label="Photo actions"
      className={styles.menu}
      style={{ left: x, top: y }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault()
          onClose(true)
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const buttons = Array.from(menu.current?.querySelectorAll('button') ?? [])
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
          buttons[
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
          ]?.focus()
        }
      }}
    >
      {(['hdr', 'noise'] as const).map((mode) => (
        <button
          key={mode}
          role="menuitem"
          aria-disabled={!!mergeUnavailable(count)}
          title={mergeUnavailable(count)}
          aria-describedby={mergeUnavailable(count) ? 'merge-unavailable' : undefined}
          onClick={() => {
            if (!mergeUnavailable(count)) onMerge(mode)
          }}
        >
          <Layers size={14} />
          {mode === 'hdr' ? 'Merge to HDR…' : 'Stack for noise reduction…'}
        </button>
      ))}
      {mergeUnavailable(count) && <p id="merge-unavailable">{mergeUnavailable(count)}</p>}
      <button
        role="menuitem"
        aria-disabled={count === 0}
        onClick={() => {
          if (count) onDelete()
        }}
      >
        <Trash2 size={14} />
        {count === 1 ? 'Delete photo…' : `Delete ${count} photos…`}
        <kbd>Del</kbd>
      </button>
    </div>
  )
}
