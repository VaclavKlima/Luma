import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'

test('stdio editing tools share persisted history with UI without a development debug endpoint', async ({
  luma,
}) => {
  test.setTimeout(90000)
  await importPhotos(luma.app, luma.page, ['tests/fixtures/sony-zv1.ARW'])
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('scripts/editor-mcp.mjs')],
    env: { ...(process.env as Record<string, string>), LUMA_PROFILE: luma.userDataDir },
  })
  const client = new Client({ name: 'luma-editor-test', version: '1' })
  try {
    await client.connect(transport)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'luma_get_photo_statistics',
      'luma_list_photos',
      'luma_get_edits',
      'luma_get_edit_history',
      'luma_update_edits',
      'luma_undo_edit',
      'luma_redo_edit',
    ])
    const call = async (name: string, args = {}) => {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError).not.toBe(true)
      return result.structuredContent as Record<string, unknown>
    }
    const page = await call('luma_list_photos')
    const photoId = (page.photos as { id: string }[])[0].id
    expect(await call('luma_get_edits', { photoId })).toMatchObject({ revision: 0 })
    const highlightsDraft = luma.page.getByRole('spinbutton', { name: 'Highlights value' })
    await expect(highlightsDraft).toBeEnabled({ timeout: 30000 })
    await highlightsDraft.fill('20')
    expect(
      await call('luma_update_edits', {
        photoId,
        expectedRevision: 0,
        patch: {
          shadows: 65,
          whites: -35,
          blacks: 20,
          whiteBalance: { mode: 'custom', kelvin: 7000, tint: 15 },
          exposureEv: 1.25,
          contrast: 37,
          highlights: -65,
          lens: { distortion: false },
        },
      }),
    ).toMatchObject({
      revision: 1,
      settings: {
        shadows: 65,
        whites: -35,
        blacks: 20,
        exposureEv: 1.25,
        contrast: 37,
        highlights: -65,
        lens: { distortion: false },
      },
    })
    await expect(luma.page.getByRole('spinbutton', { name: 'Exposure value' })).toHaveValue('1.25')
    await expect(luma.page.getByRole('spinbutton', { name: 'Contrast value' })).toHaveValue('37')
    await expect(luma.page.getByRole('spinbutton', { name: 'Highlights value' })).toHaveValue('-65')
    for (const [label, value] of [
      ['Shadows', '65'],
      ['Whites', '-35'],
      ['Blacks', '20'],
    ])
      await expect(luma.page.getByRole('spinbutton', { name: `${label} value` })).toHaveValue(value)
    await highlightsDraft.press('Enter')
    await expect(luma.page.getByRole('spinbutton', { name: 'Temperature value' })).toHaveValue(
      '7000',
    )
    await expect(luma.page.getByRole('spinbutton', { name: 'Tint value' })).toHaveValue('15')
    await expect
      .poll(
        async () => {
          const result = await client.callTool({
            name: 'luma_get_photo_statistics',
            arguments: { photoId, expectedRevision: 1 },
          })
          return result.isError ? null : result.structuredContent
        },
        { timeout: 60000 },
      )
      .toMatchObject({ photoId, revision: 1, colorSpace: 'srgb', dynamicRange: 'sdr' })
    expect(
      (
        await client.callTool({
          name: 'luma_get_photo_statistics',
          arguments: { photoId, expectedRevision: 0 },
        })
      ).isError,
    ).toBe(true)

    for (const key of ['contrast', 'highlights', 'shadows', 'whites', 'blacks'])
      for (const value of [-101, 101, 0.25, '20', null]) {
        const invalid = await client.callTool({
          name: 'luma_update_edits',
          arguments: { photoId, expectedRevision: 1, patch: { [key]: value } },
        })
        expect(invalid.isError).toBe(true)
      }
    const conflict = await client.callTool({
      name: 'luma_update_edits',
      arguments: { photoId, expectedRevision: 0, patch: { exposureEv: 2 } },
    })
    expect(conflict.isError).toBe(true)
    expect(await call('luma_get_edit_history', { photoId })).toMatchObject({
      cursor: 1,
      snapshots: [
        {
          settings: { shadows: 0, whites: 0, blacks: 0, exposureEv: 0, contrast: 0, highlights: 0 },
        },
        {
          settings: {
            shadows: 65,
            whites: -35,
            blacks: 20,
            exposureEv: 1.25,
            contrast: 37,
            highlights: -65,
            lens: { distortion: false },
          },
        },
      ],
    })
    await luma.page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(luma.page.getByRole('spinbutton', { name: 'Exposure value' })).toHaveValue('0.00')
    expect(await call('luma_redo_edit', { photoId, expectedRevision: 2 })).toMatchObject({
      revision: 3,
      settings: {
        shadows: 65,
        whites: -35,
        blacks: 20,
        exposureEv: 1.25,
        contrast: 37,
        highlights: -65,
        lens: { distortion: false },
      },
    })
    await call('luma_undo_edit', { photoId, expectedRevision: 3 })
    const connectionPath = join(luma.userDataDir, 'editor', 'connection.json')
    const connection = JSON.parse(await readFile(connectionPath, 'utf8'))
    if (process.platform !== 'win32') expect((await stat(connectionPath)).mode & 0o777).toBe(0o600)
    const response = await fetch(`http://127.0.0.1:${connection.port}/editor`, {
      method: 'POST',
      body: '{}',
    })
    expect(response.status).toBe(403)
    const browser = await fetch(`http://127.0.0.1:${connection.port}/editor`, {
      method: 'POST',
      headers: { Origin: 'https://example.com', Authorization: `Bearer ${connection.token}` },
      body: '{}',
    })
    expect(browser.status).toBe(403)
    await luma.restart()
    expect(await call('luma_get_edits', { photoId })).toMatchObject({
      revision: 4,
      settings: { shadows: 0, whites: 0, blacks: 0, exposureEv: 0, contrast: 0, highlights: 0 },
      canRedo: true,
    })
  } finally {
    await client.close()
    await transport.close()
  }
})
