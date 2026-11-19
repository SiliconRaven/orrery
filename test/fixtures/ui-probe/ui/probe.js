// Test fixture, not shipped: runs inside the sandboxed frame. It reports what the host sent it (init, theme, pushes)
// to its plugin through the one channel, and on a push carrying `canary` (an address of a server the test watches)
// tries everything a plugin UI must not be able to do, reports the outcomes, then tries to take its frame there.
const pending = new Map();
let serial = 0;
const request = (data) => new Promise((resolve, reject) => {
  const id = `p${++serial}`;
  pending.set(id, { resolve, reject });
  parent.postMessage({ type: 'orrery.request', id, data }, '*');
});
const report = (data) => request({ action: 'report', ...data }).catch(() => {});
const outcome = (el) => new Promise((resolve) => {
  el.onload = () => resolve('loaded');
  el.onerror = () => resolve('blocked');
  setTimeout(() => resolve('timeout'), 3000);
});
const attempt = (fn) => { try { return fn(); } catch (error) { return `threw:${error.name}`; } };

async function probes(canary) {
  const r = {};
  r.origin = String(self.origin);
  r.parentDocument = attempt(() => (parent.document ? `read:${parent.document.title}` : 'none'));
  r.cookie = attempt(() => `read:${document.cookie}`);
  r.localStorage = attempt(() => { localStorage.setItem('probe', '1'); return 'read'; });
  r.sessionStorage = attempt(() => { sessionStorage.setItem('probe', '1'); return 'read'; });
  r.windowOpen = attempt(() => (window.open(`${canary}/popup`) ? 'opened' : 'null'));
  r.topNavigation = attempt(() => { top.location.href = `${canary}/top`; return 'assigned'; });
  r.fetchHub = await fetch(new URL('/api/state', location.href)).then((res) => `status:${res.status}`, (error) => `rejected:${error.name}`);
  r.fetchCanary = await fetch(`${canary}/fetch`).then((res) => `status:${res.status}`, (error) => `rejected:${error.name}`);
  const script = document.createElement('script');
  const scriptDone = outcome(script);
  script.src = `${canary}/script.js`;
  document.head.append(script);
  r.externalScript = await scriptDone;
  const image = new Image();
  const imageDone = outcome(image);
  image.src = `${canary}/image.png`;
  r.externalImage = await imageDone;
  const own = new Image();
  const ownDone = outcome(own);
  own.src = 'dot.png';
  r.ownImage = await ownDone;
  r.inlineScript = attempt(() => {
    const el = document.createElement('script');
    el.textContent = 'globalThis.inlineRan = true;';
    document.head.append(el);
    return globalThis.inlineRan ? 'ran' : 'blocked';
  });
  r.style = getComputedStyle(document.body).color;
  r.module = globalThis.probeModule === true ? 'loaded' : 'missing';
  return r;
}

addEventListener('message', async (event) => {
  if (event.source !== parent) return;
  const message = event.data;
  if (message?.type === 'orrery.response') {
    const waiting = pending.get(message.id);
    pending.delete(message.id);
    if (message.ok) waiting?.resolve(message.result); else waiting?.reject(new Error(message.error?.code));
  } else if (message?.type === 'orrery.init') {
    void report({ kind: 'init', position: message.position, clusterId: message.clusterId, theme: message.theme, language: message.language });
  } else if (message?.type === 'orrery.theme') {
    void report({ kind: 'theme', theme: message.theme });
  } else if (message?.type === 'orrery.push') {
    if (typeof message.data?.canary !== 'string') { void report({ kind: 'push', data: message.data }); return; }
    const results = await probes(message.data.canary);
    await report({ kind: 'probe', results });
    location.href = `${message.data.canary}/navigate`;
  }
});

parent.postMessage({ type: 'orrery.ready' }, '*');
