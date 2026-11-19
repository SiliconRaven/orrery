// Runs in a sandboxed frame: no cookies, storage, network or access to the page around it. Everything goes through
// postMessage to the host page: orrery.ready once loaded, orrery.request for the plugin process; the host sends
// orrery.init, orrery.theme, orrery.response and orrery.push.
const $ = (id) => document.getElementById(id);
const pending = new Map();
let serial = 0;

/** One request to this plugin's own process; resolves with its result, rejects with the host's or plugin's error. */
function request(data) {
  const id = `r${++serial}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parent.postMessage({ type: 'orrery.request', id, data }, '*');
  });
}

function applyTheme(theme) {
  const root = document.documentElement;
  root.style.colorScheme = theme.scheme;
  for (const [token, colour] of Object.entries(theme.colors ?? {})) root.style.setProperty(`--${token}`, colour);
}

const show = (count) => { $('count').textContent = String(count); };

addEventListener('message', (event) => {
  // Only the host page talks to this frame.
  if (event.source !== parent) return;
  const message = event.data;
  if (message?.type === 'orrery.init') {
    applyTheme(message.theme);
    $('where').textContent = message.position === 'titlebar' ? '标题栏面板' : '任务工作台';
    request({ action: 'get' }).then((result) => { show(result.count); $('add').disabled = false; })
      .catch((error) => { $('note').textContent = error.message; });
  } else if (message?.type === 'orrery.theme') applyTheme(message.theme);
  else if (message?.type === 'orrery.push') show(message.data.count);
  else if (message?.type === 'orrery.response') {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.result); else waiting.reject(new Error(`${message.error.code}: ${message.error.message}`));
  }
});

$('add').addEventListener('click', () => {
  request({ action: 'add' }).then((result) => { show(result.count); $('note').textContent = ''; })
    .catch((error) => { $('note').textContent = error.message; });
});

parent.postMessage({ type: 'orrery.ready' }, '*');
