import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
test('Sony Temperature and Tint share one As Shot reset, undo, redo and restart with a compact inspector', async ({
  luma,
}, info) => {
  test.setTimeout(90000)
  let { page } = luma
  await importPhotos(luma.app, page, ['tests/fixtures/sony-zv1.ARW'])
  const id = (await page.evaluate(() => window.luma.listPhotos())).photos[0].id
  const temperature = page.getByRole('spinbutton', { name: 'Temperature value' }),
    tint = page.getByRole('spinbutton', { name: 'Tint value' })
  await expect(temperature).toBeEnabled({ timeout: 40000 })
  const original = await page.evaluate((id) => window.luma.getEdits(id), id)
  expect(original.whiteBalanceProfile?.provider).toBe('sony-zv1-white-balance')
  await temperature.fill('8000')
  await temperature.press('Enter')
  await expect
    .poll(() => page.evaluate((id) => window.luma.getEdits(id), id))
    .toMatchObject({ revision: 1, settings: { whiteBalance: { mode: 'custom', kelvin: 8000 } } })
  await tint.fill('25')
  await tint.press('Enter')
  await expect
    .poll(() => page.evaluate((id) => window.luma.getEdits(id), id))
    .toMatchObject({
      revision: 2,
      settings: { whiteBalance: { mode: 'custom', kelvin: 8000, tint: 25 } },
    })
  await page.getByRole('button', { name: 'As Shot', exact: true }).click()
  await expect
    .poll(() => page.evaluate((id) => window.luma.getEdits(id), id))
    .toMatchObject({ revision: 3, settings: { whiteBalance: { mode: 'as-shot' } } })
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(temperature).toHaveValue('8000')
  await expect(tint).toHaveValue('25')
  await luma.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1100, 700),
  )
  await page.getByTestId('console-toggle').click()
  await tint.scrollIntoViewIfNeeded()
  await expect(tint).toBeInViewport()
  await page.screenshot({ path: info.outputPath('white-balance-1100-console.png') })
  const history = await page.evaluate((id) => window.luma.getEditHistory(id), id)
  ;({ page } = await luma.restart())
  expect(await page.evaluate((id) => window.luma.getEditHistory(id), id)).toEqual(history)
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect
    .poll(() => page.evaluate((id) => window.luma.getEdits(id), id))
    .toMatchObject({ settings: { whiteBalance: { mode: 'as-shot' } } })
})
