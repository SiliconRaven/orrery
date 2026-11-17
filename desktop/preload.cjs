// The tab bar's narrow interface (docs/desktop.md "安全边界" 5). Loaded only into the tab bar's window; the
// collaboration page has no preload, the "+" panel has its own (strip-preload.cjs). CommonJS, because a sandboxed
// preload cannot be an ES module. Every call carries at most a tab id, a pane number, two divider positions or the
// left edge of "+" or of the gear: the main process looks up windows, positions and flags itself, and checks the sender and the values.
const { contextBridge, ipcRenderer } = require('electron');

const id = (v) => (typeof v === 'string' ? v : '');

contextBridge.exposeInMainWorld('orrery', {
  onState(callback) {
    ipcRenderer.on('tabs:state', (_event, state) => callback(state));
    ipcRenderer.send('tabs:hello');
  },
  select: (tab) => ipcRenderer.send('tabs:select', id(tab)),
  close: (tab) => ipcRenderer.send('tabs:close', id(tab)),
  add: (x) => ipcRenderer.send('tabs:add', Number(x)),
  settings: (x) => ipcRenderer.send('tabs:settings', Number(x)),
  pressed: () => ipcRenderer.send('tabs:press'),
  retry: () => ipcRenderer.send('tabs:retry'),
  dismiss: () => ipcRenderer.send('tabs:dismiss'),
  layoutMenu: () => ipcRenderer.send('layout:menu'),
  activate: (pane) => ipcRenderer.send('pane:activate', Number.isInteger(pane) ? pane : -1),
  ratios: (r) => ipcRenderer.send('layout:ratios', { x: Number(r?.x), y: Number(r?.y) }),
});
