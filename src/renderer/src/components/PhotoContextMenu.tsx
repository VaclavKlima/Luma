import { useLayoutEffect, useRef } from 'react'
import { Trash2 } from 'lucide-react'
import styles from './PhotoActions.module.css'

export function PhotoContextMenu({
  x,
  y,
  count,
  onDelete,
  onClose,
}: {
  x: number
  y: number
  count: number
  onDelete: () => void
  onClose: (restoreFocus?: boolean) => void
}) {
  const menu = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = menu.current!
    const box = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`
    element.style.top = `${Math.max(8, Math.min(y, innerHeight - box.height - 8))}px`
    element.querySelector('button')?.focus()
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
          menu.current?.querySelector('button')?.focus()
        }
      }}
    >
      <button role="menuitem" onClick={onDelete}>
        <Trash2 size={14} />
        {count === 1 ? 'Delete photo…' : `Delete ${count} photos…`}
        <kbd>Del</kbd>
      </button>
    </div>
  )
}
