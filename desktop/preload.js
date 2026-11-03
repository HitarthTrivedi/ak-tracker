const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('akDesktop', {
  isDesktop: true,
  saveSetup: (cfg) => ipcRenderer.invoke('setup:save', cfg),
});
