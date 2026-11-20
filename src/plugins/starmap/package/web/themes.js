// The star map's three themes (docs/starmap.md「主题」 & 「4. 三套主题真正 UI 差异化」):
//   暗月 Luna  · deep slate observatory, cool moon-silver accent, crisp 8px matte glass, calm
//   群星 Astra · frosted indigo-violet nebula glass, cyan & violet accents, rounded 16px HUD with luminous halo
//   炽阳 Sol   · heavy obsidian-bronze astrolabe, gilded brass & corona amber, sharp 5px double-bevelled panels
// prefers-reduced-motion still wins over any theme (no orbit, no twinkle, no breathing). `label`, `sub` and `note` are
// msgids (i18n/en.json), translated where they are shown; `en` is a name and stays as it is.

export const THEME_KEY = 'orrery.starmapTheme';
export const THEME_ORDER = ['luna', 'astra', 'sol'];

export const THEMES = {
  luna: {
    label: '暗月', en: 'Luna', sub: '深蓝夜空', note: '月之暗面。群星噤声，轨道沉入深蓝，宜守望漫长的夜。（默认）',
    css: {
      '--bg-solid': '#080e1c', '--surface': 'rgba(13, 21, 39, .92)', '--panel': 'rgba(13, 21, 39, .97)', '--bar': 'rgba(10, 17, 32, .84)',
      '--edge': 'rgba(154, 182, 222, .22)', '--edge-hi': 'rgba(197, 220, 248, .48)', '--edge-c': '#9ab6de', '--quiet': 'rgba(200, 220, 255, .04)',
      '--bar-grad': 'linear-gradient(180deg, rgba(16, 26, 46, .92), rgba(10, 17, 32, .88))',
      '--win-glow': '0 0 0 0 transparent',
      '--ink': '#dde6f4', '--ink2': '#a6b7d0', '--ink3': '#798ca8',
      '--brass': '#8fb4e2', '--brass-hi': '#c5dcf8', '--brass-lo': '#4c6587',
      '--k-task': '#9fc3e8', '--k-warn': '#e08677', '--k-info': '#8fbcd0', '--ether': '#93a8d8', '--work': '#9fd4dc', '--ok': '#8fb79a',
      '--badge': '#c9d7ea', '--badge-ink': '#08101e', '--member-sat': '0.7',
      // Unified Star Map 2.0 tokens
      '--starmap-bg': '#080e1c', '--starmap-surface': '#0d1527', '--starmap-surface-2': '#142038',
      '--starmap-glass': 'rgba(11, 18, 33, .95)', '--starmap-glass-dim': 'rgba(9, 15, 28, .8)', '--starmap-blur': '10px',
      '--starmap-edge': 'rgba(154, 182, 222, .22)', '--starmap-edge-strong': 'rgba(197, 220, 248, .48)',
      '--starmap-ink': '#dde6f4', '--starmap-ink2': '#a6b7d0', '--starmap-ink3': '#798ca8', '--starmap-muted': '#8296b4',
      '--starmap-accent': '#8fb4e2', '--starmap-accent-hi': '#c5dcf8', '--starmap-accent-soft': 'rgba(143, 180, 226, .16)', '--starmap-on-accent': '#08101e',
      '--starmap-ether': '#93a8d8',
      '--starmap-bar-grad': 'linear-gradient(180deg, rgba(16, 26, 46, .92), rgba(10, 17, 32, .88))',
      '--starmap-win-head-grad': 'linear-gradient(180deg, rgba(143, 180, 226, .08), rgba(143, 180, 226, 0))',
      '--starmap-win-glow': '0 0 0 0 transparent', '--starmap-win-shadow': '0 18px 46px -18px rgba(0, 0, 0, .82)',
      '--starmap-radius': '8px', '--starmap-radius-sm': '6px',
      '--starmap-k-task': '#9fc3e8', '--starmap-k-warn': '#e08677', '--starmap-k-info': '#8fbcd0',
    },
    bg: ['#0f1a33', '#0b1328', '#070c1a'],
    washes: [['40,70,130', 0.14, 0.2, 0.15, 0.9]],
    sun: { size: 1, edge: [0.78, 0.55, 0.36], mid: [1.0, 0.86, 0.66], core: [1.0, 0.96, 0.88], gain: 1, glowColor: '#ffe2b8', glow: 2.6, glowOp: 0.5, haloColor: '#f3d2a4', halo: 4.4, haloOp: 0.16, corona: 0 },
    light: { sky: '#6a7a98', ground: '#141824', hemi: 0.5, headColor: '#e6eaf2', head: 1.3, sunColor: '#f6e2c6', sun: 9 },
    orbit: { color: '#9aa6bc', on: 0.22, off: 0.12, hover: 0.45 },
    planet: { mute: 0.28, toward: '#7d8696', emissive: 0.14, glow: 0.12 },
    stars: { n: 2400, twinkle: 0.06, freq: 1, gain: 1, tint: [[1, 0.93, 0.84], [0.9, 0.93, 1], [1, 0.98, 0.94]] },
    nebulae: [],
    nebula: 0,
    galaxy: { spiral: 4500, ell: 3000, hazeS: 50, hazeE: 30, haze: 1, op: 1, core: [0.92, 0.9, 0.86], edges: ['#d6c8b2', '#aab8d4', '#beb4d2', '#9ea6b6'] },
    ustar: { working: '#c6dde2', online: '#ddd6ca', offline: '#6f747e' },
    speed: { orbit: 0.06, mini: 0.2, sat: 0.45, galaxy: 0.006 },
    work: { base: 0.08, amp: 0.12, ring: 0 },
    sat: { pulse: 0.35, pulseImp: 0, glow: 0.22, emissive: 0.45 },
    mini: { glow: 0.75 },
    bh: { n: 1300, inner: '#e6eeff', outer: '#4f69a8', ring: '#c4d4f0', glow: '#4462a6' },
  },
  astra: {
    label: '群星', en: 'Astra', sub: '星云紫青', note: '游走于日与月之间的星辰。不灼目，亦不沉寂，光与暗在此缔结停战协定。',
    css: {
      '--bg-solid': '#0e0a24', '--surface': 'rgba(24, 17, 56, .84)', '--panel': 'rgba(26, 18, 58, .95)', '--bar': 'rgba(22, 15, 50, .72)',
      '--edge': 'rgba(166, 134, 248, .34)', '--edge-hi': 'rgba(125, 211, 252, .7)', '--edge-c': '#a686f8', '--quiet': 'rgba(190, 170, 255, .07)',
      '--bar-grad': 'linear-gradient(135deg, rgba(125, 211, 252, .14), rgba(183, 148, 246, .16) 55%, rgba(24, 16, 56, .78))',
      '--win-glow': '0 0 34px -6px rgba(125, 211, 252, .45), 0 0 22px -8px rgba(183, 148, 246, .4)',
      '--ink': '#ede8ff', '--ink2': '#beb5e6', '--ink3': '#948ac2',
      '--brass': '#7dd3fc', '--brass-hi': '#c4f1ff', '--brass-lo': '#4b6ca0',
      '--k-task': '#b794f6', '--k-warn': '#ff6f96', '--k-info': '#7dd3fc', '--ether': '#b794f6', '--work': '#7ff0dc', '--ok': '#8fe0bb',
      '--badge': '#d9cfff', '--badge-ink': '#0e0a24', '--member-sat': '0.82',
      // Unified Star Map 2.0 tokens
      '--starmap-bg': '#0e0a24', '--starmap-surface': '#181139', '--starmap-surface-2': '#22194d',
      '--starmap-glass': 'rgba(24, 16, 56, .82)', '--starmap-glass-dim': 'rgba(19, 12, 46, .64)', '--starmap-blur': '18px',
      '--starmap-edge': 'rgba(166, 134, 248, .34)', '--starmap-edge-strong': 'rgba(125, 211, 252, .7)',
      '--starmap-ink': '#ede8ff', '--starmap-ink2': '#beb5e6', '--starmap-ink3': '#948ac2', '--starmap-muted': '#9d93cc',
      '--starmap-accent': '#7dd3fc', '--starmap-accent-hi': '#c4f1ff', '--starmap-accent-soft': 'rgba(125, 211, 252, .18)', '--starmap-on-accent': '#0e0a24',
      '--starmap-ether': '#b794f6',
      '--starmap-bar-grad': 'linear-gradient(135deg, rgba(125, 211, 252, .14), rgba(183, 148, 246, .16) 55%, rgba(24, 16, 56, .78))',
      '--starmap-win-head-grad': 'linear-gradient(105deg, rgba(125, 211, 252, .16), rgba(183, 148, 246, .12) 60%, transparent)',
      '--starmap-win-glow': '0 0 34px -6px rgba(125, 211, 252, .45), 0 0 22px -8px rgba(183, 148, 246, .4)',
      '--starmap-win-shadow': '0 26px 70px -22px rgba(8, 4, 28, .9)',
      '--starmap-radius': '16px', '--starmap-radius-sm': '10px',
      '--starmap-k-task': '#b794f6', '--starmap-k-warn': '#ff6f96', '--starmap-k-info': '#7dd3fc',
    },
    bg: ['#1d1446', '#130d33', '#08061a'],
    washes: [['140, 85, 230', 0.18, 0.15, 0.2, 0.8], ['40, 195, 205', 0.11, 0.86, 0.78, 0.75]],
    sun: { size: 1, edge: [0.42, 0.52, 0.92], mid: [0.74, 0.84, 1.0], core: [0.95, 0.98, 1.0], gain: 1.08, glowColor: '#d2e2ff', glow: 2.9, glowOp: 0.62, haloColor: '#9cb2ff', halo: 5, haloOp: 0.2, corona: 0 },
    light: { sky: '#7a6fb8', ground: '#100c22', hemi: 0.55, headColor: '#e2e4ff', head: 1.3, sunColor: '#d4e2ff', sun: 10 },
    orbit: { color: '#a998ec', on: 0.25, off: 0.13, hover: 0.55 },
    planet: { mute: 0.3, toward: '#7c80b8', emissive: 0.18, glow: 0.2 },
    stars: { n: 3400, twinkle: 0.15, freq: 2, gain: 1.1, tint: [[0.76, 0.82, 1], [0.86, 0.76, 1], [0.95, 0.96, 1]] },
    nebulae: [['150,90,255', [-3000, 900, -3800], 5200, 0.5], ['40,200,210', [3600, -500, -2400], 4600, 0.42], ['100,110,255', [-3800, -1000, 2600], 4800, 0.36], ['190,110,240', [2600, 1500, 3400], 4000, 0.3]],
    nebula: 0.45,
    galaxy: { spiral: 5500, ell: 3600, hazeS: 120, hazeE: 70, haze: 1.3, op: 1.05, core: [0.78, 0.96, 1], edges: ['#a68cff', '#7cc8ff', '#c48cff', '#8f98d8'] },
    ustar: { working: '#9ff2ec', online: '#d8d0f6', offline: '#6a6488' },
    speed: { orbit: 0.1, mini: 0.35, sat: 0.7, galaxy: 0.009 },
    work: { base: 0.12, amp: 0.16, ring: 0.4 },
    sat: { pulse: 0.6, pulseImp: 0.45, glow: 0.35, emissive: 0.6 },
    mini: { glow: 0.85 },
    bh: { n: 1700, inner: '#a8f6ff', outer: '#8e5cff', ring: '#bda6ff', glow: '#7458d6' },
  },
  sol: {
    label: '炽阳', en: 'Sol', sub: '日冕金焰', note: '日冕全开。恒星解除封印，群星以第一纪元的速度公转——直视者后果自负。',
    css: {
      '--bg-solid': '#150e08', '--surface': 'rgba(34, 22, 12, .92)', '--panel': 'rgba(38, 25, 14, .97)', '--bar': 'rgba(32, 21, 12, .84)',
      '--edge': 'rgba(232, 178, 86, .42)', '--edge-hi': 'rgba(255, 206, 112, .76)', '--edge-c': '#e8b256', '--quiet': 'rgba(255, 215, 145, .07)',
      '--bar-grad': 'linear-gradient(180deg, rgba(240, 185, 91, .18), rgba(34, 22, 12, .9) 75%)',
      '--win-glow': 'inset 0 1px 0 rgba(255, 228, 168, .35), 0 0 36px -10px rgba(255, 152, 56, .44)',
      '--ink': '#f8ecd6', '--ink2': '#d7c19e', '--ink3': '#aa906b',
      '--brass': '#f0b95b', '--brass-hi': '#ffe09c', '--brass-lo': '#8b6324',
      '--k-task': '#f2c35c', '--k-warn': '#ff6242', '--k-info': '#ffae5c', '--ether': '#ff8f40', '--work': '#ffd98a', '--ok': '#9be7a8',
      '--badge': '#f6e4b8', '--badge-ink': '#1d1205', '--member-sat': '1',
      // Unified Star Map 2.0 tokens
      '--starmap-bg': '#150e08', '--starmap-surface': '#21160d', '--starmap-surface-2': '#2d1e12',
      '--starmap-glass': 'rgba(34, 22, 12, .93)', '--starmap-glass-dim': 'rgba(26, 17, 10, .78)', '--starmap-blur': '12px',
      '--starmap-edge': 'rgba(232, 178, 86, .42)', '--starmap-edge-strong': 'rgba(255, 206, 112, .76)',
      '--starmap-ink': '#f8ecd6', '--starmap-ink2': '#d7c19e', '--starmap-ink3': '#aa906b', '--starmap-muted': '#b49972',
      '--starmap-accent': '#f0b95b', '--starmap-accent-hi': '#ffe09c', '--starmap-accent-soft': 'rgba(240, 185, 91, .2)', '--starmap-on-accent': '#1d1205',
      '--starmap-ether': '#ff8f40',
      '--starmap-bar-grad': 'linear-gradient(180deg, rgba(240, 185, 91, .18), rgba(34, 22, 12, .9) 75%)',
      '--starmap-win-head-grad': 'linear-gradient(180deg, rgba(240, 185, 91, .22), rgba(255, 143, 64, .06) 75%, transparent)',
      '--starmap-win-glow': 'inset 0 1px 0 rgba(255, 228, 168, .35), 0 0 36px -10px rgba(255, 152, 56, .44)',
      '--starmap-win-shadow': '0 24px 60px -18px rgba(10, 4, 0, .92)',
      '--starmap-radius': '5px', '--starmap-radius-sm': '4px',
      '--starmap-k-task': '#f2c35c', '--starmap-k-warn': '#ff6242', '--starmap-k-info': '#ffae5c',
    },
    bg: ['#11204a', '#0a1532', '#050a1a'],
    washes: [['255, 168, 72', 0.17, 0.5, 0.58, 0.55], ['60, 90, 170', 0.1, 0.15, 0.1, 0.8]],
    sun: { size: 1.25, edge: [0.86, 0.36, 0.08], mid: [1.0, 0.7, 0.28], core: [1.0, 0.95, 0.78], gain: 1.12, glowColor: '#ffcf86', glow: 3.4, glowOp: 0.85, haloColor: '#ff9a40', halo: 6.2, haloOp: 0.3, corona: 0.42 },
    light: { sky: '#8a7a6a', ground: '#140e08', hemi: 0.5, headColor: '#fff0dc', head: 1.35, sunColor: '#ffcf8a', sun: 13 },
    orbit: { color: '#e2c27e', on: 0.3, off: 0.15, hover: 0.68 },
    planet: { mute: 0, toward: '#808080', emissive: 0.22, glow: 0.35 },
    stars: { n: 4600, twinkle: 0.3, freq: 3.5, gain: 1.25, tint: [[1, 0.88, 0.72], [1, 0.95, 0.85], [0.95, 0.95, 1]] },
    nebulae: [['255,170,70', [-3000, 900, -3800], 4400, 0.5], ['230,80,160', [3600, -500, -2400], 3800, 0.4], ['255,120,60', [2600, 1500, 3400], 3200, 0.28], ['200,90,200', [-3800, -1000, 2600], 4000, 0.3]],
    nebula: 0.55,
    galaxy: { spiral: 6500, ell: 4200, hazeS: 220, hazeE: 120, haze: 1.6, op: 1.2, core: [1, 0.96, 0.84], edges: ['#f2c879', '#ffdcaa', '#e8a45c', '#cdbca4'] },
    ustar: { working: '#bef0ff', online: '#ffe6b8', offline: '#96969f' },
    speed: { orbit: 0.15, mini: 0.5, sat: 1, galaxy: 0.012 },
    work: { base: 0.2, amp: 0.2, ring: 0.9 },
    sat: { pulse: 0.85, pulseImp: 0.85, glow: 0.5, emissive: 0.8 },
    mini: { glow: 1 },
    bh: { n: 2300, inner: '#fff1c4', outer: '#e2641e', ring: '#ffc46e', glow: '#ff8a3a' },
  },
};

