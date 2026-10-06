interface Pointer {
  id: number
  x: number
  y: number
  distance: number
  moved: boolean
}

// Pointer capture handles touch/pen and denied locks. Mouse locking provides
// relative motion beyond window/screen edges and hides the cursor until release.
export class PanDrag {
  private pointer: Pointer | null = null
  private pending: Pointer | null = null
  private locked = false
  private disposed = false
  private document: Document
  constructor(
    private element: HTMLElement,
    private pan: (x: number, y: number) => void,
    private changed: (dragging: boolean, moved: boolean) => void,
  ) {
    this.document = element.ownerDocument
    element.dataset.pointerLocked = 'false'
    this.document.addEventListener('mousemove', this.mouseMove)
    this.document.addEventListener('mouseup', this.mouseUp, true)
    this.document.addEventListener('pointerlockchange', this.lockChange)
    this.document.addEventListener('pointerlockerror', this.finishRequest)
    this.document.addEventListener('keydown', this.keyDown, true)
    this.document.defaultView?.addEventListener('blur', this.stop)
  }
  start(event: PointerEvent) {
    if (this.disposed || this.pointer || event.button !== 0 || !event.isPrimary) return
    const pointer: Pointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      distance: 0,
      moved: false,
    }
    // Chromium can still forbid capture during native unlock, even after
    // pointerLockElement becomes null. A mouse drag can acquire a new lock.
    try {
      if (!this.document.pointerLockElement) this.element.setPointerCapture(pointer.id)
    } catch (error) {
      if (
        event.pointerType !== 'mouse' ||
        !(error instanceof DOMException) ||
        error.name !== 'InvalidStateError'
      )
        return
    }
    this.pointer = pointer
    this.locked = this.ownsLock()
    this.element.dataset.pointerLocked = String(this.locked)
    this.changed(true, false)
    if (event.pointerType !== 'mouse' || this.pending) return
    this.pending = pointer
    try {
      const request = this.element.requestPointerLock() as Promise<void> | undefined
      void request?.then(
        () => {
          // A release, resize, photo/revision change or unmount can beat the async grant.
          // Native change/error events also cover runtimes returning void.
          if (this.pending !== pointer) return
          this.lockChange()
          this.finishRequest()
        },
        () => {
          if (this.pending === pointer) this.finishRequest()
        },
      )
    } catch {
      this.finishRequest()
    }
  }
  move(event: PointerEvent) {
    const pointer = this.pointer
    if (!pointer || event.pointerId !== pointer.id || this.ownsLock()) return
    if (!(event.buttons & 1)) {
      this.stop()
      return
    }
    const x = event.clientX - pointer.x,
      y = event.clientY - pointer.y
    pointer.x = event.clientX
    pointer.y = event.clientY
    this.moveBy(x, y)
  }
  private moveBy(x: number, y: number) {
    if (!this.pointer || (!x && !y)) return
    this.pointer.distance += Math.abs(x) + Math.abs(y)
    this.pointer.moved ||= this.pointer.distance > 2
    this.pan(x, y)
  }
  private ownsLock() {
    return this.document.pointerLockElement === this.element
  }
  private unlock() {
    if (this.ownsLock()) this.document.exitPointerLock()
  }
  private mouseMove = (event: MouseEvent) => {
    if (!this.ownsLock() || !this.pointer) return
    if (!(event.buttons & 1)) {
      this.stop()
      return
    }
    this.moveBy(event.movementX, event.movementY)
  }
  private mouseUp = (event: MouseEvent) => {
    if (event.button === 0) this.stop()
  }
  private keyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !this.pointer) return
    event.preventDefault()
    event.stopPropagation()
    this.stop()
  }
  private lockChange = () => {
    const locked = this.ownsLock()
    const pending = this.pending
    if (locked) this.finishRequest()
    if (locked && (!this.pointer || this.disposed || (pending && pending !== this.pointer))) {
      this.unlock()
      return
    }
    this.element.dataset.pointerLocked = String(locked)
    if (!locked && this.locked) this.stop()
    this.locked = locked
  }
  private finishRequest = () => {
    this.pending = null
    if (this.disposed) {
      this.document.removeEventListener('pointerlockchange', this.lockChange)
      this.document.removeEventListener('pointerlockerror', this.finishRequest)
    }
  }
  lostCapture = () => {
    if (!this.ownsLock()) this.stop()
  }
  stop = () => {
    const pointer = this.pointer
    // The lock can be granted before its change event is delivered.
    if (this.ownsLock()) this.finishRequest()
    this.pointer = null
    this.locked = false
    this.element.dataset.pointerLocked = 'false'
    if (pointer) {
      if (this.element.hasPointerCapture(pointer.id)) this.element.releasePointerCapture(pointer.id)
      this.changed(false, pointer.moved)
    }
    this.unlock()
  }
  dispose() {
    this.disposed = true
    this.stop()
    this.document.removeEventListener('mousemove', this.mouseMove)
    this.document.removeEventListener('mouseup', this.mouseUp, true)
    if (!this.pending) this.finishRequest()
    this.document.removeEventListener('keydown', this.keyDown, true)
    this.document.defaultView?.removeEventListener('blur', this.stop)
  }
}
