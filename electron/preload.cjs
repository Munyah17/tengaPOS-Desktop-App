const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tengaDesktop', {
  isDesktop: true,
  getLicenseDeviceIdentity: () => ipcRenderer.invoke('license:get-device-identity'),
  signLicenseCheckIn: (message) => ipcRenderer.invoke('license:sign-check-in', message),
})