/** Snapshot sent to restricted third-party `position: 'starmap'` iframes in `orrery.init` / `orrery.theme`. */
export function starmapThemeSnapshot(name) {
  const id = Object.hasOwn(THEMES, name) ? name : 'luna';
  const c = THEMES[id].css;
  return {
    name: `starmap:${id}`,
    scheme: 'dark',
    starmap: { theme: id },
    colors: {
      bg: c['--starmap-bg'],
      surface: c['--starmap-surface'],
      'surface-2': c['--starmap-surface-2'],
      line: c['--starmap-edge'],
      text: c['--starmap-ink'],
      muted: c['--starmap-muted'],
      accent: c['--starmap-accent'],
      'accent-soft': c['--starmap-accent-soft'],
      'on-accent': c['--starmap-on-accent'],
      running: c['--work'],
      done: c['--ok'],
      failed: c['--starmap-k-warn'],
      'warn-bg': 'rgba(224, 134, 119, 0.16)',
      'warn-text': c['--starmap-k-warn'],
    },
  };
}

/** Theme object exposed to same-page `panel` plugins via `panelCtx.theme` and `panelCtx.onThemeChange`. */
export function starmapPanelTheme(name) {
  const id = Object.hasOwn(THEMES, name) ? name : 'luna';
  return Object.freeze({ id, scheme: 'dark', tokens: Object.freeze({ ...THEMES[id].css }) });
}

