const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("softwareBlocker", {
  getState: () => ipcRenderer.invoke("get-state"),
  pickApps: () => ipcRenderer.invoke("pick-apps"),
  listRunningApps: () => ipcRenderer.invoke("list-running-apps"),
  initializePin: (payload) => ipcRenderer.invoke("initialize-pin", payload),
  verifyPin: (payload) => ipcRenderer.invoke("verify-pin", payload),
  saveSettings: (payload) => ipcRenderer.invoke("save-settings", payload),
  changePin: (payload) => ipcRenderer.invoke("change-pin", payload),
  onStateUpdated: (callback) => ipcRenderer.on("state-updated", callback)
});
