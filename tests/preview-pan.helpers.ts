import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'

export async function focusPreviewWindow(app: ElectronApplication, page: Page) {
  const window = await app.browserWindow(page)
  // CDP input alone does not establish the native focus required by pointer lock.
  if (!(await window.evaluate((window) => window.isFocused()))) {
    // Let the hide finish before remapping the isolated Wayland test window.
    await window.evaluate((window) => window.hide())
    await page.waitForTimeout(500)
    await window.evaluate((window) => window.show())
  }
  await window.evaluate((window) => {
    window.focus()
    window.webContents.focus()
  })
  await expect
    .poll(() =>
      window.evaluate((window) => ({
        window: window.isFocused(),
        contents: window.webContents.isFocused(),
      })),
    )
    .toEqual({ window: true, contents: true })
}

export async function verifyLockedPan(
  app: ElectronApplication,
  page: Page,
  viewport: Locator,
  zoom: Locator,
) {
  await focusPreviewWindow(app, page)
  await zoom.selectOption('8')
  const refresh = await app.evaluateHandle(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const contents = window.webContents as Electron.WebContents & {
      setEmbedder: (embedder: Electron.WebContents) => void
    }
    const enabled =
      process.platform === 'linux' &&
      Boolean(process.env.WAYLAND_DISPLAY) &&
      process.versions.electron === '44.3.0'
    let count = 0
    const events: string[] = []
    const focusState = () => `${window.isFocused()}:${contents.isFocused()}`
    const mouse = (_event: Electron.Event, input: Electron.MouseInputEvent) => {
      if (input.type !== 'mouseMove') events.push(`${input.type}:${input.button}:${focusState()}`)
    }
    const blur = () => events.push(`contents:blur:${focusState()}`)
    const windowBlur = () => events.push(`window:blur:${focusState()}`)
    const original = contents.setEmbedder
    if (enabled) {
      contents.on('before-mouse-event', mouse)
      contents.on('blur', blur)
      window.on('blur', windowBlur)
      contents.setEmbedder = (embedder) => {
        count++
        events.push(`refresh:${focusState()}`)
        original.call(contents, embedder)
      }
    }
    return {
      enabled,
      read: () => ({ count, events, focus: focusState() }),
      restore: () => {
        if (!enabled) return
        contents.setEmbedder = original
        contents.off('before-mouse-event', mouse)
        contents.off('blur', blur)
        window.off('blur', windowBlur)
      },
    }
  })
  const nativeRefresh = await refresh.evaluate((control) => control.enabled)
  const refreshCount = () => refresh.evaluate((control) => control.read().count)
  const geometry = () =>
    viewport.evaluate((el) => ({ x: Number(el.dataset.panX), y: Number(el.dataset.panY) }))
  const locked = () => viewport.evaluate((el) => document.pointerLockElement === el)
  const box = (await viewport.boundingBox())!
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  async function begin() {
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await expect.poll(locked).toBe(true)
    await expect(viewport).toHaveCSS('cursor', 'none')
  }
  async function holdAcrossRefresh() {
    const before = await refreshCount()
    // Keep the button held across at least two real timer ticks.
    await page.waitForTimeout(2200)
    expect(
      await locked(),
      JSON.stringify(await refresh.evaluate((control) => control.read())),
    ).toBe(true)
    await expect(viewport).toHaveAttribute('data-dragging', 'true')
    if (nativeRefresh) expect(await refreshCount()).toBe(before)
  }
  if (nativeRefresh) await expect.poll(refreshCount, { intervals: [50] }).toBeGreaterThan(0)
  await begin()
  await holdAcrossRefresh()
  const before = await geometry()
  await viewport.evaluate((el) => {
    for (let i = 0; i < 4; i++) {
      // Locked client coordinates stay fixed; movement continues beyond viewport/window bounds.
      el.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerId: 1,
          buttons: 1,
          clientX: 8000,
          clientY: -8000,
        }),
      )
      el.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          buttons: 1,
          clientX: 8000,
          clientY: -8000,
          movementX: 150,
          movementY: -90,
        }),
      )
    }
  })
  await expect.poll(async () => (await geometry()).x).toBe(before.x + 600)
  await expect.poll(async () => (await geometry()).y).toBe(before.y - 360)
  await expect.poll(locked).toBe(true)
  // Actual Chromium input also produces relative motion while the pointer is locked.
  await page.mouse.move(point.x - 20, point.y - 10)
  await expect.poll(async () => (await geometry()).x).not.toBe(before.x + 600)
  await page.mouse.up()
  await expect.poll(locked).toBe(false)
  await expect(viewport).toHaveAttribute('data-dragging', 'false')
  await expect(viewport).not.toHaveCSS('cursor', 'none')
  expect(await viewport.evaluate((el) => el.hasPointerCapture(1))).toBe(false)
  const released = await geometry()
  await page.mouse.move(point.x + 40, point.y + 20)
  expect(await geometry()).toEqual(released)

  if (nativeRefresh) {
    const before = await refreshCount()
    await expect.poll(refreshCount, { intervals: [50] }).toBeGreaterThan(before)
    // Start a second drag just before the next scheduled refresh.
    await page.waitForTimeout(800)
  }
  await begin()
  await holdAcrossRefresh()
  await page.keyboard.press('Escape')
  await expect.poll(locked).toBe(false)
  await expect(viewport).toHaveAttribute('data-dragging', 'false')
  await page.mouse.up()
  if (nativeRefresh) {
    const before = await refreshCount()
    await expect.poll(refreshCount, { intervals: [50] }).toBeGreaterThan(before)
  }
  await refresh.evaluate((control) => control.restore())
  await refresh.dispose()

  await begin()
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect.poll(locked).toBe(false)
  await expect(viewport).toHaveAttribute('data-dragging', 'false')
  await page.mouse.up()

  await zoom.selectOption('fit')
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + 10, point.y + 5)
  expect(await locked()).toBe(false)
  await page.mouse.up()
}
