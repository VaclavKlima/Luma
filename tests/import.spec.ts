import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './electron.fixture'
import { choose, importPhotos, expectImportComplete } from './import.helpers'
import { isolateTrash } from './photo-actions.helpers'

test('reviews a folder, excludes photos, copies originals, persists, and marks duplicates', async ({
  luma,
}, testInfo) => {
  const { app, page } = luma
  const source = testInfo.outputPath('Výběr fotek')
  await mkdir(join(source, 'nested'), { recursive: true })
  const original = await readFile('tests/fixtures/photos/alpine-lake.jpg')
  await writeFile(join(source, 'výlet.jpg'), original)
  await copyFile('tests/fixtures/photos/mountain-ridge.jpg', join(source, 'nested', 'exclude.jpg'))
  await writeFile(join(source, 'broken.jpg'), 'not a photo')
  await page.getByRole('button', { name: 'Import photos', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Include subfolders' })).toBeChecked()
  await choose(app, page, [source], 'folder')
  await expect(page.getByTestId('import-status')).toContainText('Ready to import', {
    timeout: 30_000,
  })
  await expect(page.getByTestId('import-status')).toContainText('2 new · 0 duplicates · 1 errors')
  await expect(page.getByRole('checkbox', { name: 'Import výlet.jpg', exact: true })).toBeChecked()
  await expect(
    page.getByRole('checkbox', { name: 'Import exclude.jpg', exact: true }),
  ).toBeChecked()
  await expect(
    page.getByRole('checkbox', { name: 'Import broken.jpg', exact: true }),
  ).toBeDisabled()
  await page.getByRole('checkbox', { name: 'Import exclude.jpg', exact: true }).uncheck()
  await expect(page.getByRole('button', { name: 'Import 1 photos', exact: true })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('import-review.png') })
  await page.getByRole('button', { name: 'Import 1 photos', exact: true }).click()
  await expectImportComplete(page)
  await expect(page.getByTestId('preview-filename')).toHaveText('výlet.jpg')
  const catalog = await page.evaluate(() => window.luma.listPhotos())
  expect(catalog.total).toBe(1)
  const stored = join(
    luma.userDataDir,
    'library',
    'originals',
    catalog.photos[0].id,
    'original.jpg',
  )
  expect(await readFile(stored)).toEqual(original)
  expect(await readdir(join(luma.userDataDir, 'library', 'staging'))).toEqual([])
  await rm(source, { recursive: true })
  const restarted = await luma.restart()
  await expect(restarted.page.getByTestId('preview-filename')).toHaveText('výlet.jpg')
  await expect
    .poll(() =>
      restarted.page
        .getByTestId('main-preview')
        .evaluate((image) => (image as HTMLCanvasElement).width),
    )
    .toBeGreaterThan(0)
  await mkdir(source)
  await writeFile(join(source, 'renamed.jpg'), original)
  await restarted.page.getByRole('button', { name: 'Import photos', exact: true }).click()
  await choose(restarted.app, restarted.page, [join(source, 'renamed.jpg')])
  await expect(restarted.page.getByTestId('import-status')).toContainText('Ready to import')
  await expect(restarted.page.getByText('Already imported', { exact: true })).toBeVisible()
  await expect(restarted.page.getByRole('checkbox', { name: 'Import renamed.jpg' })).toBeDisabled()
  await expect(
    restarted.page.getByRole('button', { name: 'Import 0 photos', exact: true }),
  ).toBeDisabled()
})

test('supports picker cancellation, nonrecursive folders, select all and keyboard dismissal', async ({
  luma,
}, testInfo) => {
  const { app, page } = luma
  const source = testInfo.outputPath('folder')
  await mkdir(join(source, 'nested'), { recursive: true })
  await copyFile('tests/fixtures/photos/alpine-lake.jpg', join(source, 'one.jpg'))
  await copyFile('tests/fixtures/photos/mountain-ridge.jpg', join(source, 'nested', 'two.jpg'))
  await page.getByRole('button', { name: 'Import photos', exact: true }).click()
  await choose(app, page, [])
  await expect(page.getByText('Start with a photo or a folder')).toBeVisible()
  await page.getByRole('checkbox', { name: 'Include subfolders' }).uncheck()
  await choose(app, page, [source], 'folder')
  await expect(page.getByTestId('import-status')).toContainText('Ready to import')
  await expect(page.getByTestId('import-status')).toContainText('1 found')
  await choose(app, page, [])
  await expect(page.getByTestId('import-status')).toContainText('1 found')
  await page.getByRole('button', { name: 'Deselect all', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Import 0 photos', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Select all', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Import one.jpg' })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await page.evaluate(() => window.luma.listPhotos())).total).toBe(0)
  expect(await readdir(join(luma.userDataDir, 'library', 'staging'))).toEqual([])
})

test('imports and browses the real Sony ZV-1 compressed ARW through the preview process', async ({
  luma,
}) => {
  await importPhotos(luma.app, luma.page, ['tests/fixtures/sony-zv1.ARW'])
  await expect(luma.page.getByTestId('photo-metadata')).toContainText('ZV-1')
  await expect(luma.page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
  await luma.page.getByRole('combobox', { name: 'Preview zoom' }).selectOption('1')
  const previewSize = await luma.page.getByTestId('main-preview').evaluate((element) => ({
    natural: (element as HTMLCanvasElement).width,
    displayed: element.getBoundingClientRect().width,
  }))
  const { photos } = await luma.page.evaluate(() => window.luma.listPhotos())
  expect(previewSize.natural).toBe(5422)
  expect(previewSize.natural).toBeLessThan(photos[0].width!)
  expect(previewSize.displayed).toBeCloseTo(previewSize.natural, 1)
  expect(photos[0]).toMatchObject({ format: 'ARW', camera: 'ZV-1', previewSource: 'embedded' })
  expect(
    await readFile(join(luma.userDataDir, 'library', 'originals', photos[0].id, 'original.arw')),
  ).toEqual(await readFile('tests/fixtures/sony-zv1.ARW'))
})

test('reviews and browses a library across page boundaries', async ({ luma }, testInfo) => {
  test.setTimeout(90_000)
  const { app, page } = luma
  const source = testInfo.outputPath('large-folder')
  await mkdir(source)
  const bytes = await readFile('tests/fixtures/photos/alpine-lake.jpg')
  for (let index = 0; index < 61; index++) {
    // Distinct JPEG files with a trailing identifier exercise content-based identity.
    await writeFile(
      join(source, `${String(index).padStart(2, '0')}.jpg`),
      Buffer.concat([bytes, Buffer.from(String(index))]),
    )
  }
  await page.getByRole('button', { name: 'Import photos', exact: true }).click()
  await choose(app, page, [source], 'folder')
  await expect(page.getByTestId('import-status')).toContainText('Ready to import', {
    timeout: 60_000,
  })
  await expect(page.getByRole('button', { name: 'Import 61 photos', exact: true })).toBeEnabled()
  const pages = page.getByRole('navigation', { name: 'Import pages' })
  await pages.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Import 60.jpg', exact: true })).toBeChecked()
  await page.getByRole('button', { name: 'Import 61 photos', exact: true }).click()
  await expectImportComplete(page)
  await expect(page.getByTestId('preview-filename')).toHaveText('00.jpg')
  await page.getByRole('button', { name: 'Previous photo', exact: true }).click()
  await expect(page.getByTestId('preview-filename')).toHaveText('01.jpg')
  await page.getByRole('button', { name: 'Next photo', exact: true }).click()
  await expect(page.getByTestId('preview-filename')).toHaveText('00.jpg')
  await page
    .getByRole('navigation', { name: 'Library pages' })
    .getByRole('button', { name: 'Previous', exact: true })
    .click()
  await expect(page.getByTestId('preview-filename')).toHaveText('00.jpg')
  await page.getByRole('button', { name: 'Select 60.jpg', exact: true }).click()
  await expect(page.getByTestId('preview-filename')).toHaveText('60.jpg')
  const libraryPages = page.getByRole('navigation', { name: 'Library pages' })
  await libraryPages.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByTestId('preview-filename')).toHaveText('60.jpg')
  await page
    .getByRole('button', { name: 'Select 00.jpg', exact: true })
    .click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('61 selected')
  await page.keyboard.press('Delete')
  await expect(page.getByRole('dialog')).toContainText('Delete 61 photos?')
  await page.keyboard.press('Escape')
  await page
    .getByRole('button', { name: 'Select 00.jpg', exact: true })
    .click({ modifiers: ['ControlOrMeta'] })
  await expect(page.getByTestId('selection-count')).toHaveText('60 selected')
  await isolateTrash(app)
  await page.keyboard.press('Delete')
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.luma.listPhotos())).total).toBe(1)
  await expect(page.getByTestId('preview-filename')).toHaveText('00.jpg')
  await expect(page.getByRole('button', { name: 'Select 00.jpg', exact: true })).toBeVisible()
  await expect(libraryPages).toHaveCount(0)
  await expect(page.getByTestId('selection-count')).toHaveText('0 selected')
})
