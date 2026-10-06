import { expect, test } from '@playwright/test'
import { EventEmitter } from 'node:events'
import type { BrowserWindow, MouseInputEvent } from 'electron'
import { refreshWaylandDisplay, WaylandDisplayRefresh } from '../src/main/wayland-display'

interface DisplayState {
  windowFocused: boolean
  contentsFocused: boolean
  windowDestroyed: boolean
  contentsDestroyed: boolean
  visible: boolean
  minimized: boolean
  loading: boolean
}

function displayWindow(
  onRefresh: (state: DisplayState) => void = (state) => {
    state.contentsFocused = false
  },
) {
  const state: DisplayState = {
    windowFocused: true,
    contentsFocused: true,
    windowDestroyed: false,
    contentsDestroyed: false,
    visible: true,
    minimized: false,
    loading: false,
  }
  const calls = { refresh: 0, focus: 0 }
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => state.contentsDestroyed,
    isLoadingMainFrame: () => state.loading,
    isFocused: () => state.contentsFocused,
    focus: () => {
      expect(state.windowDestroyed || state.contentsDestroyed).toBe(false)
      calls.focus++
      state.contentsFocused = true
    },
    setEmbedder: (embedder: unknown) => {
      expect(embedder).toBe(contents)
      calls.refresh++
      onRefresh(state)
    },
  })
  const events = new EventEmitter()
  const window = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    get webContents() {
      expect(state.windowDestroyed).toBe(false)
      return contents
    },
    isDestroyed: () => state.windowDestroyed,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isFocused: () => state.windowFocused,
  } as unknown as BrowserWindow
  return { state, calls, contents, window, events }
}

test('restores native content focus lost during each display refresh', () => {
  const { state, calls, window } = displayWindow()
  for (let cycle = 0; cycle < 5; cycle++) {
    refreshWaylandDisplay(window)
    expect(state.contentsFocused).toBe(true)
  }
  expect(calls).toEqual({ refresh: 5, focus: 5 })
})

test('leaves retained native focus alone', () => {
  const { state, calls, window } = displayWindow(() => undefined)
  refreshWaylandDisplay(window)
  expect(state.contentsFocused).toBe(true)
  expect(calls).toEqual({ refresh: 1, focus: 0 })
})

test('does not focus content that was initially unfocused', () => {
  const { state, calls, window } = displayWindow()
  state.contentsFocused = false
  refreshWaylandDisplay(window)
  expect(state.contentsFocused).toBe(false)
  expect(calls).toEqual({ refresh: 1, focus: 0 })
})

test('refreshes a background window without taking focus', () => {
  const { state, calls, window } = displayWindow()
  state.windowFocused = false
  refreshWaylandDisplay(window)
  expect(state.windowFocused).toBe(false)
  expect(state.contentsFocused).toBe(false)
  expect(calls).toEqual({ refresh: 1, focus: 0 })
})

for (const change of ['windowDestroyed', 'contentsDestroyed', 'windowFocused'] as const) {
  test(`does not restore focus when ${change} changes during refresh`, () => {
    const { state, calls, window } = displayWindow((state) => {
      state.contentsFocused = false
      state[change] = change !== 'windowFocused'
    })
    refreshWaylandDisplay(window)
    expect(state.contentsFocused).toBe(false)
    expect(calls).toEqual({ refresh: 1, focus: 0 })
  })
}

function mouse(
  contents: EventEmitter,
  type: MouseInputEvent['type'],
  button?: MouseInputEvent['button'],
) {
  contents.emit('before-mouse-event', {}, { type, button, x: 100, y: 80 })
}

for (const button of ['left', 'middle', 'right'] as const) {
  test(`defers every display refresh throughout a held ${button} press and resumes after release`, () => {
    const { calls, contents, window } = displayWindow()
    const display = new WaylandDisplayRefresh(window)
    mouse(contents, 'mouseDown', button)
    mouse(contents, 'mouseMove')
    mouse(contents, 'mouseLeave')
    for (let tick = 0; tick < 5; tick++) display.refresh()
    expect(calls).toEqual({ refresh: 0, focus: 0 })
    mouse(contents, 'mouseUp', button)
    display.refresh()
    expect(calls).toEqual({ refresh: 1, focus: 1 })
    display.dispose()
  })
}

