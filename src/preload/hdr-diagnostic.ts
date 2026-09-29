import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('hdrDiagnostic', {
  onResume(callback: () => void): () => void {
    const listener = () => callback()
    ipcRenderer.on('hdr-diagnostic:resume', listener)
    return () => ipcRenderer.removeListener('hdr-diagnostic:resume', listener)
  },
})
