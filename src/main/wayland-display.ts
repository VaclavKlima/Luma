import type { BrowserWindow, WebContents } from 'electron'

/** Work around stale ScreenInfos in Electron 44.3.0 on Wayland. */
export function installWaylandDisplayRefresh(window: BrowserWindow): void {
  if (
    process.platform !== 'linux' ||
    !process.env.WAYLAND_DISPLAY ||
    process.versions.electron !== '44.3.0'
  )
    return

  // This internal method is deliberately confined to the verified, pinned runtime.
  // With the same contents as embedder it retains the existing owner window and
  // synchronously calls WasHidden/WasShown, refreshing native ScreenInfos without
  // reloading, remapping the Wayland surface, or emulating a different display.
  // Recheck this workaround when upgrading Electron; see docs/hdr-processing.md.
  const contents = window.webContents as WebContents & {
    setEmbedder?: (embedder: WebContents) => void
  }
  if (typeof contents.setEmbedder !== 'function') return
  const refresh = () => {
    if (
      window.isDestroyed() ||
      !window.isVisible() ||
      window.isMinimized() ||
      contents.isDestroyed() ||
      contents.isLoadingMainFrame()
    )
      return
    try {
      contents.setEmbedder!(contents)
    } catch (error) {
      clearInterval(timer)
      console.warn('Could not refresh the Wayland display:', error)
    }
  }
  // Wayland does not supply global window coordinates or reliable move events.
  // Refresh native metadata while mapped; Blink emits events only when it changes.
  const timer = setInterval(refresh, 1000)
  timer.unref()
  window.once('closed', () => clearInterval(timer))
}
