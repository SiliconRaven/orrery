// The star map's three themes (docs/starmap.md「主题」): every number and colour that sets the look, one complete table per
// theme, copied from mockups/orrery-theme-3d.html (`const THEMES = {`). Nothing else changes between themes.
//   暗月 Luna  · deep-blue night, a warm-white star, blue-grey glass; the quietest (default)
//   群星 Astra · deep indigo with violet and teal veils, a blue-white star; medium motion
//   炽阳 Sol   · deep blue warmed around a big orange-gold sun with a corona, brass and amber; the liveliest
// prefers-reduced-motion still wins over any theme (no orbit, no twinkle, no breathing). `label`, `sub` and `note` are
// msgids (i18n/en.json), translated where they are shown; `en` is a name and stays as it is.

export const THEME_KEY = 'orrery.starmapTheme';
export const THEME_ORDER = ['luna', 'astra', 'sol'];

export const THEMES = {
  luna: {
    label: '暗月', en: 'Luna', sub: '深蓝夜空', note: '月之暗面。群星噤声，轨道沉入深蓝，宜守望漫长的夜。（默认）',
    css: {
      '--bg-solid': '#070c1a', '--surface': 'rgba(11, 16, 30, .9)', '--panel': 'rgba(13, 19, 35, .97)', '--bar': 'rgba(9, 14, 28, .64)',
      '--edge': 'rgba(150, 168, 205, .16)', '--edge-hi': 'rgba(196, 208, 232, .34)', '--edge-c': '#96a8cd', '--quiet': 'rgba(255, 255, 255, .035)',
      '--bar-grad': 'none', '--win-glow': '0 0 0 0 transparent',
      '--ink': '#d6dae2', '--ink2': '#a3abba', '--ink3': '#7f8899',
      '--brass': '#c9b48a', '--brass-hi': '#ddcba5', '--brass-lo': '#7d7058',
      '--k-task': '#c9ad6e', '--k-warn': '#d98a76', '--k-info': '#8db5c0', '--ether': '#93a2c9', '--work': '#9fd4dc', '--ok': '#8fb79a',
      '--badge': '#c9ced8', '--badge-ink': '#0c0f16', '--member-sat': '0.7',
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
      '--bg-solid': '#0c0920', '--surface': 'rgba(24, 17, 46, .88)', '--panel': 'rgba(27, 20, 52, .97)', '--bar': 'rgba(22, 16, 44, .68)',
      '--edge': 'rgba(164, 140, 236, .24)', '--edge-hi': 'rgba(120, 232, 232, .55)', '--edge-c': '#a48cec', '--quiet': 'rgba(190, 170, 255, .055)',
      '--bar-grad': 'linear-gradient(180deg, rgba(150, 120, 240, .1), rgba(150, 120, 240, 0))', '--win-glow': '0 0 26px -6px rgba(110, 232, 232, .38)',
      '--ink': '#e6e1f4', '--ink2': '#b3abcf', '--ink3': '#8d87ab',
      '--brass': '#78e0e4', '--brass-hi': '#b5f3f2', '--brass-lo': '#3f7e86',
      '--k-task': '#e2bb6c', '--k-warn': '#ff6f8e', '--k-info': '#7ec8ff', '--ether': '#b79cff', '--work': '#7ff0dc', '--ok': '#8fe0bb',
      '--badge': '#d9cfff', '--badge-ink': '#140d2c', '--member-sat': '0.8',
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
      '--bg-solid': '#070c1e', '--surface': 'rgba(32, 22, 14, .88)', '--panel': 'rgba(36, 25, 16, .97)', '--bar': 'rgba(30, 21, 13, .7)',
      '--edge': 'rgba(201, 164, 92, .36)', '--edge-hi': 'rgba(240, 202, 124, .62)', '--edge-c': '#c9a45c', '--quiet': 'rgba(255, 220, 160, .055)',
      '--bar-grad': 'linear-gradient(180deg, rgba(232, 172, 92, .14), rgba(232, 172, 92, .02))', '--win-glow': '0 0 32px -10px rgba(255, 188, 90, .32)',
      '--ink': '#f0e6d0', '--ink2': '#c6b799', '--ink3': '#9d8e72',
      '--brass': '#e2a84e', '--brass-hi': '#f7d38a', '--brass-lo': '#7a5f2e',
      '--k-task': '#f2c35c', '--k-warn': '#ff5f45', '--k-info': '#7fd2ea', '--ether': '#9fb0ff', '--work': '#8ff0ff', '--ok': '#9be7a8',
      '--badge': '#f6e4b8', '--badge-ink': '#1e1407', '--member-sat': '1',
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
    ['path', { d: 'M12.38 4A8 8 0 1 0 18.62 16.49A7 7 0 0 1 12.38 4Z', fill: '#f3e4c6' }],
    ['circle', { cx: 8.2, cy: 13.6, r: 1.1, fill: '#d9c9a8', opacity: '.7' }],
  ],
  astra: [
    ['path', { d: 'M9 3.6Q9 10 15.4 10Q9 10 9 16.4Q9 10 2.6 10Q9 10 9 3.6Z', fill: '#8fe9ee' }],
    ['path', { d: 'M17.4 3Q17.4 6.4 20.8 6.4Q17.4 6.4 17.4 9.8Q17.4 6.4 14 6.4Q17.4 6.4 17.4 3Z', fill: '#b9a0ff' }],
    ['path', { d: 'M16.6 13.4Q16.6 16.4 19.6 16.4Q16.6 16.4 16.6 19.4Q16.6 16.4 13.6 16.4Q16.6 16.4 16.6 13.4Z', fill: '#a9c2ff' }],
    ['circle', { cx: 6, cy: 19.2, r: 1.3, fill: '#b9a0ff', opacity: '.85' }],
  ],
  sol: [
    ['g', { stroke: '#ff9a3c', 'stroke-width': 1.8, 'stroke-linecap': 'round' }, [
      ['path', { d: 'M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3' }],
      ['path', { d: 'M4.8 4.8l2 2M17.2 17.2l2 2M19.2 4.8l-2 2M6.8 17.2l-2 2', opacity: '.75' }],
    ]],
    ['circle', { cx: 12, cy: 12, r: 5.4, fill: '#ffc45a' }],
    ['circle', { cx: 12, cy: 12, r: 3, fill: '#ffe2a0', opacity: '.7' }],
  ],
};
