// The "+" panel's narrow interface (docs/desktop.md "安全边界" 5). Loaded only into the panel's window (ui/strip.html).
// It receives the apps to show and sends back a supported app's id (a pick) or a close, nothing else; the main process
// checks the sender and the id against its own app list, and looks up windows and start targets itself.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orrery', {
  onState: (callback) => ipcRenderer.on('strip:state', (_event, state) => callback(state)),
  pick: (app) => ipcRenderer.send('strip:pick', typeof app === 'string' ? app : ''),
  close: () => ipcRenderer.send('strip:close'),
});
