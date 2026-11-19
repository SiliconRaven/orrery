import { t } from './i18n.js';
import { h } from './ui.js';

const statusText = {
  idle: () => t('尚未检查更新。'),
  checking: () => t('正在检查更新…'),
  current: () => t('当前已是最新版本。'),
  available: () => t('有新版本可用。'),
  'no-release': () => t('此通道尚无可用发行版本。'),
  error: () => t('检查更新未完成。'),
};
const errorText = {
  'not-found': () => t('未找到公开发行信息，请稍后再试。'),
  'rate-limited': () => t('GitHub 请求已达上限，请稍后再试。'),
  timeout: () => t('检查更新超时，请稍后再试。'),
  network: () => t('无法连接 GitHub，请检查网络后重试。'),
  'invalid-response': () => t('收到的发行信息无效，请稍后再试。'),
};

/** Reads cached status once a minute. Only an explicit button click requests a new remote check. */
export function mountUpdates(container, { api, onState = () => {} }) {
  let state = null;
  let disposed = false;
  let busy = false;
  let failed = false;
  const version = h('p', { class: 'limit-source' });
  const channel = h('p', { class: 'limit-source muted' });
  const status = h('p', { role: 'status', 'aria-live': 'polite', style: 'justify-self:start;white-space:normal' });
  const latest = h('p', { class: 'limit-source' });
  const checked = h('p', { class: 'limit-source muted' });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const auto = h('input', { type: 'checkbox', role: 'switch', 'aria-label': t('自动检查更新'),
    onchange: () => request('PATCH', '/api/updates', { autoCheck: auto.checked }) });
  const check = h('button', { type: 'button', style: 'min-height:44px', onclick: () => request('POST', '/api/updates/check') }, t('立即检查'));
  const link = h('input', { type: 'text', readonly: true, 'aria-label': t('发行页面地址'),
    style: 'width:100%;min-width:0;box-sizing:border-box' });
  const copyHint = h('p', { class: 'limit-source muted', role: 'status', 'aria-live': 'polite' });
  const copy = h('button', { type: 'button', style: 'min-height:44px', onclick: copyLink }, t('复制发行页链接'));
  const release = h('div', { class: 'plugin-group', hidden: true }, h('label', {}, t('发行页面'), link),
    h('div', {}, copy), copyHint);
  container.replaceChildren(h('section', { class: 'settings-card plugin-group', 'aria-label': t('软件更新') },
    h('div', { class: 'plugin-group-head' }, h('h4', {}, t('软件更新')),
      h('p', { class: 'muted' }, t('只检查新版本，不会自动下载或安装。'))),
    version, channel, status, latest, checked,
    h('label', { class: 'plugin-switch', style: 'min-height:44px' }, auto, t('自动检查更新')),
    h('div', {}, check), error, release));

  function draw() {
    version.textContent = state ? t('当前版本：{version}', { version: state.currentVersion }) : t('正在读取版本信息…');
    channel.textContent = state ? (state.channel === 'beta' ? t('更新通道：测试版') : t('更新通道：正式版')) : '';
    status.textContent = state ? statusText[state.status]() : t('尚未取得更新状态。');
    status.className = `plugin-chip ${state?.status === 'available' ? 'on' : state?.status === 'error' ? 'bad' : 'off'}`;
    latest.textContent = state?.latestVersion ? t('最新可用版本：{version}', { version: state.latestVersion }) : '';
    latest.hidden = !state?.latestVersion;
    checked.textContent = state?.checkedAt == null ? t('尚未成功检查。')
      : t('上次成功检查：{time}', { time: new Date(state.checkedAt).toLocaleString() });
    auto.checked = state?.autoCheck ?? false;
    auto.disabled = busy || !state;
    check.disabled = busy || state?.status === 'checking';
    check.textContent = state?.status === 'checking' ? t('正在检查更新…') : t('立即检查');
    error.hidden = !failed && state?.status !== 'error';
    error.textContent = failed ? t('无法读取更新状态，请重试。')
      : state?.status === 'error' ? (errorText[state.error]?.() ?? t('检查暂时失败，请稍后重试。')) : '';
    release.hidden = !state?.releaseUrl;
    const url = state?.releaseUrl ?? '';
    if (link.value !== url) { link.value = url; copyHint.textContent = ''; }
  }

  async function request(method, path, body) {
    if (disposed || busy) return;
    busy = true;
    failed = false;
    draw();
    try {
      const result = await api(method, path, body);
      if (!disposed) { state = result; onState(result); }
    } catch {
      if (!disposed) failed = true;
    } finally {
      busy = false;
      if (!disposed) draw();
    }
  }

  async function copyLink() {
    if (disposed || !link.value) return;
    const url = link.value;
    try {
      await navigator.clipboard.writeText(url);
      if (!disposed && link.value === url) copyHint.textContent = t('链接已复制。');
    } catch {
      if (disposed || link.value !== url) return;
      link.focus();
      link.select();
      copyHint.textContent = t('无法自动复制，请按 Ctrl+C 复制选中的链接。');
    }
  }

  void request('GET', '/api/updates');
  const timer = setInterval(() => { void request('GET', '/api/updates'); }, 60_000);
  return () => { disposed = true; clearInterval(timer); };
}
