const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudeTerm', {
  onPtyData: (cb) => ipcRenderer.on('pty-data', (_e, data) => cb(data)),
  sendInput: (data) => ipcRenderer.send('pty-input', data),
  resize: (cols, rows) => ipcRenderer.send('pty-resize', { cols, rows }),
  onStatusUpdate: (cb) => ipcRenderer.on('status-update', (_e, status) => cb(status)),
  sendLaunchCommand: (extraFlags) => ipcRenderer.send('launch-command', extraFlags),
});
