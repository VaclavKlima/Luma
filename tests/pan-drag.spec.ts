import { test, expect } from '@playwright/test'
import { PanDrag } from '../src/renderer/src/preview/pan-drag'

const down = (overrides = {}) =>
  ({
    button: 0,
    buttons: 1,
    isPrimary: true,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 100,
    clientY: 80,
    ...overrides,
  }) as PointerEvent

function setup(legacy = false) {
  const window = new EventTarget()
  const document = Object.assign(new EventTarget(), {
    defaultView: window,
    pointerLockElement: null as unknown,
    exitPointerLock: () => {
      document.pointerLockElement = null
      document.dispatchEvent(new Event('pointerlockchange'))
    },
  })
  const captured = new Set<number>(),
    deltas: number[][] = [],
    states: boolean[][] = []
  let grant!: (notify: boolean) => void, reject!: () => void
  const element = {
    ownerDocument: document,
    dataset: { pointerLocked: 'false' },
    setPointerCapture: (id: number) => {
      if (document.pointerLockElement)
        throw new DOMException('Pointer is locked', 'InvalidStateError')
      captured.add(id)
    },
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
    requestPointerLock: () => {
      const request = new Promise<void>((resolve, fail) => {
        grant = (notify) => {
          document.pointerLockElement = element
          if (notify) document.dispatchEvent(new Event('pointerlockchange'))
          resolve()
        }
        reject = () => {
          document.dispatchEvent(new Event('pointerlockerror'))
          if (!legacy) fail(new Error('Denied'))
        }
      })
      return legacy ? undefined : request
    },
  }
  const drag = new PanDrag(
    element as unknown as HTMLElement,
    (x, y) => deltas.push([x, y]),
    (dragging, moved) => states.push([dragging, moved]),
  )
  const move = (x: number, y: number, buttons = 1) =>
    document.dispatchEvent(
      Object.assign(new Event('mousemove'), { movementX: x, movementY: y, buttons }),
    )
  return {
    drag,
    document,
    window,
    element,
    captured,
    deltas,
    states,
    grant: (notify = true) => grant(notify),
    reject: () => reject(),
    move,
  }
}

test('locked dragging uses relative motion once, beyond cursor boundaries, and releases on mouse up or Escape', async () => {
  const h = setup()
  h.drag.start(down())
  h.drag.move(down({ clientX: 103, clientY: 85 }))
  h.grant()
  await Promise.resolve()
  h.drag.lostCapture()
  h.drag.move(down({ clientX: 5000, clientY: -900 }))
  h.move(800, -500)
  expect(h.deltas).toEqual([
    [3, 5],
    [800, -500],
  ])
  h.document.dispatchEvent(Object.assign(new Event('mouseup'), { button: 0 }))
  expect(h.document.pointerLockElement).toBeNull()
  expect(h.captured.size).toBe(0)
  expect(h.states.at(-1)).toEqual([false, true])
  h.move(10, 10)
  expect(h.deltas).toHaveLength(2)
  h.drag.start(down())
  h.grant()
  const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' })
  h.document.dispatchEvent(escape)
  expect(escape.defaultPrevented).toBe(true)
  expect(h.document.pointerLockElement).toBeNull()
  h.drag.dispose()
})

test('late grants after release, replacement drag or disposal cannot lock the cursor, including void-returning runtimes', async () => {
  for (const legacy of [false, true]) {
    for (const cancellation of ['release', 'replace', 'dispose']) {
      const h = setup(legacy)
      h.drag.start(down())
      if (cancellation === 'dispose') h.drag.dispose()
      else h.drag.stop()
      if (cancellation === 'replace') h.drag.start(down({ pointerId: 2 }))
      h.grant()
      await Promise.resolve()
      expect(h.document.pointerLockElement).toBeNull()
      expect(h.element.dataset.pointerLocked).toBe('false')
      if (cancellation === 'replace') {
        h.drag.move(down({ pointerId: 2, clientX: 112 }))
        expect(h.deltas).toEqual([[12, 0]])
      }
      h.drag.dispose()
    }
  }
})

test('denied locks, pen/touch and interruption retain captured dragging without leaving stale listeners', async () => {
  const h = setup()
  h.drag.start(down())
  h.reject()
  await Promise.resolve()
  h.drag.move(down({ clientX: 130 }))
  expect(h.deltas).toEqual([[30, 0]])
  h.window.dispatchEvent(new Event('blur'))
  expect(h.captured.size).toBe(0)
  for (const pointerType of ['touch', 'pen']) {
    h.drag.start(down({ pointerType }))
    h.drag.move(down({ pointerType, clientX: 102 }))
    h.drag.move(down({ pointerType, clientX: 104 }))
    h.drag.lostCapture()
    expect(h.states.at(-1)).toEqual([false, true])
  }
  h.drag.dispose()
  const states = h.states.length
  h.window.dispatchEvent(new Event('blur'))
  h.document.dispatchEvent(new Event('pointerlockchange'))
  expect(h.states).toHaveLength(states)
})

test('rapid clicks during native unlock do not request forbidden capture or leave a drag active', async () => {
  for (const clearedElement of [false, true]) {
    const h = setup()
    h.drag.start(down())
    h.grant()
    await Promise.resolve()
    h.document.exitPointerLock = () => undefined
    h.drag.stop()
    if (clearedElement) {
      h.document.pointerLockElement = null
      h.element.setPointerCapture = () => {
        throw new DOMException('Native unlock pending', 'InvalidStateError')
      }
    }
    h.drag.start(down())
    expect(h.captured.size).toBe(0)
    h.grant()
    await Promise.resolve()
    h.document.pointerLockElement = null
    h.document.dispatchEvent(new Event('pointerlockchange'))
    expect(h.states.at(-1)).toEqual([false, false])
    h.move(100, 100)
    expect(h.deltas).toHaveLength(0)
    h.drag.dispose()
  }
})

test('release before native lock notification does not block subsequent lock requests', async () => {
  for (const legacy of [false, true]) {
    const h = setup(legacy)
    let requests = 0
    const acquire = h.element.requestPointerLock
    h.element.requestPointerLock = () => {
      requests++
      return acquire()
    }
    h.drag.start(down())
    h.grant(false)
    h.drag.stop()
    h.drag.start(down())
    await Promise.resolve()
    expect(requests).toBe(2)
    h.drag.stop()
    h.drag.start(down())
    expect(requests).toBe(2)
    h.grant()
    await Promise.resolve()
    expect(h.document.pointerLockElement).toBeNull()
    h.drag.dispose()
  }
})
