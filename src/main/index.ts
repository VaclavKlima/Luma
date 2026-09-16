import { photoExtensions } from './processing/formats'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  screen,
  shell,
  type IpcMainInvokeEvent,
} from 'electron'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { AppInfo } from '../shared/contracts'
import { PhotoLibrary } from './library'
import { PreviewProcess } from './preview-process'

app.setName('Luma')

let mainWindow: BrowserWindow | null = null
let library: PhotoLibrary | undefined
let quitting = false
let picking = false
let quitPending = false

async function requestQuit(): Promise<void> {
  if (quitting || quitPending) return
  quitPending = true
  try {
    if (library?.hasActiveTask()) {
      const options = {
        type: 'question' as const,
        title: 'A library task is still running',
        message: 'Keep working on your photos?',
        detail:
          'Cancellation stops remaining work after the current operation finishes. Completed imports and moves to Trash are kept.',
        buttons: ['Keep working', 'Cancel task and quit'],
        defaultId: 0,
        cancelId: 0,
      }
      const result = mainWindow
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options)
      if (result.response !== 1) return
    }
    quitting = true
    await library?.close()
    app.quit()
  } catch (error) {
    console.error('Could not finish application cleanup:', error)
    quitting = true
    app.quit()
  } finally {
    quitPending = false
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'luma-photo',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
])
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  mainWindow?.restore()
  mainWindow?.focus()
})

function trusted(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  )
    throw new Error('Untrusted library request.')
}

