import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { isolateTrash } from './photo-actions.helpers'

const sources = [
  'alpine-lake',
  'mountain-ridge',
  'forest-light',
  'coastal-dunes',
  'quiet-valley',
].map((name) => `tests/fixtures/photos/${name}.jpg`)

test('selects ranges and individual photos, and preserves or replaces selection for context menus', async ({
  luma,
}, testInfo) => {
  const { app, page } = luma
  await importPhotos(app, page, sources)
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  const card = (index: number) => page.getByTestId(`photo-card-${photos[index].id}`)
  await card(0).click()
  await card(2).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
  for (let index = 0; index < 3; index++)
    await expect(card(index)).toHaveAttribute('aria-pressed', 'true')
  await card(1).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await card(3).click({ modifiers: ['ControlOrMeta'] })
  await card(4).click({ modifiers: ['ControlOrMeta', 'Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('4 selected')
  await card(4).click({ modifiers: ['ControlOrMeta'] })
  await expect(card(4)).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[4].filename)
  await card(1).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Delete 3 photos…' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(card(1)).toBeFocused()
  await card(2).click({ button: 'right' })
  await expect(page.getByTestId('selection-count')).toHaveText('1 selected')
  await page.getByRole('menuitem', { name: 'Delete photo…' }).click()
  await expect(page.getByRole('dialog')).toContainText(photos[2].filename)
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.keyboard.press('Delete')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  const nativeWindow = await app.browserWindow(page)
  await nativeWindow.evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  const bounds = await page.getByRole('dialog').boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1100)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(700)
  await page.screenshot({ path: testInfo.outputPath('delete-confirmation.png') })
  await page.keyboard.press('Escape')
  await expect(card(2)).toBeFocused()
  expect((await page.evaluate(() => window.luma.listPhotos())).total).toBe(5)
  await card(3).click()
  await card(1).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
  await expect(page.getByTestId('main-preview')).toBeVisible()
  await page.getByTestId('main-preview').focus()
  await page.keyboard.press('Shift+F10')
  await expect(page.getByRole('menuitem', { name: 'Delete 3 photos…' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('main-preview')).toBeFocused()
  await page.getByTestId('console-toggle').click()
  await page
    .getByRole('textbox', { name: 'Agent console output, disconnected and read only' })
    .focus()
  await page.keyboard.press('Delete')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('deletes a confirmed group and the last photos while preserving source files', async ({
  luma,
}) => {
  const { app, page } = luma
  const trash = await isolateTrash(app)
  await importPhotos(app, page, sources)
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  await page.getByTestId(`photo-card-${photos[2].id}`).click({ modifiers: ['Shift'] })
  await page.keyboard.press('Delete')
  await expect(page.getByRole('dialog')).toContainText('Delete 3 photos?')
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(async () => (await page.evaluate(() => window.luma.listPhotos())).total).toBe(2)
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[3].filename)
  await expect(page.getByTestId('selection-count')).toHaveText('0 selected')
  expect(await readdir(trash)).toHaveLength(3)
  for (const source of sources) expect((await readFile(source)).length).toBeGreaterThan(0)
  await page.getByTestId('main-preview').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete photo…' }).click()
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.luma.listPhotos())).total).toBe(1)
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[4].filename)
  await page.getByTestId(`photo-card-${photos[4].id}`).click()
  await page.keyboard.press('Delete')
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect(page.getByTestId('empty-library')).toBeVisible()
  expect(await readdir(trash)).toHaveLength(5)
  const restarted = await luma.restart()
  await expect(restarted.page.getByTestId('empty-library')).toBeVisible()
})

test('keeps deletion running through reload and cancels after the current OS move', async ({
  luma,
}, testInfo) => {
  const { app, page } = luma
  await importPhotos(app, page, sources)
  await isolateTrash(app, { delay: 3000 })
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  await page.getByTestId(`photo-card-${photos[4].id}`).click({ modifiers: ['Shift'] })
  await page.keyboard.press('Delete')
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('task-progress')).toContainText('Moving photos to Trash')
  await page.reload()
  await expect(page.getByTestId('task-progress')).toContainText('Moving photos to Trash')
  const id = await page.evaluate(
    async () => (await window.luma.listTasks()).find((task) => task.kind === 'delete')!.id,
  )
  await page.getByRole('button', { name: 'Import photos', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId(`task-${id}`)).toContainText('0 / 5 photos moved to Trash')
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click()
  await expect(page.getByTestId(`task-${id}`)).toContainText('Cancelling deletion')
  await page.screenshot({ path: testInfo.outputPath('background-deletion.png') })
  await expect(page.getByTestId(`task-${id}`)).toHaveAttribute('data-status', 'cancelled')
  expect((await page.evaluate(() => window.luma.listPhotos())).total).toBe(4)
  expect(await readdir(join(luma.userDataDir, 'library', 'removed'))).toEqual([])
})

test('retains failed photos and confirms quit during deletion', async ({ luma }) => {
  const { app, page } = luma
  await importPhotos(app, page, sources.slice(0, 2))
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  await isolateTrash(app, { failId: photos[0].id })
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  await page.keyboard.press('Delete')
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect(page.getByTestId('task-progress')).toContainText('Deletion finished with errors')
  await expect(page.getByTestId(`photo-card-${photos[0].id}`)).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByTestId('task-progress').click()
  await page.getByRole('button', { name: 'Show 1 errors' }).click()
  await expect(page.getByTestId('task-details')).toContainText('System Trash is unavailable')
  await page.keyboard.press('Escape')
  await isolateTrash(app, { delay: 2000 })
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  await page.keyboard.press('Delete')
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  const options = await app.evaluate(async ({ dialog, BrowserWindow }) => {
    let shown!: (options: Electron.MessageBoxOptions) => void
    const result = new Promise<Electron.MessageBoxOptions>((resolve) => {
      shown = resolve
    })
    dialog.showMessageBox = async (...args: unknown[]) => {
      shown(args.at(-1) as Electron.MessageBoxOptions)
      return { response: 0, checkboxChecked: false }
    }
    BrowserWindow.getAllWindows()[0].close()
    return result
  })
  expect(options.buttons).toEqual(['Keep working', 'Cancel task and quit'])
  await expect(page.getByTestId('task-progress')).toContainText('Moving photos to Trash')
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  })
  await luma.expectQuit(async () => {
    await app.evaluate(({ app }) => {
      setImmediate(() => app.quit())
    })
  })
  expect(await readdir(join(luma.userDataDir, 'library', 'removed'))).toEqual([])
  const restarted = await luma.restart()
  expect((await restarted.page.evaluate(() => window.luma.listPhotos())).total).toBe(1)
})