/** The stored theme, or luna when there is none, it is unknown or storage is blocked. */
export function readTheme(storage) {
  try {
    const name = storage?.getItem(THEME_KEY);
    if (name && Object.hasOwn(THEMES, name)) return name;
  } catch { /* storage blocked: the default */ }
  return 'luna';
}

export function saveTheme(storage, name) {
  try { storage?.setItem(THEME_KEY, name); } catch { /* storage blocked: the choice lasts this visit */ }
}

/**
 * One icon per theme, in that theme's own colours (they do not follow the current theme), as element specs
 * [tag, attributes, children?] on a 24-unit grid: a waning crescent with its dark side faintly showing, a small
 * cluster of four-pointed stars, a sun with rays. Static drawings: built with createElementNS, never parsed.
 */
export const THEME_ICON = {
  luna: [
    ['circle', { cx: 12, cy: 12, r: 8, fill: '#8fa6d6', opacity: '.22' }],
    ['path', { d: 'M12.38 4A8 8 0 1 0 18.62 16.49A7 7 0 0 1 12.38 4Z', fill: '#c5dcf8' }],
    ['circle', { cx: 8.2, cy: 13.6, r: 1.1, fill: '#8fb4e2', opacity: '.8' }],
  ],
  astra: [
    ['path', { d: 'M9 3.6Q9 10 15.4 10Q9 10 9 16.4Q9 10 2.6 10Q9 10 9 3.6Z', fill: '#7dd3fc' }],
    ['path', { d: 'M17.4 3Q17.4 6.4 20.8 6.4Q17.4 6.4 17.4 9.8Q17.4 6.4 14 6.4Q17.4 6.4 17.4 3Z', fill: '#b794f6' }],
    ['path', { d: 'M16.6 13.4Q16.6 16.4 19.6 16.4Q16.6 16.4 16.6 19.4Q16.6 16.4 13.6 16.4Q16.6 16.4 16.6 13.4Z', fill: '#a9c2ff' }],
    ['circle', { cx: 6, cy: 19.2, r: 1.3, fill: '#b794f6', opacity: '.85' }],
  ],
  sol: [
    ['g', { stroke: '#ff8f40', 'stroke-width': 1.8, 'stroke-linecap': 'round' }, [
      ['path', { d: 'M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3' }],
      ['path', { d: 'M4.8 4.8l2 2M17.2 17.2l2 2M19.2 4.8l-2 2M6.8 17.2l-2 2', opacity: '.75' }],
    ]],
    ['circle', { cx: 12, cy: 12, r: 5.4, fill: '#f0b95b' }],
    ['circle', { cx: 12, cy: 12, r: 3, fill: '#ffe09c', opacity: '.75' }],
  ],
};
