import type { DisplayState } from './display-state'
import type { PreviewPreference } from '../shared/hdr-display'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile, rename, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import type { PhotoLibrary } from './library'
import type { EditPatch } from '../shared/edits'

/** Private, authenticated transport for enumerated operations. The application owns SQLite. */
export async function startEditorEndpoint(
  profile: string,
  library: PhotoLibrary,
  display?: DisplayState,
) {
  const token = randomBytes(32).toString('hex')
  let closing = false
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('Cache-Control', 'no-store')
    const supplied = request.headers.authorization ?? ''
    const expected = `Bearer ${token}`
    if (
      closing ||
      request.method !== 'POST' ||
      request.url !== '/editor' ||
      request.headers.origin ||
      request.headers.host !== `127.0.0.1:${port}` ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      response.writeHead(403).end(JSON.stringify({ error: 'Unauthorized editor request.' }))
      request.resume()
      return
    }
    try {
      let body = ''
      for await (const chunk of request) {
        body += chunk.toString()
        if (body.length > 16384) throw new Error('Editor request is too large.')
      }
      const {
        operation,
        photoId,
        patch,
        expectedRevision,
        offset,
        preference,
        domain,
        target,
        targetGeneration,
      } = JSON.parse(body) as {
        domain?: import('../shared/hdr-statistics').HdrAnalysisDomain
        target?: 'sdr' | 'current'
        targetGeneration?: number
        preference?: PreviewPreference
        operation: string
        photoId: string
        patch: EditPatch
        expectedRevision: number
        offset?: number
      }
      let result: unknown
      switch (operation) {
        case 'luma_get_preview_diagnostics':
          result = {
            ...library.fullPreviews.getDiagnostics(),
            presentation: display?.get().presentation,
          }
          break
        case 'luma_get_display_state':
          if (!display) throw new Error('Display state unavailable.')
          result = display.get()
          break
        case 'luma_set_preview_preference':
          if (!display || !preference) throw new Error('Display preference unavailable.')
          result = await display.set(preference)
          break
        case 'luma_upgrade_photo_processing':
          result = await library.upgradePhotoProcessing(photoId, expectedRevision)
          break
        case 'luma_list_photos':
          result = library.list(offset)
          break
        case 'luma_get_photo_statistics':
          result = await library.getPhotoStatistics(
            photoId,
            expectedRevision,
            domain === undefined ? undefined : { domain, target, targetGeneration },
          )
          break
        case 'luma_get_edits':
          result = await library.getEdits(photoId)
          break
        case 'luma_get_edit_history':
          result = await library.getEditHistory(photoId)
          break
        case 'luma_update_edits':
          result = await library.updateEdits(photoId, patch, expectedRevision)
          break
        case 'luma_undo_edit':
          result = await library.undoEdit(photoId, expectedRevision)
          break
        case 'luma_redo_edit':
          result = await library.redoEdit(photoId, expectedRevision)
          break
        default:
          throw new Error('Unknown editor operation.')
      }
      response.end(JSON.stringify({ result }))
    } catch (error) {
      response.writeHead(400).end(JSON.stringify({ error: String(error) }))
    }
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Editor endpoint is unavailable.')
  const port = address.port
  const directory = join(profile, 'editor')
  const connection = join(directory, 'connection.json')
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    await writeFile(`${connection}.tmp`, JSON.stringify({ version: 1, port, token }), {
      mode: 0o600,
    })
    await chmod(`${connection}.tmp`, 0o600)
    await rename(`${connection}.tmp`, connection)
  } catch (error) {
    server.close()
    throw error
  }
  return {
    async close() {
      closing = true
      await rm(connection, { force: true })
      server.closeIdleConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
