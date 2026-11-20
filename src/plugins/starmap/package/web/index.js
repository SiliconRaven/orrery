// The star map (docs/starmap.md): a full-page view (docs/plugins.md「官方网页插槽」) showing the groups, clusters and
// members as a sky. Nothing heavy loads with the page: three.js (vendored in this package, docs/starmap.md default B),
// the scene and the chat windows are imported when the view opens, and everything they hold is released when it closes.
// This is the official package's web entry; the page shares its helpers through /plugin-host/v1.js and its English
// through host.i18n (docs/official-plugin-updates.md「网页资源与翻译」).
import { emptyState } from '/plugin-host/v1.js';
import { t, useWords } from './words.js';

export function register(host) {
  useWords(host.i18n);
  /** The opening in progress or shown: { stop: AbortController, scene: { dispose } | null }. */
  let session = null;

  async function mount(el, ctx) {
    const mine = { stop: new AbortController(), scene: null };
    session = mine;
    const failed = (error) => {
      if (session !== mine) return;
      console.warn('star map did not open', error);
      el.replaceChildren(emptyState(t('星图没能打开：{message}', { message: error?.message ?? String(error) })));
    };
    let modules;
    try {
      modules = await Promise.all([
        import('./vendor/three/three.module.min.js'),
        import('./vendor/three/addons/OrbitControls.js'),
        import('./scene.js'),
        // The chat windows; without them the star and the planets open the chat page instead (ctx.openChat).
        import('./windows.js').catch(() => null),
      ]);
    } catch (error) { return failed(error); }
    if (session !== mine) return;
    const [THREE, { OrbitControls }, { createScene }, windowsModule] = modules;
    try {
      const scene = await createScene({ THREE, OrbitControls, el, ctx, windowsModule, signal: mine.stop.signal });
      if (session === mine) mine.scene = scene;
      else scene.dispose();
    } catch (error) { failed(error); }
  }

  return {
    view: {
      id: 'starmap',
      title: () => t('星图'),
      icon: 'orbit',
      fullscreen: true,
      mount,
      unmount() {
        const closing = session;
        session = null;
        if (!closing) return;
        closing.stop.abort();
        closing.scene?.dispose();
      },
    },
  };
}
