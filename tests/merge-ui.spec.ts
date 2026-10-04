import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'

test('shared Actions menu explains bounds and preserves pending right-click selection', async ({
  luma,
}) => {
  const { app, page } = luma
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Merge to HDR…' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await expect(page.getByRole('menu')).toContainText('Select at least two')
  await page.keyboard.press('Escape')
  await importPhotos(app, page, [
    'tests/fixtures/photos/alpine-lake.jpg',
    'tests/fixtures/photos/forest-light.jpg',
  ])
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  const hold = await app.evaluateHandle(({ ipcMain }) => {
    const handlers = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers,
      original = handlers.get('library:range')!
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    ipcMain.removeHandler('library:range')
    ipcMain.handle('library:range', async (...args) => {
      await wait
      return original(...args)
    })
    return { release }
  })
  await page.getByTestId(`photo-card-${photos[1].id}`).click({ modifiers: ['Shift'] })
  await page.getByTestId(`photo-card-${photos[0].id}`).click({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(0)
  await hold.evaluate((h) => h.release())
  await expect(page.getByRole('menuitem', { name: 'Delete 2 photos…' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Merge to HDR…' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('original Sony RAW')
  await expect(page.getByRole('alert')).not.toContainText('Error:')
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await page.getByTestId('console-toggle').click()
  const browserWindow = await app.browserWindow(page)
  await browserWindow.evaluate((w) => {
    w.unmaximize()
    w.setContentSize(1100, 700)
  })
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.keyboard.press('Home')
  await expect(page.getByRole('menuitem', { name: 'Merge to HDR…' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Stack for noise reduction…' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toContainText('Stack for noise reduction')
  const bounds = await page.getByRole('dialog').boundingBox()
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1100)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(700)
  await page.keyboard.press('Escape')
})
