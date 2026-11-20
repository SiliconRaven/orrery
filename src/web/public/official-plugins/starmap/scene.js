// The star map's sky (docs/starmap.md「星空里的东西」「3. 网页模块」): galaxies (groups), star systems (clusters) with
// their star (the Hub) and planets (members), satellites (notices waiting for the user), the black hole (recycle bin),
// the cluster list, three themes and an FPS readout. Ported from mockups/orrery-theme-3d.html, with its render rule:
// a frame is drawn only when something changed or moves (requestRender), never in a free-running loop.
// Data comes only from the existing APIs and the page's event stream (ctx.onEvent); the only thing kept is this
// browser's theme and its 知道了 record (localStorage). Every text from the Hub goes in as text (h(), textContent).
import { onLanguageChange, t } from '../../i18n.js';
import { fmtTime, h, icon, lt, noticeDialog } from '../../ui.js';
import { openTrash } from '../../trash.js';
import {
  applySkyEvent, createSkyState, dismissedStore, harnessInfo, hashStr, keyAction, layoutSky, loadSnapshot, orbitFractions, rng,
  SAT_ICON, SATELLITE_COLOR, setMessages, skyKey, skyModel,
} from './data.js';
import { createFinder } from './finder.js';
import { readTheme, saveTheme, THEME_ICON, THEME_ORDER, THEMES } from './themes.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const smooth = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
function hexRGB(hex) { const n = parseInt(hex.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
const toHex = (rgb) => '#' + rgb.map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');

/** A static SVG drawing from element specs [tag, attributes, children?] (themes.js THEME_ICON, SAT_ICON, the toolbar's glyphs). */
function svgFrom(specs, viewBox = '0 0 24 24', cls = '') {
  const make = ([tag, attrs, children]) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    for (const child of children ?? []) node.append(make(child));
    return node;
  };
  const root = make(['svg', { viewBox, 'aria-hidden': 'true', ...(cls ? { class: cls } : {}) }]);
  for (const spec of specs) root.append(make(spec));
  return root;
}
const PAUSE_ICON = [['rect', { x: 4, y: 3, width: 2.6, height: 10, rx: 0.8, fill: 'currentColor' }], ['rect', { x: 9.4, y: 3, width: 2.6, height: 10, rx: 0.8, fill: 'currentColor' }]];
const PLAY_ICON = [['path', { d: 'M5 3.2v9.6c0 .5.5.8.9.5l7-4.8a.6.6 0 0 0 0-1L5.9 2.7c-.4-.3-.9 0-.9.5z', fill: 'currentColor' }]];
const RESET_ICON = [['path', { d: 'M3.2 6.2A5 5 0 1 1 3 9.6', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round' }],
  ['path', { d: 'M3 2.8v3.6h3.6', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]];
const satIcon = (level) => svgFrom(SAT_ICON[level], '0 0 16 16', `sm-k-${level}`);

/** Harness glyphs printed on planets (static drawings, loaded as images; unknown harnesses get none). */
const GLYPH = {
  claude: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff6ec" stroke-width="2.6" stroke-linecap="round"><path d="M12 3.5v5M12 15.5v5M3.5 12h5M15.5 12h5M6 6l3.5 3.5M14.5 14.5 18 18M18 6l-3.5 3.5M9.5 14.5 6 18"/></svg>',
  codex: '<svg viewBox="0 0 24 24" fill="none" stroke="#0b2a22" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 7.5 10.5 12 6 16.5M13 17h5.5"/></svg>',
  kimi: '<svg viewBox="0 0 24 24"><path d="M15 3.8a8.6 8.6 0 1 0 5.4 14.6A7 7 0 1 1 15 3.8z" fill="#fbf8ff"/></svg>',
  deepseek: '<svg viewBox="0 0 24 24"><path d="M3.5 13c2.6-4.6 7.6-5.6 10.6-2.6 1.6 1.6 3.7 1.5 6.2-.6-.7 5-4.6 8.2-9.4 8.2-3.6 0-6-1.8-7.4-5z" fill="#f2f5ff"/><circle cx="9" cy="13.2" r="1.1" fill="#2a4bb8"/></svg>',
  cursor: '<svg viewBox="0 0 24 24" fill="none" stroke="#252a36" stroke-width="1.9" stroke-linejoin="round"><path d="M12 3.5 19.5 7.8v8.4L12 20.5 4.5 16.2V7.8z"/><path d="M4.5 7.8 12 12l7.5-4.2M12 12v8.5"/></svg>',
  qoder: '<svg viewBox="0 0 24 24" fill="none" stroke="#f3f5f7" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="5.6"/><path d="M15.2 15.2 19 19"/></svg>',
  antigravity: '<svg viewBox="0 0 24 24" fill="none" stroke="#3a2a06" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 18.5 12 5.5l7 13"/><path d="M8.6 13.5h6.8"/></svg>',
};

const STAR_VS = `uniform float uTime, uDpr, uAmp, uFreq, uGain; attribute float aSize; attribute float aPh; attribute vec3 aColor; varying vec3 vC;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
  float tw = 1.0 - uAmp + uAmp * sin(uTime * uFreq * (0.15 + fract(aPh * 7.13) * 0.35) + aPh);
  vC = aColor * tw * uGain; gl_PointSize = aSize * uDpr; }`;
const STAR_FS = `varying vec3 vC; void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = 1.0 - smoothstep(0.0, 1.0, d); gl_FragColor = vec4(vC, a * a); }`;
// galaxy points: size in world units, faded when very close to the camera (inside a galaxy) or sub-pixel (far away)
const GAL_VS = `uniform float uScale, uOpacity, uNear, uMaxPx; attribute float aSize; attribute float aAlpha; attribute vec3 aColor; varying vec3 vC; varying float vA;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); float d = -mv.z;
  float px = aSize * uScale / max(d, 0.001);
  float a = aAlpha * uOpacity * smoothstep(uNear * 0.35, uNear, d);
  if (px < 1.5) { a *= px / 1.5; px = 1.5; }
  vC = aColor; vA = a; gl_PointSize = min(px, uMaxPx); gl_Position = projectionMatrix * mv; }`;
const GAL_FS = `varying vec3 vC; varying float vA; void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; if (d > 1.0) discard; float f = 1.0 - d; f = f * f * (3.0 - 2.0 * f); gl_FragColor = vec4(vC, vA * f); }`;
const SUN_VS = 'varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }';
const SUN_FS = `uniform sampler2D uMap; uniform float uT, uHot, uGain; uniform vec3 uEdge, uMid, uCore; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main(){ float ndv = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
    float gran = texture2D(uMap, vUv * vec2(2.0, 1.0) + vec2(uT * 0.002, 0.0)).r;
    vec3 c = mix(uEdge, uMid, smoothstep(0.0, 0.55, ndv));
    c = mix(c, uCore, smoothstep(0.55, 1.0, ndv) * 0.8);
    c *= (1.0 + 0.16 * (gran - 0.5)) * uGain; c += uHot * 0.05;
    gl_FragColor = vec4(c, 1.0); }`;

const LEVEL_DEPTH = { universe: 0, galaxy: 1, system: 2 };
const LEVELS = ['universe', 'galaxy', 'system'];
const LIMITS = { universe: [0.25, 1.3], galaxy: [0.2, 1.28], system: [0.35, 1.4] };
const PRIORITY = { sat: 3, planet: 2, sun: 1, msys: 1, galaxy: 1, bh: 1 };
const PHASE0 = [0.5, 2.4, 4.2, 5.5, 1.3, 3.3];
const O = { R: 10, sunR: 1.12, pr: 0.62 };
const TOP_SAFE = 52;
const MAX_SPARKS = 30;   // lights in the black hole's disk; more clusters in the bin only change the count
const galaxyName = (name) => (name ? name : t('未分组'));

/**
 * Builds the sky in `el` and returns { dispose }. `THREE` and `OrbitControls` are the vendored modules; `windowsModule`
 * is the chat windows module (starmap/windows.js) or null, then the star and the planets open the chat page instead.
 * `signal`: aborted when the view closed while the data was still loading (nothing is built then).
 */
export async function createScene({ THREE, OrbitControls, el, ctx, windowsModule = null, signal = null }) {
  const V3 = THREE.Vector3;
  const ac = new AbortController();
  const on = (target, type, fn, opts = {}) => target.addEventListener(type, fn, { ...opts, signal: ac.signal });
  let closed = false;
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); if (!closed) fn(); }, ms); timers.add(id); return id; };
  const cancel = (id) => { clearTimeout(id); timers.delete(id); };

  // ---- the frame: everything lives in one root over the view's container ----
  const storage = (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();
  let themeName = readTheme(storage);
  let T = THEMES[themeName];
  // Focusable (not in the tab order) so the keys work from the start: the scene takes focus once it is drawn.
  const root = h('div', { class: 'starmap', 'data-sm-theme': themeName, tabindex: '-1', role: 'region', 'aria-label': lt('星图'),
    'aria-keyshortcuts': '/ Control+K Escape F' });
  const css = h('link', { rel: 'stylesheet', href: new URL('./scene.css', import.meta.url).href });
  const status = h('div', { class: 'sm-status', role: 'status' }, lt('正在打开星图…'));
  root.append(css, status);
  el.append(root);
  const applyCss = () => { for (const [k, v] of Object.entries(T.css)) root.style.setProperty(k, v); root.dataset.smTheme = themeName; };
  applyCss();
  const fail = (text) => { status.textContent = text; status.classList.add('sm-failed'); status.hidden = false; };

  // The stream first, so nothing that happens while a snapshot (GET /api/state) is read is lost: its frames are kept
  // and applied again over the snapshot (loadSnapshot: only those newer than its seq). Live once the sky is drawn.
  const state = createSkyState();
  let ready = false, reads = 0;
  const kept = [];
  const stopEvents = ctx.onEvent((event) => {
    if (closed) return;
    if (reads) kept.push(event);
    if (ready) react(event);
  });
  /** A snapshot read starts; the returned function ends it (the kept frames go when no read is left). */
  const snapshotRead = () => {
    reads++;
    let open = true;
    return () => { if (open) { open = false; if (!--reads) kept.length = 0; } };
  };
  const stop = () => { closed = true; ac.abort(); try { stopEvents(); } catch { /* the host unsubscribes it too */ } root.remove(); };

  // the stylesheet and the data, together
  const hubKey = globalThis.location?.host || 'hub';
  const dismissed = dismissedStore(storage, hubKey);
  let trashRows = [], early = [];
  const firstRead = snapshotRead();
  try {
    const [snapshot, harnesses, trash] = await Promise.all([
      ctx.api('GET', '/api/state'),
      ctx.api('GET', '/api/harnesses').catch(() => null),
      ctx.api('GET', '/api/clusters?deleted=true').catch(() => []),
      new Promise((resolve) => { css.addEventListener('load', resolve, { once: true }); css.addEventListener('error', resolve, { once: true }); setTimeout(resolve, 3000); }),
    ]);
    if (signal?.aborted) throw new Error('closed');
    early = loadSnapshot(state, snapshot, harnesses, kept);
    trashRows = Array.isArray(trash) ? trash : [];
  } catch (error) {
    if (signal?.aborted) { stop(); return { dispose() {} }; }
    if (!closed) fail(t('读取群聊失败：{message}', { message: error?.message ?? String(error) }));
    return { dispose: stop };
  } finally { firstRead(); }

  let renderer;
  try {
    const probe = document.createElement('canvas').getContext('webgl2');
    if (!probe) throw new Error('no webgl2');
    probe.getExtension('WEBGL_lose_context')?.loseContext();
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch {
    fail(t('这台设备没有可用的 WebGL 2，星图无法显示。'));
    return { dispose: stop };
  }
  status.hidden = true;

  let W = Math.max(1, root.clientWidth), H = Math.max(1, root.clientHeight), DPR = Math.min(2, globalThis.devicePixelRatio || 1);
  const mqReduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  let reduced = Boolean(mqReduce?.matches);
  renderer.setPixelRatio(DPR);
  renderer.setSize(W, H);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  const canvas = renderer.domElement;
  canvas.className = 'sm-gl';
  canvas.setAttribute('aria-hidden', 'true');
  const labelLayer = h('div', { class: 'sm-labels', role: 'group', 'aria-label': lt('天体') });
  const crumbs = h('nav', { class: 'sm-crumbs', 'aria-label': lt('层级') });
  const hint = h('div', { class: 'sm-hint', 'aria-hidden': 'true' });
  const sysTitle = h('button', { type: 'button', class: 'sm-systitle', hidden: true });
  const winRoot = h('div', { class: 'sm-windows' });
  const card = h('div', { class: 'sm-card', role: 'tooltip' });
  const tip = h('div', { class: 'sm-tip', role: 'tooltip' });
  const ncard = h('div', { class: 'sm-ncard', role: 'dialog', 'aria-label': lt('系统通知') });
  const hudEl = h('div', { class: 'sm-hud', hidden: true });
  const finderBtn = h('button', { type: 'button', class: 'sm-tb', 'aria-expanded': 'false', title: lt('群聊列表（/ 或 Ctrl+K）'), 'aria-label': lt('群聊列表') }, icon('search'));
  const pauseBtn = h('button', { type: 'button', class: 'sm-tb', 'aria-pressed': 'false' });
  const resetBtn = h('button', { type: 'button', class: 'sm-tb', title: lt('复位视角（也可以双击空白处）'), 'aria-label': lt('复位视角') }, svgFrom(RESET_ICON, '0 0 16 16'));
  const themeBtn = h('button', { type: 'button', class: 'sm-tb sm-theme-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  const helpBtn = h('button', { type: 'button', class: 'sm-tb', 'aria-expanded': 'false', title: lt('图例与操作说明'), 'aria-label': lt('图例与操作说明') }, icon('help'));
  const tools = h('div', { class: 'sm-tools', role: 'toolbar', 'aria-label': lt('视图') }, finderBtn, pauseBtn, resetBtn, themeBtn, helpBtn);
  const themeMenu = h('div', { class: 'sm-menu', role: 'menu', 'aria-label': lt('主题'), hidden: true });
  const help = h('div', { class: 'sm-help', role: 'dialog', 'aria-label': lt('图例与操作说明'), hidden: true });
  root.append(canvas, labelLayer, hint, sysTitle, winRoot, crumbs, tools, themeMenu, help, card, tip, ncard, hudEl);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, W / H, 0.1, 16000);
  scene.add(camera);
  const controls = new OrbitControls(camera, canvas);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.09, enablePan: false, enableZoom: false, rotateSpeed: 0.5 });
  const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();
  const DEG = Math.PI / 180;
  const pxPerUnitAt1 = () => (H * DPR) / (2 * Math.tan((camera.fov * DEG) / 2));
  const mute = (hex, k = T.planet.mute) => { const a = hexRGB(hex), g = hexRGB(T.planet.toward); return toHex(a.map((v, i) => lerp(v, g[i], k))); };
  const SEV_HEX = () => ({ problem: T.css[SATELLITE_COLOR.problem], attention: T.css[SATELLITE_COLOR.attention] });

  // ---- textures, made here (no image files) ----
  function canvasTex(w, hgt, draw, srgb = true) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = hgt;
    draw(cv.getContext('2d'), w, hgt);
    const tex = new THREE.CanvasTexture(cv);
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const radialTex = (stops, size = 256) => canvasTex(size, size, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    for (const [o, c] of stops) gr.addColorStop(o, c);
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  });
  const TEX = {
    soft: radialTex([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,.42)'], [0.6, 'rgba(255,255,255,.08)'], [1, 'rgba(255,255,255,0)']]),
    dot: radialTex([[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,.92)'], [0.45, 'rgba(255,255,255,.22)'], [1, 'rgba(255,255,255,0)']], 64),
    ring: canvasTex(128, 128, (g, w) => {
      const c = w / 2;
      g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 6; g.beginPath(); g.arc(c, c, c * 0.78, 0, 7); g.stroke();
      g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(c, c, c * 0.78, 0, 7); g.stroke();
    }),
    work: canvasTex(256, 256, (g, w) => {
      const c = w / 2, r = c * 0.8;
      g.lineWidth = w * 0.035; g.lineCap = 'round';
      for (let k = 0; k < 120; k++) {
        const f = k / 120;
        g.strokeStyle = `rgba(255,255,255,${f < 0.15 ? 0 : Math.pow((f - 0.15) / 0.85, 1.4)})`;
        g.beginPath(); g.arc(c, c, r, f * Math.PI * 2, (f + 1 / 120) * Math.PI * 2 + 0.01); g.stroke();
      }
    }),
    rays: canvasTex(512, 512, (g, w) => {
      const c = w / 2, r = rng(5);
      g.translate(c, c);
      for (let i = 0; i < 120; i++) {
        const a = r() * Math.PI * 2, L = c * (0.6 + r() * 0.4), wd = 0.006 + r() * 0.012;
        const gr = g.createLinearGradient(0, 0, Math.cos(a) * L, Math.sin(a) * L);
        gr.addColorStop(0, 'rgba(255,225,170,0)'); gr.addColorStop(0.5, `rgba(255,220,160,${0.15 + r() * 0.25})`); gr.addColorStop(1, 'rgba(255,190,120,0)');
        g.fillStyle = gr;
        g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a - wd) * L, Math.sin(a - wd) * L); g.lineTo(Math.cos(a + wd) * L, Math.sin(a + wd) * L); g.closePath(); g.fill();
      }
    }),
    sunSurf: canvasTex(512, 256, (g, w, hgt) => {
      g.fillStyle = '#808080'; g.fillRect(0, 0, w, hgt);
      const r = rng(9);
      for (let i = 0; i < 2400; i++) {
        const x = r() * w, y = r() * hgt, rr = 3 + r() * 8, v = r() < 0.5 ? 255 : 0;
        const gr = g.createRadialGradient(x, y, 0, x, y, rr);
        gr.addColorStop(0, `rgba(${v},${v},${v},${0.12 + r() * 0.12})`); gr.addColorStop(1, `rgba(${v},${v},${v},0)`);
        g.fillStyle = gr; g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
      }
    }, false),
  };
  TEX.sunSurf.wrapS = TEX.sunSurf.wrapT = THREE.RepeatWrapping;
  /** Shared by many objects, disposed only at the end (disposeTree leaves them). */
  const shared = new Set(Object.values(TEX));
  const sprite = (map, color, opacity = 1, attenuate = true) => new THREE.Sprite(new THREE.SpriteMaterial({ map, color, opacity, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, sizeAttenuation: attenuate }));
  const setOp = (m, v) => { if (m.uniforms) m.uniforms.uOpacity.value = v; else m.opacity = v; };
  function disposeTree(obj) {
    obj.traverse((o) => {
      if (o.geometry && !shared.has(o.geometry)) o.geometry.dispose();
      for (const m of [o.material].flat()) {
        if (!m || shared.has(m)) continue;
        if (m.map && !shared.has(m.map)) m.map.dispose();
        if (m.emissiveMap && m.emissiveMap !== m.map && !shared.has(m.emissiveMap)) m.emissiveMap.dispose();
        m.dispose();
      }
    });
    obj.removeFromParent();
  }

  function setBackground() {
    const old = scene.background;
    scene.background = canvasTex(512, 512, (g, w, hgt) => {
      const gr = g.createRadialGradient(w * 0.5, hgt * 0.55, 0, w * 0.5, hgt * 0.55, w * 0.8);
      gr.addColorStop(0, T.bg[0]); gr.addColorStop(0.55, T.bg[1]); gr.addColorStop(1, T.bg[2]);
      g.fillStyle = gr; g.fillRect(0, 0, w, hgt);
      for (const [rgb, a, x, y, rad] of T.washes) {   // very wide, very faint veils
        const wash = g.createRadialGradient(w * x, hgt * y, 0, w * x, hgt * y, w * rad);
        wash.addColorStop(0, `rgba(${rgb},${a})`); wash.addColorStop(1, `rgba(${rgb},0)`);
        g.fillStyle = wash; g.fillRect(0, 0, w, hgt);
      }
      const d = g.getImageData(0, 0, w, hgt), a = d.data;   // dithered against banding
      for (let i = 0; i < a.length; i += 4) { const n = (Math.random() - 0.5) * 3; a[i] += n; a[i + 1] += n; a[i + 2] += n; }
      g.putImageData(d, 0, 0);
    });
    old?.dispose?.();
  }
  const hemi = new THREE.HemisphereLight(T.light.sky, T.light.ground, T.light.hemi);
  scene.add(hemi);
  const headlight = new THREE.DirectionalLight(T.light.headColor, T.light.head);
  headlight.position.set(-2, 3, 2);
  headlight.target.position.set(0, 0, -8);
  camera.add(headlight, headlight.target);

  function circleLine(r, dashed, color, opacity, dash = [0.18, 0.32]) {
    const pts = [];
    for (let k = 0; k <= 160; k++) { const a = (k / 160) * Math.PI * 2; pts.push(new V3(Math.cos(a) * r, 0, -Math.sin(a) * r)); }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const base = { color, transparent: true, opacity, depthWrite: false, toneMapped: false };
    const line = new THREE.Line(geo, dashed ? new THREE.LineDashedMaterial({ ...base, dashSize: dash[0], gapSize: dash[1] }) : new THREE.LineBasicMaterial(base));
    if (dashed) line.computeLineDistances();
    return line;
  }

  // ---- picking: invisible, enlarged proxies, hit with a Raycaster ----
  const PROXY_GEO = new THREE.SphereGeometry(1, 12, 8);
  const PROXY_MAT = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  shared.add(PROXY_GEO).add(PROXY_MAT);
  function proxy(r, pick) {
    const m = new THREE.Mesh(PROXY_GEO, PROXY_MAT);
    m.scale.setScalar(r);
    m.visible = false;
    m.userData.pick = pick;
    return m;
  }
  const pickables = { universe: [], galaxy: [], system: [] };

  // ---- sky: quiet stars at two depths (parallax), and the theme's nebulae ----
  const starMat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uDpr: { value: DPR }, uAmp: { value: T.stars.twinkle }, uFreq: { value: T.stars.freq }, uGain: { value: T.stars.gain } },
    vertexShader: STAR_VS, fragmentShader: STAR_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const starPts = new THREE.Points(new THREE.BufferGeometry(), starMat);
  starPts.frustumCulled = false;
  scene.add(starPts);
  /** The same seed for every count, so switching themes adds or removes stars instead of reshuffling them. */
  function buildStars() {
    const N = T.stars.n, r = rng(20261118), TINT = T.stars.tint;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), ph = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const u = r() * 2 - 1, th = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      const R = i < 800 ? 900 + r() * 2600 : 4200 + r() * 4800;
      pos.set([s * Math.cos(th) * R, u * R, s * Math.sin(th) * R], i * 3);
      const big = r() < 0.04, hh = r(), tint = TINT[hh < 0.2 ? 0 : hh < 0.4 ? 1 : 2], b = big ? 0.55 + r() * 0.2 : 0.14 + r() * 0.34;
      col.set(tint.map((x) => x * b), i * 3);
      size[i] = big ? 2.2 + r() * 1.0 : 0.9 + r() * 1.0;
      ph[i] = r() * 6.283;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPh', new THREE.BufferAttribute(ph, 1));
    starPts.geometry.dispose();
    starPts.geometry = geo;
    starMat.uniforms.uAmp.value = T.stars.twinkle; starMat.uniforms.uFreq.value = T.stars.freq; starMat.uniforms.uGain.value = T.stars.gain;
  }
  let NEBULAE = [];
  function buildNebulae() {
    for (const n of NEBULAE) disposeTree(n);
    NEBULAE = T.nebula > 0 ? T.nebulae.map(([rgb, p, sc, op], k) => {
      const tex = canvasTex(256, 256, (g, w) => {
        const rr = rng([3, 8, 13, 21][k % 4]);
        g.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 70; i++) {
          const a = rr() * 6.283, d = Math.pow(rr(), 0.7) * w * 0.3, x = w / 2 + Math.cos(a) * d, y = w / 2 + Math.sin(a) * d * 0.7, rad = w * (0.06 + rr() * 0.2);
          const gr = g.createRadialGradient(x, y, 0, x, y, rad);
          gr.addColorStop(0, `rgba(${rgb},${0.05 + rr() * 0.08})`); gr.addColorStop(1, `rgba(${rgb},0)`);
          g.fillStyle = gr; g.fillRect(0, 0, w, w);
        }
        g.globalCompositeOperation = 'destination-in';
        const m = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
        m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(0.6, 'rgba(0,0,0,.6)'); m.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = m; g.fillRect(0, 0, w, w);
      });
      const sp = sprite(tex, '#ffffff', op * T.nebula);
      sp.position.set(...p); sp.scale.setScalar(sc);
      scene.add(sp);
      return sp;
    }) : [];
  }

  // ---- the model, its layout and the camera's place in it ----
  let model = skyModel(state, (cid) => dismissed.of(cid));
  let layout = layoutSky(model.galaxies);
  let structure = skyKey(model);
  let view = { level: 'universe', group: null, cid: null };
  const fade = { universe: 1, galaxy: 0, system: 0 };   // how present each level's own things are
  let miniGroup = null;   // the galaxy whose star systems are drawn in detail
  const angles = new Map();   // planet and satellite phases kept across rebuilds (a status change must not make them jump)

  // ---- universe: one galaxy per group ----
  const galaxyMat = (maxPx) => new THREE.ShaderMaterial({ uniforms: { uScale: { value: pxPerUnitAt1() }, uOpacity: { value: 1 }, uNear: { value: 1 }, uMaxPx: { value: maxPx * DPR } },
    vertexShader: GAL_VS, fragmentShader: GAL_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  function galaxyGeometry(spec) {
    const r = rng(spec.seed * 997 % 2147483646 + 1), gauss = () => (r() + r() + r() - 1.5) / 1.5;
    const R = spec.R, spiral = spec.type === 'spiral', cloud = spec.type === 'cloud';
    const N = spiral ? T.galaxy.spiral : cloud ? Math.round(T.galaxy.ell * 0.45) : T.galaxy.ell;
    const clumps = cloud ? Array.from({ length: 6 }, () => { const a = r() * 6.283, d = R * (0.15 + r() * 0.55); return [Math.cos(a) * d, gauss() * R * 0.05, Math.sin(a) * d]; }) : null;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), alpha = new Float32Array(N);
    const [cr, cg, cb] = hexRGB(T.galaxy.edges[spec.idx]), [k0, k1, k2] = T.galaxy.core;
    for (let i = 0; i < N; i++) {
      let x, y, z, f;
      if (cloud) {
        const c = clumps[i % clumps.length];
        x = c[0] + gauss() * R * 0.2; y = c[1] + gauss() * R * 0.06; z = c[2] + gauss() * R * 0.2;
        f = Math.min(1, Math.hypot(x, z) / R);
      } else if (!spiral || i < N * 0.16) {
        f = Math.abs(gauss()) * (spiral ? 0.24 : 1);
        const u = r() * 2 - 1, th = r() * 6.283, s = Math.sqrt(1 - u * u), rr = f * R * 0.9;
        x = s * Math.cos(th) * rr; y = u * rr * (spiral ? 0.5 : 0.55); z = s * Math.sin(th) * rr * (spiral ? 1 : 0.8);
      } else {
        f = Math.pow(r(), 0.75);
        const arm = i % spec.arms;
        const a = f * spec.twist * Math.PI + (arm * 2 * Math.PI) / spec.arms + gauss() * 0.32 * (1 - f * 0.3);
        const rr = f * R * 0.95 + gauss() * R * 0.035;
        x = Math.cos(a) * rr; z = Math.sin(a) * rr; y = gauss() * R * (0.05 * (1 - f) + 0.012);
      }
      pos.set([x, y, z], i * 3);
      const mix = Math.min(1, f * 1.4);
      col.set([k0 - (k0 - cr) * mix, k1 - (k1 - cg) * mix, k2 - (k2 - cb) * mix], i * 3);
      size[i] = r() < 0.03 ? 1.8 : 0.5 + r() * 0.75;
      alpha[i] = (1 - f * 0.65) * (0.25 + r() * 0.45) * spec.dim;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    // a little haze so the arms read as gas, kept to a few faint particles
    const M = spiral ? T.galaxy.hazeS : cloud ? Math.round(T.galaxy.hazeE * 0.6) : T.galaxy.hazeE;
    const hp = new Float32Array(M * 3), hc = new Float32Array(M * 3), hs = new Float32Array(M), ha = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      let x, z, y, f;
      if (cloud) {
        const c = clumps[i % clumps.length];
        x = c[0] + gauss() * R * 0.12; y = c[1]; z = c[2] + gauss() * R * 0.12; f = Math.min(1, Math.hypot(x, z) / R);
      } else if (spiral) {
        f = 0.08 + Math.pow(r(), 0.8) * 0.9;
        const a = f * spec.twist * Math.PI + ((i % spec.arms) * 2 * Math.PI) / spec.arms + gauss() * 0.2;
        x = Math.cos(a) * f * R * 0.95; z = Math.sin(a) * f * R * 0.95; y = gauss() * R * 0.02;
      } else {
        f = Math.abs(gauss()) * 0.7;
        const a = r() * 6.283;
        x = Math.cos(a) * f * R; z = Math.sin(a) * f * R * 0.8; y = gauss() * R * 0.15;
      }
      hp.set([x, y, z], i * 3);
      hc.set([cr, cg, cb], i * 3);
      hs[i] = R * (0.07 + r() * 0.05);
      ha[i] = (0.03 + r() * 0.03) * (1 - f * 0.5);
    }
    const hgeo = new THREE.BufferGeometry();
    hgeo.setAttribute('position', new THREE.BufferAttribute(hp, 3));
    hgeo.setAttribute('aColor', new THREE.BufferAttribute(hc, 3));
    hgeo.setAttribute('aSize', new THREE.BufferAttribute(hs, 1));
    hgeo.setAttribute('aAlpha', new THREE.BufferAttribute(ha, 1));
    return { geo, hgeo };
  }
  const coreTint = (spec) => toHex(hexRGB(T.galaxy.edges[spec.idx]).map((v) => v * 0.7 + 0.3));
  let GAL_LIST = [];
  let GALS = new Map();   // name -> galaxy
  const POS = new Map();   // cluster id -> its star system's centre (world)
  function buildGalaxies() {
    for (const gx of GAL_LIST) { disposeTree(gx.grp); removeLabel(gx.label); }
    POS.clear();
    GAL_LIST = layout.galaxies.map((spec) => {
      const grp = new THREE.Group();
      grp.position.set(...spec.pos); grp.rotation.set(...spec.rot);
      scene.add(grp);
      const disk = new THREE.Group();
      grp.add(disk);
      const { geo, hgeo } = galaxyGeometry(spec);
      const mat = galaxyMat(48), hmat = galaxyMat(140);
      const pts = new THREE.Points(geo, mat), haze = new THREE.Points(hgeo, hmat);
      pts.frustumCulled = haze.frustumCulled = false;
      disk.add(haze, pts);
      const core = sprite(TEX.soft, coreTint(spec), 0.3 * spec.core);
      core.scale.setScalar(spec.R * 0.6);
      grp.add(core);
      for (const s of spec.systems) POS.set(s.id, new V3(...s.local).applyEuler(grp.rotation).add(grp.position));
      const gx = { name: spec.name, spec, R: spec.R, grp, disk, mat, hmat, pts, haze, core, center: grp.position.clone(), hover: false, op: 1, label: null };
      // the hit area is a flattened ball around the whole galaxy, so clicking anywhere on its body enters it
      const prox = proxy(1, { type: 'galaxy', gx });
      prox.scale.set(spec.R * 0.9, spec.R * 0.32, spec.R * 0.9);
      grp.add(prox);
      gx.prox = prox;
      gx.label = addLabel({ el: mkLabel(gx.name ? '' : 'sm-ung', prox.userData.pick), level: 'universe',
        at: () => frontOf(gx.center, gx.R * 0.66, 0), dy: () => 4, clamp: true, collide: true, prio: 2 });
      return gx;
    });
    GALS = new Map(GAL_LIST.map((g) => [g.name, g]));
    pickables.universe = [...GAL_LIST.map((g) => g.prox), BH.prox];
  }

  // ---- star systems: a marker in the universe, a small system at the galaxy level ----
  let SYS = new Map();   // cluster id -> { system, pos3, u: { star, spark, px }, mini, label }
  const workHex = () => T.css['--work'];
  const starHex = (stats) => (stats.busy ? T.ustar.working : stats.online ? T.ustar.online : T.ustar.offline);
  function buildSystems() {
    for (const s of SYS.values()) {
      for (const dd of s.mini.dots) angles.set(`mini:${dd.id}`, dd.ang);
      disposeTree(s.group);
      removeLabel(s.label);
    }
    SYS = new Map();
    pickables.galaxy = [];
    for (const g of model.galaxies) for (const system of g.systems) {
      const pos3 = POS.get(system.cluster.id);
      if (!pos3) continue;
      const group = new THREE.Group();
      scene.add(group);
      const star = sprite(TEX.dot, starHex(system.stats), 1, false);
      star.position.copy(pos3);
      const spark = sprite(TEX.dot, SEV_HEX()[system.stats.level ?? 'attention'], 1, false);
      spark.center.set(-0.35, -0.35);
      spark.position.copy(pos3);
      group.add(star, spark);
      // the small system: its orbits sit exactly where the full system's will be, so flying in turns one into the other
      const g3 = new THREE.Group();
      g3.position.copy(pos3);
      g3.visible = false;
      group.add(g3);
      const plane = new THREE.Group();
      plane.rotation.copy(TILT);
      g3.add(plane);
      const mats = [];
      const keep = (mat, base) => { mats.push([mat, typeof base === 'function' ? base : () => base]); return mat; };
      const glow = sprite(TEX.soft, T.sun.glowColor, 1);
      keep(glow.material, () => T.mini.glow);
      glow.scale.setScalar(4.8);
      const core = sprite(TEX.dot, toHex(T.sun.core), 1);
      keep(core.material, 1);
      core.scale.setScalar(1.6);
      g3.add(glow, core);
      const fr = orbitFractions(system.planets.length);
      const halos = [];
      const dots = system.planets.map((p, i) => {
        const r = fr[i] * O.R, off = p.status === 'offline';
        const line = circleLine(r, off || p.hidden, T.orbit.color, 0.14, [0.5, 0.9]);
        keep(line.material, () => (off ? T.orbit.off : T.orbit.on));
        plane.add(line);
        const pivot = new THREE.Group();
        plane.add(pivot);
        const dot = sprite(TEX.dot, off ? '#555a64' : mute(harnessInfo(p.member.harness).color), 1);
        keep(dot.material, p.hidden ? 0.45 : 1);
        dot.material.blending = THREE.NormalBlending;
        dot.scale.setScalar(1.6); dot.position.set(r, 0, 0);
        pivot.add(dot);
        if (p.status === 'busy') {
          const halo = sprite(TEX.soft, workHex(), 0.2);
          halo.scale.setScalar(3.6); halo.position.set(r, 0, 0);
          pivot.add(halo);
          halos.push(halo);
        }
        return { id: p.member.id, r, off, pivot, ang: angles.get(`mini:${p.member.id}`) ?? i * 1.9 + (hashStr(system.cluster.id) % 6) };
      });
      const mspark = sprite(TEX.dot, '#ffffff', 1);
      keep(mspark.material, 1);
      mspark.position.set(1.8, 1.8, 0); mspark.scale.setScalar(1.3);
      mspark.material.color.set(SEV_HEX()[system.stats.level ?? 'attention']);
      mspark.visible = system.stats.notices > 0;
      g3.add(mspark);
      const prox = proxy(11, { type: 'msys', system });
      g3.add(prox);
      pickables.galaxy.push(prox);
      const entry = { system, pos3, group, pick: prox.userData.pick, u: { star, spark, px: 9 + Math.min(12, system.planets.length) },
        mini: { g: g3, mats, dots, halos, spark: mspark, hover: false }, label: null };
      entry.label = addLabel({ el: mkLabel('sm-sm', prox.userData.pick), level: 'galaxy', at: () => frontOf(pos3, 11.2, 0), dy: () => 6,
        alpha: () => (entry.system.group === miniGroup ? 1 : 0), clamp: true, collide: true, prio: 1 });
      SYS.set(system.cluster.id, entry);
    }
  }

  // ---- the star system of one cluster: the star (the Hub), planets (members) on tilted orbits, satellites ----
  /** Every star system's orbital plane is tilted a little, the same way, so the scene is not a flat disc. */
  const TILT = new THREE.Euler(0.12, 0, -0.07);
  const UNIT_SPHERE = new THREE.SphereGeometry(1, 40, 20);
  shared.add(UNIT_SPHERE);
  const glyphImages = new Map();
  function glyphImage(harness) {
    if (!GLYPH[harness]) return null;
    if (!glyphImages.has(harness)) {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(GLYPH[harness].replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" '));
      glyphImages.set(harness, img);
    }
    return glyphImages.get(harness);
  }
  /** The member's colour (muted by the theme) with soft bands, its harness glyph where the sphere faces +Z; and a grey copy. */
  function planetTextures(member) {
    const w = 512, hgt = 256;
    const colCv = document.createElement('canvas'), grayCv = document.createElement('canvas');
    colCv.width = grayCv.width = w; colCv.height = grayCv.height = hgt;
    const g = colCv.getContext('2d');
    const col = new THREE.CanvasTexture(colCv), gray = new THREE.CanvasTexture(grayCv);
    col.colorSpace = gray.colorSpace = THREE.SRGBColorSpace;
    col.anisotropy = gray.anisotropy = Math.min(4, MAX_ANISO);
    g.fillStyle = mute(harnessInfo(member.harness).color); g.fillRect(0, 0, w, hgt);
    const r = rng(hashStr(member.harness + member.id));
    const p1 = r() * 6, p2 = r() * 6, p3 = r() * 6;
    for (let y = 0; y < hgt; y += 2) {
      const v = Math.sin(y * 0.05 + p1) * 0.5 + Math.sin(y * 0.13 + p2) * 0.3 + Math.sin(y * 0.31 + p3) * 0.2;
      g.fillStyle = v > 0 ? `rgba(255,255,255,${v * 0.08})` : `rgba(0,0,0,${-v * 0.14})`;
      g.fillRect(0, y, w, 2);
    }
    const makeGray = () => {
      const gg = grayCv.getContext('2d');
      try {
        const d = g.getImageData(0, 0, w, hgt), a = d.data;
        for (let i = 0; i < a.length; i += 4) { const l = (a[i] * 0.3 + a[i + 1] * 0.59 + a[i + 2] * 0.11) * 0.5; a[i] = a[i + 1] = a[i + 2] = l; }
        gg.putImageData(d, 0, 0);
      } catch {   // a browser that taints canvases with SVG images: let the canvas filter do it
        gg.filter = 'grayscale(1) brightness(.5)'; gg.clearRect(0, 0, w, hgt); gg.drawImage(colCv, 0, 0);
      }
      gray.needsUpdate = true;
    };
    const img = glyphImage(member.harness);
    const drawGlyph = () => {
      if (closed) return;
      g.globalAlpha = 0.95; g.drawImage(img, w * 0.25 - 56, hgt * 0.5 - 56, 112, 112); g.globalAlpha = 1;
      col.needsUpdate = true; makeGray(); requestRender();
    };
    makeGray();
    if (img?.complete && img.naturalWidth) drawGlyph();
    else img?.addEventListener('load', drawGlyph, { once: true });
    return { col, gray };
  }
  const v2 = ([x, y]) => new THREE.Vector2(x, y);
  const SAT_GEO = (() => {
    const ex = (shapes) => {
      const g = new THREE.ExtrudeGeometry(shapes, { depth: 0.04, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.014, bevelSegments: 1, curveSegments: 16 });
      g.translate(0, 0, -0.02);
      return g;
    };
    const dia = new THREE.Shape([[0, 0.23], [0.18, 0], [0, -0.23], [-0.18, 0]].map(v2));
    const tri = new THREE.Shape([[0, 0.21], [0.2, -0.14], [-0.2, -0.14]].map(v2));
    return { attention: ex(dia), problem: ex(tri), mring: new THREE.TorusGeometry(0.25, 0.035, 8, 40), mdisc: new THREE.CircleGeometry(0.24, 32) };
  })();
  const SAT_MAT = Object.fromEntries(['problem', 'attention'].map((k) => [k, new THREE.MeshStandardMaterial({ color: SEV_HEX()[k], emissive: SEV_HEX()[k], emissiveIntensity: T.sat.emissive, metalness: 0.2, roughness: 0.5, toneMapped: false })]));
  const DISC_MAT = new THREE.MeshBasicMaterial({ color: '#0b0e15', transparent: true, opacity: 0.92 });
  for (const x of [...Object.values(SAT_GEO), ...Object.values(SAT_MAT), DISC_MAT]) shared.add(x);

  const STAR = (() => {
    const g = new THREE.Group();
    const sunG = new THREE.Group();
    g.add(sunG);
    const V = (a) => new V3(...a);
    const sunMat = new THREE.ShaderMaterial({ uniforms: { uMap: { value: TEX.sunSurf }, uT: { value: 0 }, uHot: { value: 0 }, uGain: { value: T.sun.gain }, uEdge: { value: V(T.sun.edge) }, uMid: { value: V(T.sun.mid) }, uCore: { value: V(T.sun.core) } },
      vertexShader: SUN_VS, fragmentShader: SUN_FS });
    const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(O.sunR, 48, 24), sunMat);
    const glow = sprite(TEX.soft, T.sun.glowColor, T.sun.glowOp);
    const halo = sprite(TEX.soft, T.sun.haloColor, T.sun.haloOp);
    const corona = sprite(TEX.rays, '#ffffff', T.sun.corona);
    const light = new THREE.PointLight(T.light.sunColor, T.light.sun, 0, 1.1);
    const sunProxy = proxy(O.sunR * 1.25, { type: 'sun' });
    sunG.add(sunMesh, halo, corona, glow, light, sunProxy);
    return { g, sunG, sunMat, glow, halo, corona, light, sunProxy };
  })();
  const sunState = { x: 0, y: 0, r: 0, depth: 0, frozen: 0, hover: false };
  let ORR = null;   // { system, root, plane, own, labels }
  let planets = [], P = {}, FR = [], sats = [];
  const holderOf = (target) => (target === null ? sunState : P[target]);
  function buildOrrery(cid) {
    const entry = SYS.get(cid);
    if (!entry) return;
    const { system, pos3 } = entry;
    const rootG = new THREE.Group();
    rootG.position.copy(pos3);
    rootG.add(STAR.g);
    const plane = new THREE.Group();
    plane.rotation.copy(TILT);
    rootG.add(plane);
    scene.add(rootG);
    const labs = [];
    FR = orbitFractions(system.planets.length);
    planets = system.planets.map((pl, i) => {
      const m = pl.member, r = FR[i] * O.R, off = pl.status === 'offline';
      const pivot = new THREE.Group();
      plane.add(pivot);
      const holder = new THREE.Group();
      holder.position.set(r, 0, 0);
      pivot.add(holder);
      const tex = planetTextures(m);
      const mat = new THREE.MeshStandardMaterial({ map: off ? tex.gray : tex.col, emissiveMap: off ? tex.gray : tex.col, emissive: '#ffffff',
        emissiveIntensity: off ? 0.07 : T.planet.emissive, roughness: 0.6, metalness: 0, transparent: pl.hidden, opacity: pl.hidden ? 0.42 : 1 });
      const ball = new THREE.Mesh(UNIT_SPHERE, mat);
      ball.scale.setScalar(O.pr);
      holder.add(ball);
      const glow = sprite(TEX.soft, mute(harnessInfo(m.harness).color), off || pl.hidden ? 0 : T.planet.glow);
      glow.scale.setScalar(O.pr * 3);
      holder.add(glow);
      // busy: a faint, slowly breathing light around the planet; nothing spins fast, no trail
      let halo = null, ring = null;
      if (pl.status === 'busy') {
        halo = sprite(TEX.soft, workHex(), 0.15);
        halo.scale.setScalar(O.pr * 3.8);
        ring = sprite(TEX.work, workHex(), T.work.ring);
        ring.scale.setScalar(O.pr * 2.8);
        holder.add(halo, ring);
      }
      const prox = proxy(O.pr * 1.7, { type: 'planet', id: m.id });
      holder.add(prox);
      const track = circleLine(r, off || pl.hidden, T.orbit.color, off ? T.orbit.off : T.orbit.on);
      plane.add(track);
      const p = { pl, m, i, ang: angles.get(m.id) ?? PHASE0[i % PHASE0.length] + i * 0.4, speed: 1, hover: false, frozen: 0, x: 0, y: 0, r: 0, depth: 0,
        pivot, holder, ball, mat, tex, glow, halo, ring, track, world: new V3(), prox };
      const cls = `sm-lb-pl${off ? ' sm-off' : ''}${pl.hidden ? ' sm-ghost' : ''}`;
      p.lab = addLabel({ el: mkLabel(cls, prox.userData.pick, m.name), level: 'system', at: () => p.world, dy: (u) => O.pr * bodyScale() * u + 4,
        place: (x, y, u, w, hh) => namePlaces(p, x, y, u, w, hh), alpha: () => planetAlpha(p), collide: true });
      p.lab.el.setAttribute('aria-label', planetAria(pl));
      labs.push(p.lab);
      return p;
    });
    P = Object.fromEntries(planets.map((p) => [p.m.id, p]));
    ORR = { system, root: rootG, plane, labels: labs };
    rebuildSats();
    try { renderer.compile(scene, camera); } catch { /* compiling early only avoids a hitch */ }
  }
  function disposeOrrery() {
    if (!ORR) return;
    for (const s of sats) { angles.set(`sat:${s.key}`, s.ang); removeSat(s); }
    sats = [];
    for (const p of planets) { angles.set(p.m.id, p.ang); p.tex.col.dispose(); p.tex.gray.dispose(); }
    ORR.root.remove(STAR.g);
    disposeTree(ORR.root);
    for (const L of ORR.labels) removeLabel(L);
    ORR = null; planets = []; P = {};
    sunState.frozen = 0; sunState.hover = false;
    pickables.system = [];
  }
  /** Planets behind the star: their labels fade so the star stays clean. */
  function planetAlpha(p) {
    if (p.depth > sunState.depth && Math.hypot(p.x - sunState.x, p.y - sunState.y) < sunState.r * 1.4) return 0.15;
    return p.pl.status === 'offline' || p.pl.hidden ? 0.75 : 1;
  }

  // satellites: system notices. More than 3 on one body merge into one with a count. Problems pulse.
  function rebuildSats() {
    if (!ORR) return;
    const keep = new Map(sats.filter((s) => !s.dying).map((s) => [s.key, s]));
    for (const s of sats) if (!s.dying) removeSat(s);
    sats = sats.filter((s) => s.dying);
    const groups = new Map();
    for (const n of ORR.system.satellites) {
      const key = n.target ?? '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(n);
    }
    for (const [key, list] of groups) {
      const target = key || null;
      if (target && !P[target]) continue;
      const items = list.length > 3 ? [list] : list.map((n) => [n]);
      items.forEach((ns, idx) => {
        const merged = ns.length > 1;
        const level = ns.some((n) => n.level === 'problem') ? 'problem' : 'attention';
        const skey = merged ? `${key}:all` : ns[0].id;
        const old = keep.get(skey);
        const hub = target === null;
        const orbit = new THREE.Group();
        orbit.rotation.set(hub ? [0.2, -0.28, 0.36][idx % 3] : [0.32, -0.4, 0.16][idx % 3], idx * 0.9, hub ? [-0.24, 0.18, 0.42][idx % 3] : [-0.22, 0.24, 0.4][idx % 3]);
        (hub ? STAR.sunG : P[target].holder).add(orbit);
        const body = new THREE.Group();
        orbit.add(body);
        const token = new THREE.Group();
        body.add(token);
        if (merged) {
          const disc = new THREE.Mesh(SAT_GEO.mdisc, DISC_MAT);
          disc.position.z = -0.02;
          token.add(new THREE.Mesh(SAT_GEO.mring, SAT_MAT[level]), disc);
        } else token.add(new THREE.Mesh(SAT_GEO[level], SAT_MAT[level]));
        const glowS = sprite(TEX.soft, SEV_HEX()[level], T.sat.glow);
        glowS.scale.setScalar(merged ? 0.95 : 0.7);
        body.add(glowS);
        const pulseOp = level === 'problem' ? T.sat.pulse : T.sat.pulseImp;
        const pulse = pulseOp > 0 ? sprite(TEX.ring, SEV_HEX()[level], pulseOp) : null;
        if (pulse) { pulse.userData.op = pulseOp; body.add(pulse); }
        const pick = { type: 'sat', s: null };
        const prox = proxy(merged ? 0.5 : 0.42, pick);
        body.add(prox);
        const s = { key: skey, target, notices: ns, merged, level, orbit, body, token, glowS, pulse, prox,
          ang: old ? old.ang : angles.get(`sat:${skey}`) ?? idx * 2.1 + (key.length % 5),
          rs: hub ? O.sunR * (1.7 + idx * 0.34) : O.pr * (1.9 + idx * 0.5),
          speed: hub ? 0.42 - idx * 0.07 : 1.15 - idx * 0.22,
          dying: false, x: 0, y: 0, r: 0, world: new V3(), label: null, mats: null };
        pick.s = s;
        if (merged) {
          s.label = addLabel({ el: mkLabel('sm-lb-cnt', pick, String(ns.length)), level: 'system', at: () => s.world, center: true });
          s.label.el.setAttribute('aria-label', t('{count} 条系统通知', { count: ns.length }));
        }
        sats.push(s);
      });
    }
    pickables.system = [STAR.sunProxy, ...planets.map((p) => p.prox), ...sats.filter((s) => !s.dying).map((s) => s.prox)];
    requestRender();
  }
  function removeSat(s) {
    s.orbit.removeFromParent();
    s.glowS.material.dispose();
    s.pulse?.material.dispose();
    for (const m of s.mats ?? []) m.dispose();
    if (s.label) { removeLabel(s.label); s.label = null; }
  }
  // 知道了: the satellite falls into its planet (or drifts away from the star), then disappears
  function flyOut(s) {
    const drop = () => { removeSat(s); sats = sats.filter((x) => x !== s); requestRender(); };
    const holder = holderOf(s.target);
    if (reduced || !holder) return drop();
    holder.frozen++;
    if (s.label) { removeLabel(s.label); s.label = null; }
    const start = s.body.position.clone();
    const done = () => { drop(); holder.frozen = Math.max(0, holder.frozen - 1); };
    if (s.target === null) {
      s.mats = [];
      s.token.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; s.mats.push(o.material); } });
      tween(700, (k) => {
        const e = 1 - Math.pow(1 - k, 3);
        s.body.position.copy(start).multiplyScalar(1 + e * 0.9);
        s.body.scale.setScalar(1 + e * 0.8);
        for (const m of s.mats) m.opacity = 1 - k;
        s.glowS.material.opacity = T.sat.glow * (1 - k);
      }, done);
    } else {
      tween(620, (k) => {
        s.body.position.copy(start).multiplyScalar(1 - k * k);
        s.body.scale.setScalar(k < 0.55 ? 1 + k * 0.3 : 1.16 * (1 - (k - 0.55) / 0.45) + 0.1);
      }, () => { done(); ping(holder); });
    }
  }
  function ping(holder) {
    if (reduced || !holder || !ORR) return;
    const isSun = holder === sunState, obj = isSun ? STAR.sunG : holder.holder, base = isSun ? O.sunR : O.pr;
    if (!obj) return;
    const sp = sprite(TEX.ring, '#c9ced8', 0.5);
    obj.add(sp);
    tween(700, (k) => { sp.scale.setScalar(base * (2 + 2 * k)); sp.material.opacity = 0.5 * (1 - k); }, () => { sp.removeFromParent(); sp.material.dispose(); });
  }

  // ---- the black hole: the recycle bin. Each cluster in it is a small light in the disk ----
  const BH = (() => {
    const g = new THREE.Group();
    g.position.set(...layout.blackHole);
    scene.add(g);
    const tilt = new THREE.Group();
    tilt.rotation.set(0.42, 0, 0.18);
    g.add(tilt);
    const disk = new THREE.Group();
    tilt.add(disk);
    const mat = galaxyMat(40);
    const pts = new THREE.Points(new THREE.BufferGeometry(), mat);
    pts.frustumCulled = false;
    disk.add(pts);
    const core = new THREE.Mesh(new THREE.SphereGeometry(13, 32, 16), new THREE.MeshBasicMaterial({ color: '#000000' }));
    g.add(core);
    const glow = sprite(TEX.soft, '#ffffff', 0.2);
    glow.scale.setScalar(130);
    const ring = sprite(TEX.ring, '#ffffff', 0.6);   // the photon ring: a thin bright circle just outside the dark core
    ring.scale.setScalar(37);
    g.add(glow, ring);
    const prox = proxy(64, { type: 'bh' });
    g.add(prox);
    return { g, tilt, disk, pts, mat, core, glow, ring, prox, sparks: new Map(), boost: 0, label: null };
  })();
  /** Disk particles in the theme's colours: hot and dense inside, cooler and sparse outside. */
  function themeBlackHole() {
    const r = rng(707), N = T.bh.n, a = hexRGB(T.bh.inner), b = hexRGB(T.bh.outer);
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), alpha = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const f = Math.pow(r(), 1.7), rad = 16 + f * 44, ang = r() * Math.PI * 2;
      pos.set([Math.cos(ang) * rad, (r() - 0.5) * (1 + f * 3), Math.sin(ang) * rad], i * 3);
      col.set(a.map((v, k) => lerp(v, b[k], f)), i * 3);
      size[i] = 0.7 + r() * 1.4;
      alpha[i] = (1 - f * 0.7) * (0.35 + r() * 0.5);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    BH.pts.geometry.dispose();
    BH.pts.geometry = geo;
    BH.glow.material.color.set(T.bh.glow);
    BH.ring.material.color.set(T.bh.ring);
    for (const s of BH.sparks.values()) s.sp.material.color.set(T.bh.inner);
  }
  function syncSparks(flare = true) {
    const ids = new Set(trashRows.slice(0, MAX_SPARKS).map((c) => c.id));
    for (const [id, s] of BH.sparks) if (!ids.has(id)) { s.sp.removeFromParent(); s.sp.material.dispose(); BH.sparks.delete(id); }
    let added = false;
    for (const id of ids) {
      if (BH.sparks.has(id)) continue;
      const sp = sprite(TEX.dot, T.bh.inner, 0.95);
      sp.scale.setScalar(7);
      BH.tilt.add(sp);
      BH.sparks.set(id, { sp, ang: (hashStr(id) % 628) / 100, r: 24 + (BH.sparks.size % 4) * 7 });
      added = true;
    }
    if (added && flare) BH.boost = 0.9;   // something fell in: the disk flares once
    refreshBin();
    requestRender();
  }
  function refreshBin() {
    if (!BH.label) return;
    BH.label.el.replaceChildren(h('b', {}, t('回收站 · {count} 个群', { count: trashRows.length })));
    BH.label.el.setAttribute('aria-label', t('回收站：{count} 个群。打开', { count: trashRows.length }));
    BH.label.w = 0;
  }
  let trashLoading = 0;
  async function loadTrash() {
    const mine = ++trashLoading;
    try {
      const rows = await ctx.api('GET', '/api/clusters?deleted=true');
      if (closed || mine !== trashLoading || !Array.isArray(rows)) return;
      trashRows = rows;
      syncSparks();
    } catch { /* the count stays as it was */ }
  }
  let trashOpen = false;
  function openBin() {
    if (trashOpen) return;
    trashOpen = true;
    try {
      openTrash({ api: ctx.api, noticeDialog, restored: () => reloadState(), closed: () => { trashOpen = false; if (!closed) loadTrash(); } });
    } catch (error) { trashOpen = false; console.warn('star map: the recycle bin did not open', error); }
  }

  // ---- DOM labels projected from 3D points: crisp text, keyboard reachable, the same hover and click as the bodies ----
  const labels = new Set();
  const _sc = [0, 0, 0, 0], _v = new V3(), _front = new V3();
  /** Screen position of a world point: [x, y, depth, pixels per world unit there], or null when behind the camera. */
  function toScreen(p, out) {
    _v.copy(p).applyMatrix4(camera.matrixWorldInverse);
    const depth = -_v.z;
    if (depth <= camera.near) return null;
    _v.applyMatrix4(camera.projectionMatrix);
    out[0] = ((_v.x + 1) / 2) * W; out[1] = ((1 - _v.y) / 2) * H; out[2] = depth; out[3] = (camera.projectionMatrix.elements[5] * H) / 2 / depth;
    return out;
  }
  /** The point of a horizontal circle nearest to the camera: labels go there, under the thing they name. */
  function frontOf(center, radius, y) {
    _front.set(camera.position.x - center.x, 0, camera.position.z - center.z);
    if (_front.lengthSq() < 1e-6) _front.set(0, 0, 1);
    _front.normalize().multiplyScalar(radius);
    _front.x += center.x; _front.z += center.z; _front.y = center.y + y;
    return _front;
  }
  function mkLabel(cls, pick, text = '') {
    const node = h('button', { type: 'button', class: `sm-lb ${cls}` }, text);
    if (pick) {
      node.addEventListener('click', (e) => { e.stopPropagation(); clickPick(pick); });
      node.addEventListener('pointerenter', () => setHover(pick));
      node.addEventListener('pointerleave', () => { if (hovered === pick) setHover(null); });
      node.addEventListener('focus', () => setHover(pick));
      node.addEventListener('blur', () => { if (hovered === pick) setHover(null); });
    }
    return node;
  }
  function addLabel(o) { o.shown = true; o.w = 0; labelLayer.append(o.el); labels.add(o); return o; }
  function removeLabel(o) { if (!o) return; o.el.remove(); labels.delete(o); }
  let titleRect = null;
  /** Fixed things labels must not cover: the star's disc and the cluster name under the system. */
  function obstacles() {
    const out = [];
    if (!ORR || fade.system < 0.3) return out;
    const r = sunState.r * 1.25;
    if (r > 0) out.push([sunState.x - r, sunState.y - r, sunState.x + r, sunState.y + r]);
    for (const s of sats) if (!s.dying && s.r) out.push([s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r]);
    if (!sysTitle.hidden) {
      if (!titleRect) {
        const b = sysTitle.getBoundingClientRect(), o = root.getBoundingClientRect();
        titleRect = [b.left - o.left, b.top - o.top, b.right - o.left, b.bottom - o.top];
      }
      out.push(titleRect);
    }
    return out;
  }
  /** Where a planet's name may go: under it, over it, right, left, under its satellites' orbits; the first free spot wins. */
  function namePlaces(p, x, y, u, w, hh) {
    const bs = bodyScale(), R = O.pr * bs * u;
    let moons = 0;
    for (const s of sats) if (s.target === p.m.id && !s.dying) moons = Math.max(moons, (s.rs + 0.32) * bs);
    const far = moons * u;
    return [[x - w / 2, y + R + 4], [x - w / 2, y - R - 4 - hh], [x + R + 6, y - hh / 2], [x - R - 6 - w, y - hh / 2],
      ...(moons ? [[x - w / 2, y + far + 3], [x - w / 2, y - far - 3 - hh]] : [])];
  }
  function updateLabels() {
    const vis = [];
    for (const L of labels) {
      let a = L.level ? fade[L.level] : 1;
      if (a > 0.01 && L.alpha) a *= L.alpha();
      const s = a > 0.01 ? toScreen(L.at(), _sc) : null;
      if (s) {
        if (!L.shown) { L.el.style.display = ''; L.shown = true; }
        if (!L.w) { L.w = L.el.offsetWidth; L.h = L.el.offsetHeight; }
        let left = s[0] + (L.dx ? L.dx(s[3]) : 0) - L.w / 2, top = s[1] + (L.dy ? L.dy(s[3]) : 0) - (L.center ? L.h / 2 : 0);
        L.cands = L.place ? L.place(s[0], s[1], s[3], L.w, L.h) : null;
        if (L.clamp) { left = clamp(left, 10, W - L.w - 10); top = clamp(top, TOP_SAFE, H - L.h - 12); }
        if (left + L.w > -20 && left < W + 20 && top + L.h > -20 && top < H + 20) {
          Object.assign(L, { left, top, depth: s[2], a, blocked: false });
          vis.push(L);
          continue;
        }
      }
      if (L.shown) { L.el.style.display = 'none'; L.shown = false; }
    }
    const placed = obstacles();
    const hits = (r) => placed.some((o) => r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1]);
    vis.filter((L) => L.collide).sort((p, q) => (q.prio || 0) - (p.prio || 0) || p.depth - q.depth).forEach((L) => {
      const box = (left, top) => [left - 4, top - 2, left + L.w + 4, top + L.h + 2];
      let r = box(L.left, L.top);
      if (hits(r) && L.cands) {
        const free = L.cands.find(([lx, ty]) => !hits(box(lx, ty)));
        if (free) { [L.left, L.top] = free; r = box(L.left, L.top); }
      }
      L.blocked = hits(r);
      if (!L.blocked) placed.push(r);
    });
    for (const L of vis) {
      const a = L.blocked ? 0 : L.a;
      L.el.style.transform = `translate(${L.left.toFixed(1)}px,${L.top.toFixed(1)}px)`;
      L.el.style.opacity = a.toFixed(3);
      L.el.style.zIndex = String(Math.round(1e6 / Math.max(1, L.depth)));
      L.el.style.pointerEvents = a > 0.6 && !flight ? '' : 'none';
      const focusable = a > 0.6 ? 0 : -1;
      if (L.el.tabIndex !== focusable) L.el.tabIndex = focusable;
    }
  }
  const counts = (stats) => [
    stats.busy ? h('i', {}, t('{count} 工作中', { count: stats.busy })) : null,
    stats.notices ? h('em', {}, t('{count} 条通知', { count: stats.notices })) : null,
  ].filter(Boolean).flatMap((x) => [' · ', x]);
  /** The overview labels' words: galaxies and star systems, in the current language. */
  function refreshOverview() {
    for (const gx of GAL_LIST) {
      const systems = model.galaxies.find((g) => g.name === gx.name)?.systems ?? [];
      const sum = systems.reduce((a, s) => ({ busy: a.busy + s.stats.busy, notices: a.notices + s.stats.notices }), { busy: 0, notices: 0 });
      gx.label.el.replaceChildren(h('b', {}, galaxyName(gx.name)), h('small', {}, t('{count} 个群聊', { count: systems.length }), ...counts(sum)));
      gx.label.el.setAttribute('aria-label', t('星系「{name}」：{count} 个群聊，{busy} 名群员正在工作。进入', { name: galaxyName(gx.name), count: systems.length, busy: sum.busy }));
      gx.label.w = 0;
    }
    for (const entry of SYS.values()) {
      const { system } = entry, s = system.stats;
      entry.label.el.replaceChildren(h('b', {}, system.cluster.name), h('small', {}, t('{count} 名群员', { count: s.n }), ...counts(s)));
      entry.label.el.setAttribute('aria-label', t('恒星系统「{name}」：{count} 名群员。进入', { name: system.cluster.name, count: s.n }));
      entry.label.w = 0;
    }
    refreshBin();
  }

  // ---- hover and click (a Raycaster against the proxies of the current level) ----
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hovered = null;
  const pickable = (d) => (d.type === 'sat' ? d.s && !d.s.dying : d.type === 'msys' ? d.system.group === miniGroup : true);
  function pickAt(x, y) {
    if (flight || fade[view.level] < 0.5) return null;
    const list = pickables[view.level];
    if (!list.length) return null;
    ndc.set((x / W) * 2 - 1, -(y / H) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    let best = null;
    for (const hit of raycaster.intersectObjects(list, false)) {
      const d = hit.object.userData.pick;
      if (!d || !pickable(d)) continue;
      if (!best || PRIORITY[d.type] > PRIORITY[best.type]) best = d;
    }
    return best;
  }
  function screenOf(p, worldR, minPx = 0) {
    const s = toScreen(p, [0, 0, 0, 0]);
    return s ? [s[0], s[1], Math.max(minPx, worldR * s[3])] : [-999, -999, 0];
  }
  function setHover(d) {
    if (d === hovered) return;
    if (hovered) leaveHover(hovered);
    hovered = d;
    if (d) enterHover(d);
    canvas.classList.toggle('sm-point', Boolean(d));
    requestRender();
  }
  function enterHover(d) {
    switch (d.type) {
      case 'galaxy': d.gx.hover = true; showCard(galaxyCard(d.gx), () => screenOf(d.gx.center, d.gx.R * 0.5, 40)); break;
      case 'bh': BH.label?.el.classList.add('sm-hot'); showCard(binCard(), () => screenOf(BH.g.position, 40, 30)); break;
      case 'msys': { const e = SYS.get(d.system.cluster.id); if (e) e.mini.hover = true; showCard(clusterCard(d.system), () => screenOf(e?.pos3 ?? BH.g.position, 9, 20)); break; }
      case 'sun': sunState.hover = true; sysTitle.classList.add('sm-hot'); if (ORR) showCard(sunCard(ORR.system), () => [sunState.x, sunState.y, sunState.r]); break;
      case 'planet': { const p = P[d.id]; if (!p) return; p.hover = true; p.lab.el.classList.add('sm-hot'); showCard(planetCard(p), () => [p.x, p.y, p.r]); break; }
      case 'sat': showTip(d.s); break;
    }
  }
  function leaveHover(d) {
    switch (d.type) {
      case 'galaxy': d.gx.hover = false; break;
      case 'bh': BH.label?.el.classList.remove('sm-hot'); break;
      case 'msys': { const e = SYS.get(d.system.cluster.id); if (e) e.mini.hover = false; break; }
      case 'sun': sunState.hover = false; sysTitle.classList.remove('sm-hot'); break;
      case 'planet': { const p = P[d.id]; if (p) { p.hover = false; p.lab.el.classList.remove('sm-hot'); } break; }
      case 'sat': hideTip(); return;
    }
    hideCard();
  }
  function clickPick(d) {
    if (flight) return;
    switch (d.type) {
      case 'galaxy': return go({ level: 'galaxy', group: d.gx.name, cid: null });
      case 'bh': return openBin();
      case 'msys': return go({ level: 'system', cid: d.system.cluster.id, group: d.system.group });
      case 'sun': return ORR && openHub(ORR.system.cluster.id);
      case 'planet': return ORR && openMember(ORR.system.cluster.id, d.id);
      case 'sat': if (!d.s || d.s.dying) return; hideTip(); return openNcard(d.s);
    }
  }
  const local = (e) => { const r = root.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  let down = null, dragging = false;
  on(canvas, 'pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  on(canvas, 'pointermove', (e) => {
    if (down) {
      if (!dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { dragging = true; setHover(null); canvas.classList.add('sm-grabbing'); }
      return;
    }
    setHover(pickAt(...local(e)));
  });
  on(canvas, 'pointerup', (e) => {
    const was = dragging, d0 = down;
    dragging = false; down = null;
    canvas.classList.remove('sm-grabbing');
    if (!was && d0) { const d = pickAt(...local(e)); if (d) clickPick(d); }
  });
  on(canvas, 'pointercancel', () => { dragging = false; down = null; canvas.classList.remove('sm-grabbing'); });
  on(canvas, 'pointerleave', () => { if (!down) setHover(null); });
  on(canvas, 'dblclick', (e) => { if (!pickAt(...local(e))) resetView(); });
  controls.addEventListener('change', () => requestRender());

  // ---- levels: camera poses, flights, wheel zoom ----
  const _fitCam = new THREE.PerspectiveCamera(), _fp = new V3();
  /**
   * Camera distance at which every sample point lands inside the frame, found by bisection with a scratch camera. Top
   * margin leaves room for the breadcrumb, bottom margin for the cluster's name. Tall screens may crop the sides.
   */
  function fitDistance(target, polar, az, pts, top = 0.76, bottom = 0.8, crop = true) {
    _fitCam.fov = camera.fov; _fitCam.aspect = camera.aspect; _fitCam.near = 0.01; _fitCam.far = 1e6; _fitCam.updateProjectionMatrix();
    const mx = crop ? 0.9 * Math.max(1, 0.62 / camera.aspect) : 0.94;
    const fits = (d) => {
      _fitCam.position.setFromSphericalCoords(d, polar, az).add(target);
      _fitCam.lookAt(target);
      _fitCam.updateMatrixWorld();
      for (const p of pts) {
        if (_fp.copy(p).applyMatrix4(_fitCam.matrixWorldInverse).z > -0.05) return false;
        _fp.copy(p).project(_fitCam);
        if (Math.abs(_fp.x) > mx || _fp.y > top || _fp.y < -bottom) return false;
      }
      return true;
    };
    let lo = 0.5, hi = 50000;
    for (let i = 0; i < 36; i++) { const d = Math.sqrt(lo * hi); if (fits(d)) hi = d; else lo = d; }
    return hi;
  }
  const ringPts = (center, r, y, n = 24, obj = null) => Array.from({ length: n }, (_, k) => {
    const a = (k / n) * Math.PI * 2, p = new V3(Math.cos(a) * r, y, -Math.sin(a) * r);
    return obj ? obj.localToWorld(p) : p.add(center);
  });
  const tiltPts = (center, r, n = 24) => Array.from({ length: n }, (_, k) => {
    const a = (k / n) * Math.PI * 2;
    return new V3(Math.cos(a) * r, 0, -Math.sin(a) * r).applyEuler(TILT).add(center);
  });
  const isPortrait = () => camera.aspect < 0.8;
  /** Bodies drawn larger on narrow screens, so planets stay big enough to tap. */
  const bodyScale = () => (isPortrait() ? 1.6 : 1);
  function poseFor(v) {
    const portrait = isPortrait();
    if (v.level === 'galaxy' && GALS.has(v.group)) {
      const gx = GALS.get(v.group), target = gx.center.clone(), pts = [];
      gx.grp.updateMatrixWorld();
      pts.push(...ringPts(null, gx.R * 0.8, 0, 12, gx.grp));
      for (const s of model.galaxies.find((g) => g.name === v.group)?.systems ?? []) if (POS.has(s.cluster.id)) pts.push(...tiltPts(POS.get(s.cluster.id), 12, 8));
      return { target, d: fitDistance(target, 0.9, 0, pts, 0.72, 0.8, !portrait), polar: 0.9, az: 0 };
    }
    if (v.level === 'system' && POS.has(v.cid)) {
      const c3 = POS.get(v.cid), target = c3.clone();
      const pts = [...tiltPts(c3, O.R * 0.96 + O.pr * 1.4, 32), c3.clone().add(new V3(0, O.sunR + 0.6, 0)), c3.clone().add(new V3(0, -O.sunR - 0.6, 0))];
      return { target, d: fitDistance(target, 1.02, 0, pts, 0.74, 0.72, !portrait), polar: 1.02, az: 0 };
    }
    const target = new V3(0, 10, 0), pts = [];
    for (const gx of GAL_LIST) { gx.grp.updateMatrixWorld(); pts.push(...ringPts(null, gx.R * 0.95, 0, 16, gx.grp)); }
    pts.push(...ringPts(BH.g.position, 66, 0, 12), BH.g.position.clone().add(new V3(0, -30, 0)));
    let best = null;
    for (const [polar, az] of [[0.98, 0], [0.75, 0], [0.75, Math.PI / 2], [0.62, Math.PI / 2]]) {
      const d = fitDistance(target, polar, az, pts, 0.72, 0.8, false);
      if (!best || d < best.d) best = { target, d, polar, az };
    }
    return best;
  }
  const zoomRange = (d) => (view.level === 'system' ? [d * 0.38, d * 1.55] : [d * 0.45, d * 1.6]);
  const galTargets = (v) => Object.fromEntries(GAL_LIST.map((gx) => [gx.name, v.level === 'universe' ? 0.85 : v.level === 'galaxy' ? (gx.name === v.group ? 0.55 : 0.38) : 0.2]));
  function applyLimits() {
    const [a, b] = LIMITS[view.level];
    controls.minPolarAngle = a; controls.maxPolarAngle = b;
  }
  let flight = null, zoomGoal = null, panGoal = null;
  const _off = new V3();
  const camDist = () => camera.position.distanceTo(controls.target);
  function startFlight(pose, dur, opts = {}) {
    const sph = new THREE.Spherical().setFromVector3(_off.copy(camera.position).sub(controls.target));
    let dth = pose.az - sph.theta;
    dth = Math.atan2(Math.sin(dth), Math.cos(dth));
    flight = { start: performance.now(), dur, deeper: Boolean(opts.deeper), t0: controls.target.clone(), d0: Math.max(0.01, sph.radius), ph0: sph.phi, th0: sph.theta, th1: sph.theta + dth,
      pose, fromF: { ...fade }, toF: opts.toF || { ...fade }, gal0: Object.fromEntries(GAL_LIST.map((g) => [g.name, g.op])), gal1: opts.gal || null, done: opts.done };
    controls.enabled = false;
    zoomGoal = null; panGoal = null;
    if (dur <= 0) stepFlight(flight.start + 1);
    requestRender();
  }
  function stepFlight(now) {
    const f = flight;
    const k = clamp((now - f.start) / Math.max(1, f.dur), 0, 1);
    const kt = f.deeper ? ease(clamp(k / 0.72, 0, 1)) : ease(clamp((k - 0.28) / 0.72, 0, 1));
    const kd = ease(k);
    controls.target.lerpVectors(f.t0, f.pose.target, kt);
    const d = f.d0 * Math.pow(f.pose.d / f.d0, kd);
    camera.position.setFromSphericalCoords(d, lerp(f.ph0, f.pose.polar, kd), lerp(f.th0, f.th1, kd)).add(controls.target);
    camera.lookAt(controls.target);
    for (const L of LEVELS) {
      const a = f.fromF[L], b = f.toF[L];
      fade[L] = b > a ? lerp(a, b, smooth(0.45, 1, k)) : lerp(a, b, smooth(0, 0.5, k));
    }
    if (f.gal1) for (const gx of GAL_LIST) gx.op = lerp(f.gal0[gx.name] ?? gx.op, f.gal1[gx.name] ?? gx.op, kd);
    if (k >= 1) {
      flight = null;
      controls.enabled = true;
      applyLimits();
      controls.update();
      f.done?.();
    }
  }
  const sameView = (a, b) => a.level === b.level && a.group === b.group && a.cid === b.cid;
  function go(next, after) {
    if (flight) return;
    const prev = view;
    if (sameView(prev, next)) { after?.(); return; }
    hideCard(); hideTip(); closeNcard(); setHover(null);
    const deeper = LEVEL_DEPTH[next.level] > LEVEL_DEPTH[prev.level];
    view = next;
    if (next.level !== 'universe') miniGroup = next.group;   // going up, the systems fade out where they were
    if (next.level === 'system') { disposeOrrery(); buildOrrery(next.cid); }
    refreshOverview();
    updateChrome();
    const steps = Math.abs(LEVEL_DEPTH[next.level] - LEVEL_DEPTH[prev.level]) || 1;
    startFlight(poseFor(next), reduced ? 0 : 1600 + 700 * (steps - 1), {
      deeper,
      toF: { universe: +(next.level === 'universe'), galaxy: +(next.level === 'galaxy'), system: +(next.level === 'system') },
      gal: galTargets(next),
      done: () => { if (view.level !== 'system') disposeOrrery(); refreshOverview(); after?.(); },
    });
  }
  /** Up one level: a star system goes to its galaxy, a galaxy to the universe. False at the top. */
  function up() {
    if (view.level === 'system') go({ level: 'galaxy', group: view.group, cid: null });
    else if (view.level === 'galaxy') go({ level: 'universe', group: null, cid: null });
    else return false;
    return true;
  }
  function resetView() { if (!flight) startFlight(poseFor(view), reduced ? 0 : 900); }
  /** Snaps to `next` without a flight (first draw, or the sky laid out again). */
  function jumpTo(next) {
    view = next;
    if (next.level !== 'universe') miniGroup = next.group;   // going up, the systems fade out where they were
    for (const L of LEVELS) fade[L] = +(L === next.level);
    const gal = galTargets(next);
    for (const gx of GAL_LIST) gx.op = gal[gx.name];
    const pose = poseFor(next);
    flight = null; zoomGoal = null; panGoal = null;
    controls.enabled = true;
    controls.target.copy(pose.target);
    camera.position.setFromSphericalCoords(pose.d, pose.polar, pose.az).add(pose.target);
    camera.lookAt(pose.target);
    applyLimits();
    controls.update();
    disposeOrrery();
    if (next.level === 'system') buildOrrery(next.cid);
    refreshOverview();
    updateChrome();
  }
  // Wheel: zoom toward the cursor within a level; past the nearest zoom enters what is under the pointer, past the farthest goes up.
  let wheelAcc = 0, wheelT = 0;
  const _hv = new V3();
  const enterTypes = new Set(['galaxy', 'msys']);
  function enterable(x, y) {
    const hit = pickAt(x, y);
    if (hit && enterTypes.has(hit.type)) return hit;
    let best = null, bd = Math.min(W, H) * 0.4;
    for (const pr of pickables[view.level]) {
      const d = pr.userData.pick;
      if (!pickable(d) || !enterTypes.has(d.type)) continue;
      const s = toScreen(pr.getWorldPosition(_hv), _sc);
      if (!s) continue;
      const dist = Math.hypot(s[0] - x, s[1] - y);
      if (dist < bd) { bd = dist; best = d; }
    }
    return best;
  }
  const overlay = (target) => target instanceof Element && (target.closest('.sm-card, .sm-ncard, .sm-help, .sm-menu, .sm-finder, .sm-tools, .sm-crumbs') || (winRoot.contains(target) && target !== winRoot));
  on(root, 'wheel', (e) => {
    if (overlay(e.target)) return;
    e.preventDefault();
    if (flight) return;
    const now = performance.now();
    if (now - wheelT > 450) wheelAcc = 0;
    wheelT = now;
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const [lo, hi] = zoomRange(poseFor(view).d);
    const goal = zoomGoal ?? camDist();
    const [x, y] = local(e);
    if (dy < 0 && goal <= lo * 1.01 && view.level !== 'system') {
      wheelAcc -= dy;
      if (wheelAcc > 200) { wheelAcc = 0; const d = enterable(x, y); if (d) clickPick(d); }
      return;
    }
    if (dy > 0 && goal >= hi * 0.99 && view.level !== 'universe') {
      wheelAcc += dy;
      if (wheelAcc > 200) { wheelAcc = 0; up(); }
      return;
    }
    wheelAcc = 0;
    // zoom toward the cursor: the look-at point slides toward what is under it, and drifts home again when zooming out
    const home = poseFor(view).target, newGoal = clamp(goal * Math.exp(dy * 0.0016), lo, hi), base = panGoal || controls.target.clone();
    if (dy < 0) {
      ndc.set((x / W) * 2 - 1, -(y / H) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.ray.intersectPlane(new THREE.Plane(new V3(0, 1, 0), -base.y), new V3());
      if (hit) panGoal = base.clone().lerp(hit, 1 - newGoal / goal);
    } else if (hi > goal) panGoal = base.clone().lerp(home, clamp((newGoal - goal) / (hi - goal), 0, 1));
    if (panGoal) {
      const lim = view.level === 'universe' ? 600 : view.level === 'galaxy' ? (GALS.get(view.group)?.R ?? 100) * 0.9 : 7;
      const off = panGoal.clone().sub(home);
      if (off.length() > lim) panGoal = home.clone().add(off.setLength(lim));
    }
    zoomGoal = newGoal;
    requestRender();
  }, { passive: false });

  // ---- frame update. Renders only when something moves; 24 fps while the pointer is over a window ----
  const tweens = [];
  function tween(dur, fn, done) { tweens.push({ t0: performance.now(), dur, fn, done }); requestRender(); }
  function stepTweens(now) {
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i], k = clamp((now - tw.t0) / tw.dur, 0, 1);
      tw.fn(k);
      if (k >= 1) { tweens.splice(i, 1); tw.done?.(); }
    }
  }
  function updateScales() {
    const s = pxPerUnitAt1();
    for (const gx of GAL_LIST) { gx.mat.uniforms.uScale.value = gx.hmat.uniforms.uScale.value = s; gx.mat.uniforms.uMaxPx.value = 48 * DPR; gx.hmat.uniforms.uMaxPx.value = 140 * DPR; }
    starMat.uniforms.uDpr.value = DPR;
  }
  let paused = false, clock = 0, ambient = 0;
  /** Slow breathing, 0..1 (constant when motion is reduced; held where it is while paused). */
  const breath = (period, ph = 0) => (reduced ? 0.5 : 0.5 + 0.5 * Math.sin((ambient * Math.PI * 2) / period + ph));
  function update(dt, now) {
    let busy = false;
    // Paused or reduced motion: nothing moves by itself (orbits, spin, breathing, twinkle), so a frame is drawn only for
    // a change, a camera move or a transition, and the loop stops after it.
    const still = paused || reduced;
    if (!still) { clock += dt; ambient += dt; busy = true; }
    if (flight) { stepFlight(now); busy = true; }
    else {
      if (zoomGoal != null) {
        const d = camDist(), k = Math.log(zoomGoal / d);
        if (Math.abs(k) > 0.0015) {
          _off.copy(camera.position).sub(controls.target).setLength(d * Math.exp(k * Math.min(1, dt * 9)));
          camera.position.copy(controls.target).add(_off);
          busy = true;
        } else zoomGoal = null;
      }
      if (panGoal) {
        _off.copy(panGoal).sub(controls.target);
        if (_off.lengthSq() < 1e-8) panGoal = null;
        else { _off.multiplyScalar(Math.min(1, dt * 9)); controls.target.add(_off); camera.position.add(_off); busy = true; }
      }
      if (controls.update()) busy = true;
    }
    if (tweens.length) { stepTweens(now); busy = true; }
    const d = camDist(), near = clamp(d * 0.02, 0.05, 40);
    if (Math.abs(near - camera.near) > near * 0.05) { camera.near = near; camera.updateProjectionMatrix(); }
    camera.updateMatrixWorld();
    starMat.uniforms.uTime.value = ambient;
    for (const gx of GAL_LIST) {
      gx.disk.rotation.y = clock * T.speed.galaxy * gx.spec.spin;
      const op = gx.op * T.galaxy.op * (gx.hover ? 1.25 : 1);
      gx.mat.uniforms.uOpacity.value = op;
      gx.hmat.uniforms.uOpacity.value = op * T.galaxy.haze;
      gx.mat.uniforms.uNear.value = gx.hmat.uniforms.uNear.value = d * 0.6 + fade.system * 90;
      gx.core.material.opacity = 0.3 * gx.spec.core * op;
    }
    // universe markers keep a constant size on screen; only a problem's dot breathes
    const fu = fade.universe, pxs = 1 / ((camera.projectionMatrix.elements[5] * H) / 2);
    for (const e of SYS.values()) {
      const u = e.u, shown = fu > 0.01;
      u.star.visible = shown;
      u.spark.visible = shown && e.system.stats.notices > 0;
      if (!shown) continue;
      u.star.material.opacity = fu * 0.9;
      u.star.scale.setScalar(u.px * pxs);
      if (u.spark.visible) {
        u.spark.scale.setScalar(7 * pxs);
        u.spark.material.opacity = fu * (e.system.stats.level === 'problem' ? 0.55 + 0.35 * breath(3.2) : 0.75);
      }
    }
    // the star systems of the galaxy in view
    const fg = fade.galaxy;
    for (const e of SYS.values()) {
      const mi = e.mini, shown = fg > 0.01 && e.system.group === miniGroup;
      mi.g.visible = shown;
      if (!shown) continue;
      for (const [m, base] of mi.mats) setOp(m, base() * fg * (mi.hover && m.isLineBasicMaterial ? 2.2 : 1));
      for (const dd of mi.dots) {
        if (!dd.off && !still) dd.ang += dt * T.speed.mini * Math.pow(3.6 / dd.r, 1.5) * (mi.hover ? 0.15 : 1);
        dd.pivot.rotation.y = dd.ang;
      }
      for (const hl of mi.halos) hl.material.opacity = fg * (T.work.base * 1.5 + T.work.amp * breath(4.5));
    }
    if (updateBlackHole(dt, still)) busy = true;
    if (ORR) updateOrrery(dt, still);
    updateLabels();
    placeCard(); placeTip();
    return busy;
  }
  function updateBlackHole(dt, still) {
    const full = trashRows.length > 0, ms = BH.mat.uniforms;
    ms.uScale.value = pxPerUnitAt1(); ms.uMaxPx.value = 40 * DPR;
    ms.uOpacity.value = (full ? 1 : 0.45) * (0.75 + 0.25 * fade.universe) + BH.boost;
    ms.uNear.value = camDist() * 0.2;
    if (!still) BH.disk.rotation.y -= dt * T.speed.galaxy * (full ? 9 : 4);
    BH.ring.material.opacity = (full ? 0.62 : 0.32) + BH.boost * 0.8;
    BH.glow.material.opacity = (full ? 0.2 : 0.1) + BH.boost * 0.3;
    if (BH.boost > 0) BH.boost = Math.max(0, BH.boost - dt * 1.5);
    for (const s of BH.sparks.values()) {
      if (!still) s.ang += dt * T.speed.sat * (40 / s.r) * 0.25;
      s.sp.position.set(Math.cos(s.ang) * s.r, 0, -Math.sin(s.ang) * s.r);
    }
    return BH.boost > 0;
  }
  const _sunW = new V3();
  function updateOrrery(dt, still) {
    const bs = bodyScale();
    for (const p of planets) {
      const off = p.pl.status === 'offline';
      const goal = off || p.frozen ? 0 : p.hover ? 0.1 : 1;
      p.speed += (goal - p.speed) * Math.min(1, dt * 5);
      if (!still) p.ang += dt * T.speed.orbit * Math.pow(FR[0] / FR[p.i], 1.5) * p.speed;
      p.pivot.rotation.y = p.ang;
      p.holder.scale.setScalar(bs);
      if (p.halo) p.halo.material.opacity = T.work.base + T.work.amp * breath(4.5, p.i);
      if (p.ring) { p.ring.visible = T.work.ring > 0; p.ring.material.opacity = T.work.ring; p.ring.material.rotation = -ambient * 2.4; }
      p.glow.material.opacity = off || p.pl.hidden ? 0 : p.hover ? T.planet.glow + 0.2 : T.planet.glow;
      p.track.material.opacity = p.hover || p.frozen ? T.orbit.hover : off ? T.orbit.off : T.orbit.on;
    }
    STAR.sunG.scale.setScalar((bs > 1 ? 1.15 : 1) * T.sun.size);
    STAR.sunMat.uniforms.uT.value = ambient;
    STAR.sunMat.uniforms.uHot.value = sunState.hover ? 1 : 0;
    STAR.glow.material.opacity = T.sun.glowOp + (sunState.hover ? 0.12 : 0);
    STAR.glow.scale.setScalar(O.sunR * T.sun.glow);
    STAR.halo.material.opacity = T.sun.haloOp;
    STAR.halo.scale.setScalar(O.sunR * T.sun.halo);
    STAR.corona.visible = T.sun.corona > 0;
    STAR.corona.material.opacity = T.sun.corona;
    STAR.corona.scale.setScalar(O.sunR * T.sun.halo * 0.9);
    STAR.corona.material.rotation = ambient * 0.02;
    for (const s of sats) {
      if (s.dying) continue;
      const holder = holderOf(s.target);
      if (!holder) continue;
      if (!still && !holder.frozen) s.ang += dt * s.speed * T.speed.sat * (holder.hover ? 0.15 : 1);
      s.body.position.set(Math.cos(s.ang) * s.rs, 0, -Math.sin(s.ang) * s.rs);
      if (s.pulse) {
        const k = reduced ? 0.4 : (ambient / 3.2) % 1;
        s.pulse.scale.setScalar((s.merged ? 0.48 : 0.3) * (1 + 1.1 * k));
        s.pulse.material.opacity = s.pulse.userData.op * (1 - k);
      }
    }
    ORR.root.updateMatrixWorld(true);
    STAR.sunG.getWorldPosition(_sunW);
    if (toScreen(_sunW, _sc)) { sunState.x = _sc[0]; sunState.y = _sc[1]; sunState.r = O.sunR * STAR.sunG.scale.x * _sc[3]; sunState.depth = _sc[2]; }
    for (const p of planets) {
      p.holder.getWorldPosition(p.world);
      p.ball.lookAt(camera.position);
      if (toScreen(p.world, _sc)) { p.x = _sc[0]; p.y = _sc[1]; p.r = O.pr * bs * _sc[3]; p.depth = _sc[2]; }
    }
    for (const s of sats) {
      s.body.getWorldPosition(s.world);
      s.token.lookAt(camera.position);
      if (toScreen(s.world, _sc)) { s.x = _sc[0]; s.y = _sc[1]; s.r = (s.merged ? 0.32 : 0.26) * bs * _sc[3] + 2; }
    }
  }

  // the loop: one requestAnimationFrame chain at most, and none while nothing moves
  let rafId = 0, lastFrame = 0, pointerInWin = false, refitTimer = 0, scrollQuietUntil = 0;
  let hudOn = false, hudFrames = 0, hudT = 0, hudFps = 0;
  function requestRender() { if (!rafId && !closed && !document.hidden) rafId = requestAnimationFrame(tick); }
  function tick(now) {
    rafId = 0;
    if (closed || document.hidden) return;
    if (now < scrollQuietUntil && !flight) { rafId = requestAnimationFrame(tick); return; }
    const throttled = pointerInWin && !flight && !dragging && !tweens.length;
    if (throttled && lastFrame && now - lastFrame < 1000 / 24 - 2) { rafId = requestAnimationFrame(tick); return; }
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 1 / 60;
    lastFrame = now;
    const busy = update(dt, now);
    renderer.render(scene, camera);
    if (hudOn) hud(now, throttled, busy);
    // requestRender, not a bare requestAnimationFrame: update() can already have asked for the next frame (OrbitControls
    // fires 'change' while damping), and a second request would start a parallel loop that doubles every frame.
    if (busy) requestRender();
    else if (!rafId) lastFrame = 0;
  }
  function hud(now, throttled, busy) {
    hudFrames++;
    if (now - hudT > 500 || !busy) {
      if (hudT) hudFps = (hudFrames * 1000) / Math.max(1, now - hudT);
      hudFrames = 0; hudT = now;
      const i = renderer.info.render;
      hudEl.textContent = `${busy ? `${hudFps.toFixed(0)} fps` : t('空闲：不重绘')}${throttled ? t('（限 24）') : ''}\n`
        + t('{calls} 次绘制 · {triangles}k 三角形 · {points}k 点', { calls: i.calls, triangles: (i.triangles / 1000).toFixed(1), points: (i.points / 1000).toFixed(1) }) + '\n'
        + t('像素比 {dpr} · {programs} 个着色器', { dpr: DPR, programs: renderer.info.programs?.length ?? 0 });
    }
  }
  function toggleHud(show = !hudOn) { hudOn = show; hudEl.hidden = !show; hudT = 0; requestRender(); }
  on(document, 'visibilitychange', () => {
    if (document.hidden) { if (rafId) cancelAnimationFrame(rafId); rafId = 0; }
    else { lastFrame = 0; requestRender(); }
  });
  on(root, 'scroll', (e) => { if (winRoot.contains(e.target)) scrollQuietUntil = performance.now() + 220; }, { capture: true, passive: true });
  on(root, 'pointerover', (e) => {
    const inWin = (winRoot.contains(e.target) && e.target !== winRoot) || Boolean(e.target.closest?.('.sm-ncard, .sm-finder'));
    if (inWin !== pointerInWin) { pointerInWin = inWin; requestRender(); }
  });
  const resizer = new ResizeObserver(() => {
    const w = Math.max(1, root.clientWidth), hh = Math.max(1, root.clientHeight), dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    if (w === W && hh === H && dpr === DPR) return;
    W = w; H = hh; DPR = dpr;
    renderer.setPixelRatio(DPR); renderer.setSize(W, H);
    camera.aspect = W / H; camera.updateProjectionMatrix();
    updateScales();
    for (const L of labels) L.w = 0;
    titleRect = null;
    cancel(refitTimer);
    refitTimer = later(() => { if (!flight) startFlight(poseFor(view), 0); }, 150);
    requestRender();
  });
  resizer.observe(root);
  if (mqReduce) on(mqReduce, 'change', (e) => { reduced = e.matches; requestRender(); });

  // ---- cards, the satellite tip and the notice card ----
  let cardFor = null;
  function showCard(content, pos) { cardFor = { pos }; card.replaceChildren(...content); card.classList.add('sm-show'); placeCard(); }
  function hideCard() { cardFor = null; card.classList.remove('sm-show'); }
  function placeCard() {
    if (!cardFor) return;
    const [x, y, r] = cardFor.pos();
    const w = card.offsetWidth, hh = card.offsetHeight;
    let left = x + r + 18;
    if (left + w > W - 10) left = x - r - 18 - w;
    card.style.left = `${clamp(left, 10, W - w - 10)}px`;
    card.style.top = `${clamp(y - hh / 2, 10, H - hh - 10)}px`;
  }
  const row = (label, ...value) => h('div', { class: 'sm-row' }, h('span', {}, label), h('span', {}, ...value));
  const head = (title, sub, mark = h('span', { class: 'sm-hubav' })) => h('div', { class: 'sm-ch' }, mark, h('div', {}, h('b', {}, title), h('span', {}, sub)));
  const foot = (text) => h('div', { class: 'sm-foot' }, text);
  const statusText = (pl) => (pl.status === 'busy' ? t('投递通道占用') : pl.status === 'offline' ? t('离线') : t('空闲'));
  const noticeText = (n) => (n ? h('span', { class: 'sm-k-problem' }, t('{count} 条待处理', { count: n })) : t('无'));
  function planetAria(pl) {
    const parts = [harnessInfo(pl.member.harness).label, statusText(pl), pl.hidden ? t('隐身中') : ''].filter(Boolean).join(t('，'));
    return t('{name}（{state}）：打开对话', { name: pl.member.name, state: parts });
  }
  function clusterCard(system) {
    const s = system.stats;
    return [head(system.cluster.name, system.group ? t('分组 {group}', { group: system.group }) : t('未分组')),
      h('div', { class: 'sm-mrow' }, system.planets.map((p) => h('span', { class: `sm-mi sm-st-${p.status}${p.hidden ? ' sm-ghost' : ''}` }, p.member.name))),
      row(t('群员'), t('{count} 名 · {busy} 工作中 · {online} 在线', { count: s.n, busy: s.busy, online: s.online })),
      row(t('通知'), noticeText(s.notices)),
      foot(t('点击（或滚轮向前）进入这个恒星系统'))];
  }
  function galaxyCard(gx) {
    const systems = model.galaxies.find((g) => g.name === gx.name)?.systems ?? [];
    return [head(galaxyName(gx.name), gx.name ? t('分组 · {count} 个群聊', { count: systems.length }) : t('没有分组的群聊 · {count} 个', { count: systems.length }), icon('orbit', 'sm-ch-ico')),
      ...systems.slice(0, 8).map((s) => row(s.cluster.name, t('{count} 人', { count: s.stats.n }), s.stats.busy ? ` · ${t('{count} 工作中', { count: s.stats.busy })}` : '',
        s.stats.notices ? h('span', { class: `sm-k-${s.stats.level}` }, ` · ${t('{count} 条通知', { count: s.stats.notices })}`) : '')),
      systems.length > 8 ? h('div', { class: 'sm-more' }, t('另有 {count} 个', { count: systems.length - 8 })) : null,
      foot(t('点击（或滚轮向前）拉近到星系'))].filter(Boolean);
  }
  function sunCard(system) {
    const s = system.stats, c = system.cluster;
    const hubNotices = system.satellites.filter((n) => n.target === null).length;
    return [head(c.name, t('Hub 群聊')),
      row(t('状态'), h('span', { class: 'sm-st-hub' }, c.paused ? t('投递已暂停') : t('投递未暂停'))),
      row(t('群员'), t('{count} 名，{online} 名在线', { count: s.n, online: s.online })),
      c.unread ? row(t('未读'), t('{count} 条', { count: c.unread })) : null,
      row(t('群通知'), hubNotices ? t('{count} 条（绕恒星的卫星）', { count: hubNotices }) : t('无')),
      foot(t('点击打开群聊：所有经过 Hub 的消息'))].filter(Boolean);
  }
  function planetCard(p) {
    const { pl, m } = p, info = harnessInfo(m.harness);
    const mine = ORR?.system.satellites.filter((n) => n.target === m.id).length ?? 0;
    return [head(m.name, [info.label, m.model].filter(Boolean).join(' · '), h('span', { class: 'sm-av', style: `--c:${info.color}` })),
      row(t('状态'), h('span', { class: `sm-st sm-st-${pl.status}` }, statusText(pl)), pl.hidden ? ` · ${t('隐身中')}` : ''),
      row(t('通知'), mine ? t('{count} 条待处理（卫星）', { count: mine }) : t('无')),
      foot(pl.status === 'offline' ? t('应用没在运行：消息只留在群聊记录里 · 点击查看最近的对话') : t('点击打开它在 {app} 里的原生对话', { app: info.label }))];
  }
  const binCard = () => [head(t('回收站'), t('{count} 个群 · 点击打开', { count: trashRows.length }), null),
    row(t('说明'), t('删除只是标记，可以恢复；永久删除只有你能做，而且不能撤销。'))];

  let tipFor = null;
  const noticeLine = (n) => String(n.message.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  function showTip(s) {
    tipFor = s;
    const holder = holderOf(s.target);
    if (holder) { holder.frozen++; s.held = true; }
    tip.replaceChildren(satIcon(s.level), s.merged ? t('{count} 条系统通知', { count: s.notices.length }) : noticeLine(s.notices[0]));
    tip.classList.add('sm-show');
    placeTip();
  }
  function hideTip() {
    if (tipFor?.held) { const holder = holderOf(tipFor.target); if (holder) holder.frozen = Math.max(0, holder.frozen - 1); tipFor.held = false; }
    tipFor = null; tip.classList.remove('sm-show');
  }
  function placeTip() {
    if (!tipFor) return;
    const w = tip.offsetWidth;
    tip.style.left = `${clamp(tipFor.x - w / 2, 8, W - w - 8)}px`;
    tip.style.top = `${clamp(tipFor.y - 34, 8, H - 30)}px`;
  }

  // the notice card (a click on a satellite)
  let ncardFor = null;
  const whoLabel = (target) => (target === null ? t('整个群 · 绕恒星') : t('{name} · 绕它的行星', { name: P[target]?.m.name ?? target }));
  function openNcard(s) {
    closeNcard();
    ncardFor = s;
    const holder = holderOf(s.target);
    if (holder) holder.frozen++;
    renderNcard();
    ncard.classList.add('sm-show');
    const w = ncard.offsetWidth, hh = ncard.offsetHeight;
    let left = s.x + 18;
    if (left + w > W - 10) left = s.x - 18 - w;
    ncard.style.left = `${clamp(left, 10, W - w - 10)}px`;
    ncard.style.top = `${clamp(s.y - 20, 10, H - hh - 10)}px`;
    ncard.querySelector('.sm-btn.sm-primary')?.focus();
  }
  function closeNcard() {
    if (!ncardFor) return;
    const holder = holderOf(ncardFor.target);
    if (holder) holder.frozen = Math.max(0, holder.frozen - 1);
    ncardFor = null; ncard.classList.remove('sm-show');
  }
  function renderNcard() {
    const s = ncardFor, cid = ORR.system.cluster.id;
    const close = h('button', { type: 'button', class: 'sm-x', 'aria-label': t('关闭'), onclick: closeNcard }, icon('close', 'ico-sm'));
    const openers = () => [
      h('button', { type: 'button', class: 'sm-btn', onclick: () => { closeNcard(); openHub(cid); } }, t('打开群聊')),
      s.target !== null ? h('button', { type: 'button', class: 'sm-btn', onclick: () => { const target = s.target; closeNcard(); openMember(cid, target); } }, t('打开 {name} 的对话', { name: P[s.target]?.m.name ?? s.target })) : null,
    ];
    const kind = (n) => (n.level === 'problem' ? t('问题') : t('提醒'));
    if (!s.merged) {
      const n = s.notices[0];
      ncard.replaceChildren(
        h('div', { class: 'sm-nh' }, satIcon(n.level), h('span', { class: `sm-kind sm-k-${n.level}` }, kind(n)), h('span', {}, `${whoLabel(s.target)} · ${fmtTime(n.message.createdAt)}`), close),
        h('div', { class: 'sm-nbody' }, String(n.message.body ?? '')),
        h('div', { class: 'sm-nacts' }, h('button', { type: 'button', class: 'sm-btn sm-primary', onclick: () => ack([n.id]) }, t('知道了')), ...openers()));
    } else {
      ncard.replaceChildren(
        h('div', { class: 'sm-nh' }, satIcon(s.level), h('span', { class: `sm-kind sm-k-${s.level}` }, t('{count} 条系统通知', { count: s.notices.length })), h('span', {}, whoLabel(s.target)), close),
        h('div', { class: 'sm-nlist' }, s.notices.map((n) => h('div', { class: 'sm-ni' }, satIcon(n.level),
          h('div', { class: 'sm-t' }, noticeLine(n), h('small', {}, `${kind(n)} · ${fmtTime(n.message.createdAt)}`)),
          h('button', { type: 'button', class: 'sm-btn', onclick: () => ack([n.id]) }, t('知道了'))))),
        h('div', { class: 'sm-nacts' }, h('button', { type: 'button', class: 'sm-btn sm-primary', onclick: () => ack(s.notices.map((n) => n.id)) }, t('全部知道了')), ...openers()));
    }
  }
  /** 知道了: hidden in this browser (the real read state is untouched); the satellite falls into its planet or drifts away. */
  function ack(ids) {
    const s = ncardFor;
    if (!s || !ORR) return;
    const cid = ORR.system.cluster.id;
    dismissed.add(cid, ids);
    const gone = new Set(ids);
    const remaining = s.notices.filter((n) => !gone.has(n.id));
    closeNcard();
    if (!remaining.length || !s.merged) { s.dying = true; flyOut(s); }
    refreshNotices();
    if (s.merged && remaining.length > 3) {
      const again = sats.find((x) => x.key === s.key && !x.dying);
      if (again) openNcard(again);
    }
    try { windows?.satellitesChanged?.(cid); } catch (error) { console.warn('star map windows: satellitesChanged failed', error); }
  }

  // ---- breadcrumb, the cluster's name under its system, the one-time hint ----
  const HINTS = {
    universe: () => t('点星系进入分组 · 按 / 搜索群聊 · 拖动旋转 · 滚轮缩放'),
    galaxy: () => t('点恒星系统进入群聊 · 滚轮拉到最远返回宇宙'),
    system: () => t('点恒星打开 Hub 群聊 · 点行星打开原生对话 · 小卫星是待处理的通知'),
  };
  function updateChrome() {
    const parts = [];
    const uni = [icon('orbit', 'ico-sm'), t('宇宙')];
    parts.push(view.level === 'universe' ? h('span', { class: 'sm-cur' }, ...uni)
      : h('button', { type: 'button', onclick: () => go({ level: 'universe', group: null, cid: null }) }, ...uni));
    if (view.level !== 'universe') {
      parts.push(icon('chevron-left', 'ico-sm sm-sep'));
      const group = view.group;
      parts.push(view.level === 'galaxy' ? h('span', { class: 'sm-cur' }, galaxyName(group))
        : h('button', { type: 'button', onclick: () => go({ level: 'galaxy', group, cid: null }) }, galaxyName(group)));
    }
    if (view.level === 'system' && ORR) {
      parts.push(icon('chevron-left', 'ico-sm sm-sep'), h('span', { class: 'sm-cur' }, ORR.system.cluster.name));
    }
    crumbs.replaceChildren(...parts);
    if (view.level === 'system' && ORR) {
      const c = ORR.system.cluster, s = ORR.system.stats;
      sysTitle.replaceChildren(h('b', {}, c.name), h('small', {}, [t('{count} 名群员', { count: s.n }),
        s.busy ? t('{count} 工作中', { count: s.busy }) : '', s.offline ? t('{count} 离线', { count: s.offline }) : ''].filter(Boolean).join(' · ')));
      sysTitle.setAttribute('aria-label', t('打开 Hub 群聊：{name}', { name: c.name }));
      sysTitle.title = t('打开 Hub 群聊');
      sysTitle.hidden = false;
    } else sysTitle.hidden = true;
    hint.textContent = model.galaxies.length ? HINTS[view.level]() : t('还没有群聊。在聊天界面新建群聊后，它会出现在这里。');
    titleRect = null;
  }
  on(sysTitle, 'click', () => clickPick({ type: 'sun' }));
  on(sysTitle, 'pointerenter', () => { if (ORR) setHover(STAR.sunProxy.userData.pick); });
  on(sysTitle, 'pointerleave', () => { if (hovered === STAR.sunProxy.userData.pick) setHover(null); });
  const showHint = () => {
    hint.classList.add('sm-show');
    later(() => hint.classList.remove('sm-show'), 6500);
  };

  // ---- toolbar: list, pause, reset, theme, help ----
  function syncPause() {
    pauseBtn.setAttribute('aria-pressed', String(paused));
    pauseBtn.replaceChildren(svgFrom(paused ? PLAY_ICON : PAUSE_ICON, '0 0 16 16'));
    pauseBtn.title = paused ? t('继续公转') : t('暂停公转');
    pauseBtn.setAttribute('aria-label', pauseBtn.title);
    requestRender();
  }
  on(pauseBtn, 'click', () => { paused = !paused; syncPause(); });
  on(resetBtn, 'click', resetView);
  const popups = () => [themeMenu, help];
  function closePopups(except = null) {
    for (const p of popups()) if (p !== except && !p.hidden) toggle(p, false);
    if (except !== finder.el) finder.close(false);
  }
  function toggle(panel, show = panel.hidden) {
    const btn = panel === themeMenu ? themeBtn : helpBtn;
    if (show) closePopups(panel);
    panel.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
    if (show && panel === themeMenu) themeMenu.querySelector('[aria-checked="true"]')?.focus();
  }
  on(helpBtn, 'click', (e) => { e.stopPropagation(); toggle(help); });
  on(themeBtn, 'click', (e) => { e.stopPropagation(); toggle(themeMenu); });
  function drawThemeMenu() {
    const lbl = THEMES[themeName];
    themeBtn.replaceChildren(svgFrom(THEME_ICON[themeName]));
    themeBtn.title = t('主题：{name}', { name: t(lbl.label) });
    themeBtn.setAttribute('aria-label', themeBtn.title);
    themeMenu.replaceChildren(...THEME_ORDER.map((name) => {
      const th = THEMES[name];
      return h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(name === themeName), 'aria-label': `${t(th.label) === th.en ? th.en : `${t(th.label)} ${th.en}`}${t('：')}${t(th.sub)}`,
        onclick: () => { applyTheme(name); toggle(themeMenu, false); themeBtn.focus(); } },
      h('b', {}, h('span', { class: 'sm-ticon' }, svgFrom(THEME_ICON[name])), t(th.label), t(th.label) === th.en ? null : h('span', { class: 'sm-en' }, th.en)), h('small', {}, t(th.note)));
    }));
  }
  function drawHelp() {
    const legendRow = (mark, text) => h('div', { class: 'sm-r' }, mark, h('span', {}, text));
    help.replaceChildren(
      h('h4', {}, t('群员 · 行星')),
      legendRow(h('span', { class: 'sm-dot sm-lg-on' }), t('在线')),
      legendRow(h('span', { class: 'sm-dot sm-lg-work' }), t('正在工作（一圈淡淡的光，缓慢呼吸）')),
      legendRow(h('span', { class: 'sm-dot sm-lg-off' }), t('离线（变灰，停转）')),
      legendRow(h('span', { class: 'sm-dot sm-lg-ghost' }), t('隐身中（半透明，轨道是虚线）')),
      h('h4', {}, t('卫星 · 系统通知')),
      legendRow(satIcon('problem'), t('问题，比如投递失败（会轻微脉冲）')),
      legendRow(satIcon('attention'), t('提醒，比如任务被退回')),
      h('p', {}, t('绕行星转的属于该群员，绕恒星转的属于整个群聊。点卫星看详情；「知道了」只在这个浏览器里收起它，不改已读。')),
      h('h4', {}, t('操作')),
      h('p', {}, t('点星系、恒星系统进入；点恒星打开 Hub 群聊，点行星打开该群员的原生对话。宇宙一角的黑洞是回收站。按 / 或 Ctrl+K 打开群聊列表，可以按群聊、分组或群员名搜索。拖动转动视角，滚轮缩放（推到底进入，拉到底返回），双击空白处复位，Esc 返回上一层，F 显示帧率。')));
  }
  on(document, 'pointerdown', (e) => {
    if (!help.hidden && !help.contains(e.target) && !helpBtn.contains(e.target)) toggle(help, false);
    if (!themeMenu.hidden && !themeMenu.contains(e.target) && !themeBtn.contains(e.target)) toggle(themeMenu, false);
    if (ncardFor && !ncard.contains(e.target)) closeNcard();
  });

  // ---- the cluster list ----
  const finder = createFinder({
    button: finderBtn, signal: ac.signal,
    model: () => model,
    trashCount: () => trashRows.length,
    current: () => (view.level === 'system' ? view.cid : null),
    onOpen: () => closePopups(finder.el),
    choose(rowItem) {
      if (flight) return;
      if (rowItem.type === 'trash') return openBin();
      const { system } = rowItem;
      const member = rowItem.type === 'member' ? rowItem.planet.member.id : null;
      go({ level: 'system', cid: system.cluster.id, group: system.group }, () => { if (member) openMember(system.cluster.id, member); });
    },
  });
  root.append(finder.el);

  // ---- keys (data.js keyAction): / and Ctrl+K the list, Esc back a level, F the frame rate ----
  // On the document, which runs before the host's Esc (on window): an Esc used here is preventDefault-ed, so the view
  // stays open; at the universe it is left to the host and closes the star map. Keys in a chat window are its own.
  const typingIn = (target) => target instanceof Element && Boolean(target.closest('textarea, input, select, [contenteditable="true"], [contenteditable=""]'));
  const whereOf = (target) => (target === document.body || target === document.documentElement ? 'sky'
    : !(target instanceof Node) || !root.contains(target) ? 'outside' : winRoot.contains(target) && target !== winRoot ? 'window' : 'sky');
  on(document, 'keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const open = finder.isOpen() ? 'finder' : ncardFor ? 'ncard' : !help.hidden ? 'help' : !themeMenu.hidden ? 'menu' : null;
    const action = keyAction({ key: e.key, mod: e.ctrlKey || e.metaKey, alt: e.altKey },
      { where: whereOf(e.target), typing: typingIn(e.target), open, top: view.level === 'universe' });
    if (!action) return;
    e.preventDefault();
    if (action === 'finder-toggle') finder.toggle();
    else if (action === 'finder-open') finder.open();
    else if (action === 'hud') toggleHud();
    else if (action === 'leave') root.focus({ preventScroll: true });
    else if (action === 'up') { if (!flight) up(); }
    else if (open === 'finder') finder.close();
    else if (open === 'ncard') { closeNcard(); root.focus({ preventScroll: true }); }
    else if (open === 'help') { toggle(help, false); helpBtn.focus(); }
    else { toggle(themeMenu, false); themeBtn.focus(); }
  });

  // ---- themes: nothing is reloaded, windows and the current level stay as they are ----
  function applyTheme(name, save = true) {
    themeName = Object.hasOwn(THEMES, name) ? name : 'luna';
    T = THEMES[themeName];
    applyCss();
    setBackground();
    buildStars();
    buildNebulae();
    hemi.color.set(T.light.sky); hemi.groundColor.set(T.light.ground); hemi.intensity = T.light.hemi;
    headlight.color.set(T.light.headColor); headlight.intensity = T.light.head;
    STAR.light.color.set(T.light.sunColor); STAR.light.intensity = T.light.sun;
    const u = STAR.sunMat.uniforms;
    u.uGain.value = T.sun.gain; u.uEdge.value.set(...T.sun.edge); u.uMid.value.set(...T.sun.mid); u.uCore.value.set(...T.sun.core);
    STAR.glow.material.color.set(T.sun.glowColor); STAR.halo.material.color.set(T.sun.haloColor);
    for (const [k, m] of Object.entries(SAT_MAT)) { m.color.set(SEV_HEX()[k]); m.emissive.set(SEV_HEX()[k]); m.emissiveIntensity = T.sat.emissive; }
    themeBlackHole();
    rebuild({ galaxies: true });
    drawThemeMenu();
    if (save) saveTheme(storage, themeName);
  }

  // ---- the model again: after an event, a 知道了, a theme ----
  /**
   * Builds the sky again from the model. `relayout`: the structure changed, so everything is laid out again and the
   * camera snaps to the view's pose; `galaxies`: the galaxies' particles too (a theme); otherwise only the star systems
   * and the open one, keeping every phase and the camera. The view stays, or goes up to what still exists (a cluster
   * moved to the bin, a group renamed away).
   */
  function rebuild({ relayout = false, galaxies = relayout } = {}) {
    setHover(null);
    hideCard(); hideTip(); closeNcard();
    disposeOrrery();
    if (relayout) {
      layout = layoutSky(model.galaxies);
      BH.g.position.set(...layout.blackHole);
    }
    if (galaxies) {
      const ops = new Map(GAL_LIST.map((g) => [g.name, g.op]));
      buildGalaxies();
      for (const gx of GAL_LIST) gx.op = ops.get(gx.name) ?? gx.op;
      updateScales();
    }
    buildSystems();
    let next = view;
    if (next.level === 'system' && !SYS.has(next.cid)) next = { level: 'galaxy', group: next.group, cid: null };
    if (next.level === 'galaxy' && !GALS.has(next.group)) next = { level: 'universe', group: null, cid: null };
    if (relayout || !sameView(next, view)) jumpTo(next);
    else {
      if (view.level === 'system') buildOrrery(view.cid);
      refreshOverview();
      updateChrome();
    }
    finder.refresh();
    requestRender();
  }
  /** The model from the state; the sky is laid out again only when its structure changed. Waits for a flight to land. */
  let pendingRebuild = null;
  function refreshModel() {
    model = skyModel(state, (cid) => dismissed.of(cid));
    const key = skyKey(model);
    const relayout = key !== structure || pendingRebuild === 'layout';
    structure = key;
    if (flight) { pendingRebuild = relayout ? 'layout' : 'systems'; cancel(refreshTimer); refreshTimer = later(refreshModel, 250); return; }
    pendingRebuild = null;
    rebuild({ relayout });
  }
  /** After 知道了: only the satellites and counts change, so a satellite on its way out keeps flying. */
  function refreshNotices() {
    model = skyModel(state, (cid) => dismissed.of(cid));
    const sev = SEV_HEX();
    for (const [id, e] of SYS) {
      const system = model.systems.get(id);
      if (!system) continue;
      e.system = system;
      e.pick.system = system;
      const color = sev[system.stats.level ?? 'attention'];
      e.u.spark.material.color.set(color);
      e.mini.spark.material.color.set(color);
      e.mini.spark.visible = system.stats.notices > 0;
    }
    if (ORR && model.systems.has(ORR.system.cluster.id)) { ORR.system = model.systems.get(ORR.system.cluster.id); rebuildSats(); }
    refreshOverview();
    updateChrome();
    finder.refresh();
    requestRender();
  }
  let refreshTimer = 0, trashTimer = 0, recountTimer = 0;
  const refreshSoon = () => { cancel(refreshTimer); refreshTimer = later(refreshModel, 150); };
  let reloading = 0;
  /** A fresh snapshot; the frames streamed while it is read are applied again over it (only those newer than it). */
  async function reloadState() {
    const mine = ++reloading;
    const done = snapshotRead();
    try {
      const [snapshot, harnesses] = await Promise.all([ctx.api('GET', '/api/state'), ctx.api('GET', '/api/harnesses').catch(() => state.harnesses)]);
      if (closed || mine !== reloading) return;
      const changes = loadSnapshot(state, snapshot, harnesses, kept);
      state.messages = new Map([...state.messages].filter(([cid]) => state.clusters.has(cid)));
      refreshSoon();
      loadNotices();
      for (const change of changes) effects(change);
    } catch { /* keep what is drawn; the next event tries again */ } finally { done(); }
  }

  // the newest messages of each cluster, for its satellites: two reads at a time, in the background
  const noticeQueue = [];
  let noticeReads = 0;
  function loadNotices() {
    for (const cid of state.clusters.keys()) if (!state.messages.has(cid) && !noticeQueue.includes(cid)) { state.messages.set(cid, []); noticeQueue.push(cid); }
    pumpNotices();
  }
  function pumpNotices() {
    while (noticeReads < 2 && noticeQueue.length && !closed) {
      const cid = noticeQueue.shift();
      noticeReads++;
      ctx.api('GET', `/api/clusters/${encodeURIComponent(cid)}/messages?limit=100`).then((list) => {
        if (closed || !state.clusters.has(cid) || !Array.isArray(list)) return;
        setMessages(state, cid, list);
        refreshSoon();
      }).catch(() => { /* no satellites for it this time */ }).finally(() => { noticeReads--; pumpNotices(); });
    }
  }

  /** One frame of the stream, once the sky is drawn (the frames before that are in `early`). */
  function react(event) {
    const change = applySkyEvent(state, event);
    if (change) effects(change);
  }
  /** What a change asks for. `draw` false: the sky was drawn from the state already holding it. */
  function effects(change, draw = true) {
    if (change.reload) reloadState();
    if (change.trash) { cancel(trashTimer); trashTimer = later(loadTrash, 400); }
    // the read position moved past the messages held here: the Hub counts (one read for a burst)
    if (change.recount) { cancel(recountTimer); recountTimer = later(reloadState, 1000); }
    if (!draw) return;
    if (change.layout || change.status || change.notices.length) refreshSoon();
    else if (change.unread) finder.refresh();   // the count shows in the list; a card reads it when it opens
    if (change.layout && !change.reload) loadNotices();
  }
  const stopLanguage = onLanguageChange(() => {
    refreshOverview(); updateChrome(); drawThemeMenu(); drawHelp(); syncPause(); finder.refresh();
    for (const p of planets) p.lab.el.setAttribute('aria-label', planetAria(p.pl));
    if (ncardFor) renderNcard();
    for (const L of labels) L.w = 0;
    requestRender();
  });

  // ---- chat windows (starmap/windows.js) or, without them, the chat page ----
  let windows = null;
  if (typeof windowsModule?.createWindows === 'function') {
    try { windows = windowsModule.createWindows({ root: winRoot, ctx }); } catch (error) { console.warn('star map windows did not start', error); }
  }
  function openHub(cid) {
    if (windows) { try { windows.open({ kind: 'hub', clusterId: cid }); return; } catch (error) { console.warn('star map windows: open failed', error); } }
    ctx.openChat(cid);
  }
  function openMember(cid, memberId) {
    if (windows) { try { windows.open({ kind: 'member', clusterId: cid, memberId }); return; } catch (error) { console.warn('star map windows: open failed', error); } }
    ctx.openChat(cid);
  }

  // ---- first draw: where the page was (its selected cluster), else the universe ----
  setBackground();
  buildStars();
  buildNebulae();
  themeBlackHole();
  BH.label = addLabel({ el: mkLabel('sm-ung sm-bin', BH.prox.userData.pick), level: 'universe', at: () => frontOf(BH.g.position, 66, 0), dy: () => 4, clamp: true, collide: true, prio: 2 });
  buildGalaxies();
  buildSystems();
  syncSparks(false);
  drawThemeMenu();
  drawHelp();
  syncPause();
  updateScales();
  jumpTo({ level: 'universe', group: null, cid: null });
  requestRender();
  // Opened from a cluster: the camera flies from the universe into its star system.
  const start = model.systems.get(ctx.clusterId);
  if (start) later(() => { if (view.level === 'universe') go({ level: 'system', cid: start.cluster.id, group: start.group }); }, reduced ? 0 : 500);
  later(showHint, reduced ? 0 : 600);
  loadNotices();
  ready = true;
  for (const change of early) effects(change, false);
  // Focus into the sky, so its keys work at once, unless the user moved it elsewhere while it loaded (the host leaves
  // it on its back button, in the view's layer).
  const active = document.activeElement;
  if (!active || active === document.body || el.parentElement?.contains(active)) root.focus({ preventScroll: true });

  return {
    dispose() {
      if (closed) return;
      closed = true;
      ac.abort();
      for (const id of timers) clearTimeout(id);
      timers.clear();
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      resizer.disconnect();
      try { stopEvents(); } catch { /* the host unsubscribes it too */ }
      stopLanguage();
      try { windows?.closeAll(); } catch (error) { console.warn('star map windows: closeAll failed', error); }
      disposeOrrery();
      for (const gx of GAL_LIST) disposeTree(gx.grp);
      for (const e of SYS.values()) disposeTree(e.group);
      for (const n of NEBULAE) disposeTree(n);
      for (const s of BH.sparks.values()) s.sp.material.dispose();
      disposeTree(BH.g);
      disposeTree(STAR.g);
      starPts.geometry.dispose(); starMat.dispose();
      scene.background?.dispose?.();
      for (const x of shared) x.dispose?.();
      controls.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      root.remove();
    },
  };
}
