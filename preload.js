const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudeTerm', {
  createSession: (opts) => ipcRenderer.invoke('session-create', opts),
  closeSession: (id) => ipcRenderer.send('session-close', id),
  listHistory: () => ipcRenderer.invoke('history-list'),
  listLive: () => ipcRenderer.invoke('sessions-live'),
  sessionDetail: (id) => ipcRenderer.invoke('session-detail', id),
  sendInput: (id, data) => ipcRenderer.send('pty-input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty-resize', { id, cols, rows }),
  onPtyData: (cb) => ipcRenderer.on('pty-data', (_e, msg) => cb(msg)),
  onStatusUpdate: (cb) => ipcRenderer.on('status-update', (_e, msg) => cb(msg)),
  onSessionExit: (cb) => ipcRenderer.on('session-exit', (_e, msg) => cb(msg)),
});