test('releasing another button does not interrupt a held drag', () => {
  const { calls, contents, window } = displayWindow()
  const display = new WaylandDisplayRefresh(window)
  mouse(contents, 'mouseDown', 'left')
  mouse(contents, 'mouseDown', 'right')
  mouse(contents, 'mouseUp', 'right')
  display.refresh()
  expect(calls.refresh).toBe(0)
  mouse(contents, 'mouseUp', 'left')
  display.refresh()
  expect(calls.refresh).toBe(1)
  display.dispose()
})

test('a native view blur inside the active window preserves the held-drag guard', () => {
  const { state, calls, contents, window } = displayWindow()
  const display = new WaylandDisplayRefresh(window)
  mouse(contents, 'mouseDown', 'left')
  state.contentsFocused = false
  contents.emit('blur')
  for (let tick = 0; tick < 5; tick++) display.refresh()
  expect(calls).toEqual({ refresh: 0, focus: 0 })
  mouse(contents, 'mouseUp', 'left')
  display.refresh()
  expect(calls).toEqual({ refresh: 1, focus: 0 })
  display.dispose()
})

for (const [source, event] of [
  ['window', 'blur'],
  ['window', 'hide'],
  ['window', 'minimize'],
  ['contents', 'blur'],
  ['contents', 'render-process-gone'],
] as const) {
  test(`clears held presses after ${source} ${event}, allowing future refreshes and drags`, () => {
    const { state, calls, contents, window, events } = displayWindow()
    const display = new WaylandDisplayRefresh(window)
    mouse(contents, 'mouseDown', 'left')
    if (source === 'contents' && event === 'blur') state.windowFocused = false
    const target = source === 'window' ? events : contents
    target.emit(event)
    display.refresh()
    expect(calls.refresh).toBe(1)
    mouse(contents, 'mouseDown', 'left')
    display.refresh()
    expect(calls.refresh).toBe(1)
    mouse(contents, 'mouseUp', 'left')
    display.refresh()
    expect(calls.refresh).toBe(2)
    display.dispose()
  })
}

test('only a new main-frame navigation clears an unfinished press', () => {
  const { calls, contents, window } = displayWindow()
  const display = new WaylandDisplayRefresh(window)
  mouse(contents, 'mouseDown', 'left')
  for (const [inPlace, main] of [
    [false, false],
    [true, true],
  ]) {
    contents.emit('did-start-navigation', {}, 'luma://page', inPlace, main)
    display.refresh()
    expect(calls.refresh).toBe(0)
  }
  contents.emit('did-start-navigation', {}, 'luma://page', false, true)
  display.refresh()
  expect(calls.refresh).toBe(1)
  display.dispose()
})

test('disposal removes input and lifecycle observers without removing other listeners', () => {
  const { contents, window, events } = displayWindow()
  const unrelated = () => undefined
  contents.on('before-mouse-event', unrelated)
  const display = new WaylandDisplayRefresh(window)
  mouse(contents, 'mouseDown', 'left')
  display.dispose()
  display.dispose()
  expect(contents.eventNames()).toEqual(['before-mouse-event'])
  expect(contents.listeners('before-mouse-event')).toEqual([unrelated])
  expect(events.eventNames()).toEqual([])
})

for (const guard of [
  'windowDestroyed',
  'contentsDestroyed',
  'visible',
  'minimized',
  'loading',
] as const) {
  test(`skips refresh when ${guard} prevents a mapped, ready view`, () => {
    const { state, calls, window } = displayWindow()
    state[guard] = guard !== 'visible'
    refreshWaylandDisplay(window)
    expect(calls).toEqual({ refresh: 0, focus: 0 })
  })
}
