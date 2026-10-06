import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'

export async function focusPreviewWindow(app: ElectronApplication, page: Page) {
  const window = await app.browserWindow(page)
  // CDP input alone does not establish the native focus required by pointer lock.
  await window.evaluate((window) => {
    window.focus()
    window.webContents.focus()
  })
  await expect
    .poll(() => window.evaluate((window) => window.isFocused() && window.webContents.isFocused()))
    .toBe(true)
}

export async function verifyLockedPan(
  app: ElectronApplication,
  page: Page,
  viewport: Locator,
  zoom: Locator,
) {
  await focusPreviewWindow(app, page)
  await zoom.selectOption('8')
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
  await begin()
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

  await begin()
  await page.keyboard.press('Escape')
  await expect.poll(locked).toBe(false)
  await expect(viewport).toHaveAttribute('data-dragging', 'false')
  await page.mouse.up()

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
