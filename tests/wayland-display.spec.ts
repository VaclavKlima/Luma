import { expect, test } from '@playwright/test'
import type { BrowserWindow } from 'electron'
import { refreshWaylandDisplay } from '../src/main/wayland-display'

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
  const contents = {
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
  }
  const window = {
    get webContents() {
      expect(state.windowDestroyed).toBe(false)
      return contents
    },
    isDestroyed: () => state.windowDestroyed,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isFocused: () => state.windowFocused,
  } as unknown as BrowserWindow
  return { state, calls, contents, window }
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
