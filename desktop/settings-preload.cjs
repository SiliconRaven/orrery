// The settings view's narrow interface (docs/desktop.md "应用位置"). Loaded only into the settings view's window
// (ui/settings.html). It receives the rows to show and sends back a supported app's id with one action (detect, use
// what was detected, with the token the main process gave that offer; pick a program file; clear) or a close, nothing
// else: never a path. The main process checks the sender, the id and the token, runs the detection and the file dialog
// itself, and checks every path before it is saved.
const { contextBridge, ipcRenderer } = require('electron');

const id = (v) => (typeof v === 'string' ? v : '');

contextBridge.exposeInMainWorld('orrery', {
  onState: (callback) => ipcRenderer.on('settings:state', (_event, state) => callback(state)),
  detect: (app) => ipcRenderer.send('settings:detect', id(app)),
  use: (app, token) => ipcRenderer.send('settings:use', { app: id(app), token: id(token) }),
  pick: (app) => ipcRenderer.send('settings:pick', id(app)),
  clear: (app) => ipcRenderer.send('settings:clear', id(app)),
  close: () => ipcRenderer.send('settings:close'),
});