function createWindow(): void {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const window = new BrowserWindow({
    title: 'Luma',
    width: Math.min(1440, width),
    height: Math.min(900, height),
    minWidth: 1100,
    minHeight: 700,
    useContentSize: true,
    show: false,
    backgroundColor: '#17191a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  mainWindow = window
  const releasePreview = () => {
    void library?.fullPreviews.release().catch(() => undefined)
  }
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) releasePreview()
  })
  window.webContents.on('render-process-gone', releasePreview)
  window.webContents.on('destroyed', releasePreview)

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (!quitting && library?.hasActiveTask()) {
      event.preventDefault()
      void requestQuit()
    }
  })
  window.on('closed', () => {
    mainWindow = null
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  const loading =
    !app.isPackaged && devUrl
      ? window.loadURL(devUrl)
      : window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  loading.catch((error: unknown) => {
    console.error('Could not load the Luma interface:', error)
    app.exit(1)
  })
}

app
  .whenReady()
  .then(async () => {
    Menu.setApplicationMenu(
      process.platform === 'darwin'
        ? Menu.buildFromTemplate([
            { role: 'appMenu' },
            { role: 'editMenu' },
            { role: 'windowMenu' },
          ])
        : null,
    )

    ipcMain.handle('app:get-info', (event): AppInfo => {
      if (
        !mainWindow ||
        event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame
      ) {
        throw new Error('Untrusted application information request')
      }
      return { version: app.getVersion(), platform: process.platform as AppInfo['platform'] }
    })

    library = new PhotoLibrary(
      join(app.getPath('userData'), 'library'),
      new PreviewProcess(),
      (event) => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('library:event', event)
      },
      undefined,
      (path) => shell.trashItem(path),
    )
    await library.open()
    protocol.handle('luma-photo', async (request) => {
      if (request.method !== 'GET') return new Response(null, { status: 404 })
      const asset = library?.fullPreviews.acquire(new URL(request.url))
      if (asset) {
        const stream = createReadStream(asset.path)
        const abort = () => stream.destroy()
        request.signal.addEventListener('abort', abort, { once: true })
        stream.once('close', () => {
          request.signal.removeEventListener('abort', abort)
          asset.release()
        })
        if (request.signal.aborted) stream.destroy()
        return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
          headers: {
            'Content-Type': asset.contentType,
            'Content-Length': String(asset.byteLength),
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
          },
        })
      }
      const path = library?.imagePath(request.url)
      if (!path || request.method !== 'GET') return new Response(null, { status: 404 })
      try {
        return new Response(await readFile(path), {
          headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' },
        })
      } catch {
        return new Response(null, { status: 404 })
      }
    })
    ipcMain.handle('lens:get', (event, id) => {
      trusted(event)
      return library!.getLensSettings(id)
    })
    ipcMain.handle('lens:update', (event, id, kind, enabled) => {
      trusted(event)
      return library!.updateLensSettings(id, kind, enabled)
    })
    ipcMain.handle('library:list', (event, offset: number) => {
      trusted(event)
      return library!.list(offset)
    })
    ipcMain.handle('preview:request', (event, id: string, token: string, regenerate = false) => {
      trusted(event)
      // Preview failures are expected UI states, not uncaught IPC exceptions.
      return library!.fullPreviews.request(id, token, regenerate).then(
        (preview) => ({ preview }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      )
    })
    ipcMain.handle('preview:cached', (event, id: string, token: string) => {
      trusted(event)
      return library!.fullPreviews.requestCached(id, token).then(
        (preview) => ({ preview }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      )
    })
    ipcMain.handle('preview:release', (event, token: string) => {
      trusted(event)
      if (typeof token !== 'string') throw new Error('Invalid preview request token.')
      return library!.fullPreviews.release(token)
    })
    ipcMain.handle('library:locate', (event, id: string, direction: -1 | 0 | 1) => {
      trusted(event)
      return library!.locate(id, direction)
    })
    ipcMain.handle('library:range', (event, from: string, to: string) => {
      trusted(event)
      return library!.range(from, to)
    })
    ipcMain.handle('library:delete', (event, ids: string[]) => {
      trusted(event)
      if (picking) throw new Error('Close the file picker first.')
      return library!.deletePhotos(ids)
    })
    ipcMain.handle('tasks:list', (event) => {
      trusted(event)
      return library!.listTasks()
    })
    ipcMain.handle('tasks:cancel', (event, id: string) => {
      trusted(event)
      return library!.cancelTask(id)
    })
    ipcMain.handle('tasks:dismiss', (event, id: string) => {
      trusted(event)
      library!.dismissTask(id)
    })
    ipcMain.handle('tasks:errors', (event, id: string, offset: number) => {
      trusted(event)
      return library!.taskErrors(id, offset)
    })
    ipcMain.handle('library:choose', async (event, kind: unknown, recursive: unknown) => {
      trusted(event)
      if ((kind !== 'files' && kind !== 'folder') || typeof recursive !== 'boolean')
        throw new Error('Invalid import source.')
      if (picking) throw new Error('A file picker is already open.')
      if (library!.hasActiveTask())
        throw new Error('Finish or cancel the current library operation first.')
      picking = true
      try {
        const result = await dialog.showOpenDialog(mainWindow!, {
          title: kind === 'folder' ? 'Choose a photo folder' : 'Choose photos',
          properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
          ...(kind === 'files'
            ? {
                filters: [{ name: 'Photographs', extensions: photoExtensions }],
              }
            : {}),
        })
        if (result.canceled || !result.filePaths.length) return null
        return await library!.scan(result.filePaths, recursive)
      } finally {
        picking = false
      }
    })
    ipcMain.handle('library:review', (event, id: string, offset: number) => {
      trusted(event)
      return library!.review(id, offset)
    })
    ipcMain.handle(
      'library:select',
      (event, id: string, ids: string[] | null, selected: boolean) => {
        trusted(event)
        library!.select(id, ids, selected)
      },
    )
    ipcMain.handle('library:import', (event, id: string) => {
      trusted(event)
      library!.importSelected(id)
    })
    ipcMain.handle('library:cancel', (event, id: string) => {
      trusted(event)
      return library!.cancel(id)
    })
    ipcMain.handle('library:dispose', (event, id: string) => {
      trusted(event)
      return library!.dispose(id)
    })

    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  .catch((error: unknown) => {
    console.error('Could not start Luma:', error)
    app.exit(1)
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting || !library) return
  event.preventDefault()
  void requestQuit()
})
