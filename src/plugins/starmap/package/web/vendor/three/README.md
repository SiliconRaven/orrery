# three.js 0.170.0（星图用）

只给星图官方插件用，打开星图时才按需加载（`docs/starmap.md` 默认决定 B）。来源：npm 官方源的 `three@0.170.0`（`npm pack`，2026-11-19），许可证 MIT（见同目录 `LICENSE`）。

| 文件 | 来自包里的 | 改动 |
|---|---|---|
| `three.module.min.js` | `build/three.module.min.js` | 无（sha256 `08fd7545d13d2c7fb65ab691530a802dafefd638596501854f267d0fb13c39e7`） |
| `addons/OrbitControls.js` | `examples/jsm/controls/OrbitControls.js` | 第 12 行 `from 'three'` 改成 `from '../three.module.min.js'`（原文件 sha256 `80efaadea4f8a636a65fb0bd08bfef62f3d93a0bb94e2e7500f23176c5c07f4e`），不给整页加 importmap |
| `LICENSE` | `LICENSE` | 无 |

升级版本是一次改动：换文件、重新核对上面的改动和散列、更新 `docs/architecture.md` 的外部依赖版本表，`test/boundaries.test.ts` 锁着这个目录的文件清单。
