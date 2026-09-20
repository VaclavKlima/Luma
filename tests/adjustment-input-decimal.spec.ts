import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'

test('numeric adjustment entry preserves partial text, cancels invalid drafts and follows confirmed edits', async ({
  luma,
}) => {
  const { page, app } = luma
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const field = page.getByRole('spinbutton', { name: 'Exposure value' })
  await expect(field).toBeEnabled({ timeout: 20000 })
  const id = (await page.evaluate(() => window.luma.listPhotos())).photos[0].id
  const state = () => page.evaluate((id) => window.luma.getEdits(id), id)
  await expect(field).toHaveValue('0.00')
  await expect(page.getByRole('button', { name: 'Reset exposure' })).toHaveCount(0)
  await expect(
    page.getByTestId('adjustments-panel').getByRole('button', { name: /Undo|Redo/ }),
  ).toHaveCount(0)
  await field.fill('')
  await field.pressSequentially('-1.25')
  await expect(field).toHaveValue('-1.25')
  expect((await state()).revision).toBe(0)
  await field.press('Enter')
  await expect.poll(state).toMatchObject({ revision: 1, settings: { exposureEv: -1.25 } })
  await field.fill('2')
  await field.press('Escape')
  await expect(field).toHaveValue('-1.25')
  await field.fill('1')
  await field.pressSequentially('0')
  await expect(field).toHaveValue('10')
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await field.press('Tab')
  await expect(field).toHaveValue('-1.25')
  expect((await state()).revision).toBe(1)
  await field.fill('0.001')
  await field.press('Enter')
  await expect(field).toHaveValue('-1.25')
  expect((await state()).revision).toBe(1)
  await field.fill('1.5')
  await field.press('Tab')
  await expect(field).toHaveValue('1.50')
  await expect.poll(state).toMatchObject({ revision: 2, settings: { exposureEv: 1.5 } })
  await field.fill('2')
  await page.evaluate((id) => window.luma.updateEdits(id, { exposureEv: -0.5 }, 2), id)
  await expect(field).toHaveValue('-0.50')
  await field.press('Enter')
  expect((await state()).revision).toBe(3)
})

test('groups exposure gestures, cancels drafts, resolves external conflicts and keeps the pixel view', async ({
  luma,
}, info) => {
  const { page, app } = luma
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const id = (await page.evaluate(() => window.luma.listPhotos())).photos[0].id
  const preview = page.getByTestId('main-preview')
  await expect(preview).toHaveAttribute('data-editing', 'ready', { timeout: 20000 })
  await expect(preview).toHaveAttribute('data-backend', 'webgl2')
  const zoom = page.getByRole('combobox', { name: 'Preview zoom' })
  await zoom.selectOption('16')
  const slider = page.getByRole('slider', { name: 'Exposure', exact: true })
  await slider.focus()
  for (let i = 0; i < 20; i++) await page.keyboard.down('ArrowRight')
  await expect(slider).toHaveValue('0.2')
  expect((await page.evaluate((id) => window.luma.getEdits(id), id)).revision).toBe(0)
  await expect(preview).toHaveAttribute('data-exposure', '0.2')
  await page.keyboard.up('ArrowRight')
  await expect
    .poll(() => page.evaluate((id) => window.luma.getEdits(id), id))
    .toMatchObject({ revision: 1, settings: { exposureEv: 0.2 } })
  await expect(zoom).toHaveValue('16')
  for (let i = 0; i < 5; i++) await page.keyboard.down('ArrowRight')
  await page.keyboard.press('Escape')
  await page.keyboard.up('ArrowRight')
  await expect(slider).toHaveValue('0.2')
  expect((await page.evaluate((id) => window.luma.getEditHistory(id), id)).snapshots).toHaveLength(
    2,
  )
  await page.keyboard.down('ArrowRight')
  await page.evaluate((id) => window.luma.updateEdits(id, { exposureEv: -1 }, 1), id)
  await expect(slider).toHaveValue('-1')
  await page.keyboard.up('ArrowRight')
  expect((await page.evaluate((id) => window.luma.getEdits(id), id)).revision).toBe(2)
  await preview.focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(slider).toHaveValue('0.2')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(slider).toHaveValue('-1')
  await page.getByRole('spinbutton', { name: 'Exposure value' }).fill('0')
  await page.getByRole('spinbutton', { name: 'Exposure value' }).press('Enter')
  await expect(slider).toHaveValue('0')
  await expect(preview).toBeVisible()
  await page.getByTestId('console-toggle').click()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1100, 700),
  )
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeInViewport()
  await page.screenshot({ path: info.outputPath('exposure-1600-console.png') })
  await slider.focus()
  await page.keyboard.down('ArrowRight')
  // A normal application close must flush even an unfinished keyboard gesture.
  const restarted = await luma.restart()
  await expect(restarted.page.getByRole('slider', { name: 'Exposure', exact: true })).toHaveValue(
    '0.01',
  )
})
