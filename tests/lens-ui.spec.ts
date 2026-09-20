import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'

test('raster photos explain unavailable corrections without enabling editing', async ({ luma }) => {
  await importPhotos(luma.app, luma.page)
  await expect(luma.page.getByRole('checkbox', { name: 'Distortion', exact: true })).toBeDisabled()
  await expect(luma.page.getByTestId('lens-corrections')).toContainText(
    'No verified distortion data.',
  )
})
