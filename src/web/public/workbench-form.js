import { fileUrl, h, icon, isImage, MAX_FILES, pastedFiles, pendingFileNode, pickFiles } from './ui.js';

/**
 * A modal form keeps its inputs across background workbench refreshes. `setBusy(true)` runs before `submit` reads
 * anything and `setBusy(false)` once the save has ended, for a field that must not change while a save is in flight.
 */
export function formDialog(title, fields, submit, setBusy = () => {}, saveText = '保存') {
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const save = h('button', { type: 'submit', class: 'primary' }, saveText);
  const cancel = h('button', { type: 'button', onclick: () => dialog.close() }, '取消');
  const form = h('form', { class: 'workbench-form' }, h('h2', {}, title), fields, error,
    h('div', { class: 'row end' }, cancel, save));
  const dialog = h('dialog', {}, form);
  dialog.addEventListener('cancel', (event) => { if (save.disabled) event.preventDefault(); });
  dialog.addEventListener('close', () => dialog.remove());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (save.disabled || !form.reportValidity()) return;
    save.disabled = true;
    cancel.disabled = true;
    error.hidden = true;
    setBusy(true);
    try { await submit(); dialog.close(); } catch (e) { error.textContent = e.message; error.hidden = false; }
    finally { save.disabled = false; cancel.disabled = false; setBusy(false); }
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

// ---- a task's attachments while its form is open (docs/collaboration.md) ----
// Entries: { key, name, size, state: 'uploading' | 'done' | 'error', id?, mime?, error? }. Each file is stored as soon
// as it is added; saving the form sends the stored ids.

export const savedFormFile = (file) => ({ key: file.id, id: file.id, name: file.name, size: file.size, mime: file.mime, state: 'done' });

/** Adds `incoming` ([{ name, size }]) up to the task limit; `key` numbers the new entries. */
export function addFormFiles(list, incoming, key) {
  const { accepted, errors } = pickFiles(list.length, incoming, '一个任务');
  const added = accepted.map((f, i) => ({ ...f, key: key + i, state: 'uploading' }));
  return { list: [...list, ...added], added, errors };
}

/** An upload's outcome: the stored file, or why it failed. An entry removed meanwhile stays removed. */
export const settleFormFile = (list, key, stored, error) => list.map((u) => {
  if (u.key !== key) return u;
  return stored ? { ...savedFormFile(stored), key } : { ...u, state: 'error', error };
});

export const removeFormFile = (list, key) => list.filter((u) => u.key !== key);

export const formFileIds = (list) => list.filter((u) => u.state === 'done').map((u) => u.id);

/** Why the form cannot be saved yet, or null. */
export function formFilesProblem(list) {
  if (list.some((u) => u.state === 'uploading')) return '还有文件在上传，等上传完再保存';
  return list.some((u) => u.state === 'error') ? '有文件上传失败，移除后再保存' : null;
}

/**
 * The attachment part of a task form. `upload(file, name)` stores one file; `paste` listens on the whole dialog;
 * `lock` freezes the list while a save is in flight, because the request carries the ids it read when it started.
 */
export function filesField(saved, upload) {
  let list = saved.map(savedFormFile);
  let nextKey = 1;
  let locked = false;
  const chips = h('ul', { class: 'pending-files', 'aria-label': '任务附件', hidden: !list.length });
  const notice = h('p', { class: 'form-error', role: 'alert', hidden: true });
  function change(next) {
    list = next;
    chips.hidden = !list.length;
    chips.replaceChildren(...list.map((u) => pendingFileNode(u, () => { if (!locked) change(removeFormFile(list, u.key)); },
      u.state === 'done' && isImage(u.mime) ? h('img', { class: 'wb-file-thumb', src: fileUrl(u.id), alt: '' }) : icon('file', 'ico-sm'), locked)));
  }
  function add(files) {
    if (locked) return;
    const named = files.map((file) => ({ file, name: file.as ?? file.name, size: file.size }));
    const result = addFormFiles(list, named, nextKey);
    nextKey += result.added.length;
    notice.textContent = result.errors.join('\n');
    notice.hidden = !result.errors.length;
    change(result.list);
    for (const u of result.added) {
      upload(u.file, u.name).then((stored) => change(settleFormFile(list, u.key, stored)),
        (e) => change(settleFormFile(list, u.key, null, e.message)));
    }
  }
  const input = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { add([...input.files]); input.value = ''; } });
  const pick = h('button', { type: 'button', class: 'small', onclick: () => input.click() }, '添加文件');
  change(list);
  return {
    el: h('div', { class: 'wb-files-field' }, h('div', { class: 'wb-files-head' }, h('span', {}, '附件'), pick,
      h('span', { class: 'muted' }, `可直接粘贴截图；最多 ${MAX_FILES} 个，每个不超过 20 MB`), input), chips, notice),
    ids: () => formFileIds(list),
    problem: () => formFilesProblem(list),
    lock: (busy) => { locked = busy; pick.disabled = busy; input.disabled = busy; change(list); },
    paste: (event) => {
      const files = pastedFiles(event.clipboardData, new Date());
      if (files) { event.preventDefault(); add(files); }
    },
  };
}
