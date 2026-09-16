import { contextBridge, ipcRenderer } from 'electron'
import type { AppInfo, LibraryEvent, LumaApi } from '../shared/contracts'

const api: LumaApi = {
  getLensSettings: (id) => ipcRenderer.invoke('lens:get', id),
  updateLensSettings: (id, kind, enabled) => ipcRenderer.invoke('lens:update', id, kind, enabled),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:get-info'),
  listPhotos: (offset = 0) => ipcRenderer.invoke('library:list', offset),
  locatePhoto: (id, direction = 0) => ipcRenderer.invoke('library:locate', id, direction),
  getPhotoRange: (from, to) => ipcRenderer.invoke('library:range', from, to),
  requestFullPreview: async (id, token, regenerate = false) => {
    const result = await ipcRenderer.invoke('preview:request', id, token, regenerate)
    if (result.error) throw new Error(result.error)
    return result.preview
  },
  releaseFullPreview: (token) => ipcRenderer.invoke('preview:release', token),
  requestCachedFullPreview: async (id, token) => {
    const result = await ipcRenderer.invoke('preview:cached', id, token)
    if (result.error) throw new Error(result.error)
    return result.preview
  },
  deletePhotos: (ids) => ipcRenderer.invoke('library:delete', ids),
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  cancelTask: (id) => ipcRenderer.invoke('tasks:cancel', id),
  dismissTask: (id) => ipcRenderer.invoke('tasks:dismiss', id),
  getTaskErrors: (id, offset = 0) => ipcRenderer.invoke('tasks:errors', id, offset),
  chooseSource: (kind, recursive) => ipcRenderer.invoke('library:choose', kind, recursive),
  getReview: (id, offset = 0) => ipcRenderer.invoke('library:review', id, offset),
  selectCandidates: (id, ids, selected) => ipcRenderer.invoke('library:select', id, ids, selected),
  importSelected: (id) => ipcRenderer.invoke('library:import', id),
  cancelImport: (id) => ipcRenderer.invoke('library:cancel', id),
  disposeImport: (id) => ipcRenderer.invoke('library:dispose', id),
  onLibraryEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: LibraryEvent) => listener(event)
    ipcRenderer.on('library:event', handler)
    return () => {
      ipcRenderer.removeListener('library:event', handler)
    }
  },
}

contextBridge.exposeInMainWorld('luma', Object.freeze(api))
