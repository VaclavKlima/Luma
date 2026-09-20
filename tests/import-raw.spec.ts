import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'

test('imports and browses the real Sony ZV-1 compressed ARW through the preview process', async ({
  luma,
}) => {
  await importPhotos(luma.app, luma.page, ['tests/fixtures/sony-zv1.ARW'])
  await expect(luma.page.getByTestId('photo-metadata')).toContainText('ZV-1')
  await expect(luma.page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
  await luma.page.getByRole('combobox', { name: 'Preview zoom' }).selectOption('1')
  const previewSize = await luma.page.getByTestId('main-preview').evaluate((element) => ({
    natural: Number(element.parentElement!.dataset.imageWidth),
    backing: (element as HTMLCanvasElement).width,
    dpr: devicePixelRatio,
    displayed: element.getBoundingClientRect().width,
  }))
  const { photos } = await luma.page.evaluate(() => window.luma.listPhotos())
  expect(previewSize.natural).toBe(5422)
  expect(previewSize.natural).toBeLessThan(photos[0].width!)
  expect(previewSize.backing).toBe(Math.round(previewSize.displayed * previewSize.dpr))
  expect(photos[0]).toMatchObject({ format: 'ARW', camera: 'ZV-1', previewSource: 'embedded' })
  expect(
    await readFile(join(luma.userDataDir, 'library', 'originals', photos[0].id, 'original.arw')),
  ).toEqual(await readFile('tests/fixtures/sony-zv1.ARW'))
})
