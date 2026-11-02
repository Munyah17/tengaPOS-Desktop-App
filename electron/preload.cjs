const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('tengaDesktop', {
  isDesktop: true,
})
