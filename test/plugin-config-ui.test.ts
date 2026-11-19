// Exercise the shared dialog with a controllable user API. The browser fixture covers the real card and group-menu entry points.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

class Element {
  readonly tag: string;
  constructor(tag: string) { this.tag = tag; }
  attrs: Record<string, string> = {};
  children: (Element | string)[] = [];
  events: Record<string, (event: any) => void> = {};
  parent?: Element;
  open = false; hidden = false; checked = false; disabled = false;
  private input?: string;
  classList = { toggle: () => {} };
  get id() { return this.attrs.id; }
  get type() { return this.attrs.type; }
  get value(): string {
    if (this.input !== undefined) return this.input;
    if (this.tag === 'select') {
      const choices = this.children.filter((v): v is Element => v instanceof Element);
      return (choices.find((e) => 'selected' in e.attrs) ?? choices[0])?.attrs.value ?? '';
    }
    return this.tag === 'textarea' ? this.textContent : this.attrs.value ?? '';
  }
  set value(v: string) { this.input = v; }
  get textContent(): string { return this.children.map((v) => typeof v === 'string' ? v : v.textContent).join(''); }
  set textContent(v: string) { this.children = [v]; }
  setAttribute(key: string, v: unknown) {
    this.attrs[key] = String(v);
    if (key === 'checked' || key === 'hidden' || key === 'disabled') this[key] = true;
  }
  append(...children: (Element | string)[]) {
    for (const item of children) { if (item instanceof Element) item.parent = this; this.children.push(item); }
  }
  replaceChildren(...children: (Element | string)[]) { this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  addEventListener(name: string, fn: (e: any) => void) { this.events[name] = fn; }
  fire(type: string) { this.events[type]?.({ target: this, currentTarget: this, preventDefault() {} }); }
  showModal() { this.open = true; } close() { this.open = false; this.fire('close'); }
  focus() {}
  find(test: (e: Element) => boolean): Element | undefined {
    if (test(this)) return this;
    for (const child of this.children) { const found = child instanceof Element && child.find(test); if (found) return found; }
  }
  querySelector(query: string) {
    const match = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(query);
    return match && this.find((e) => match[1] in e.attrs && (match[2] === undefined || e.attrs[match[1]] === match[2]));
  }
}

const make = (tag: string) => new Element(tag);
const body = make('body');
(globalThis as any).document = { body, createElement: make, createElementNS: (_ns: string, name: string) => make(name) };
const { createPluginConfig } = await import(new URL('../src/web/public/plugin-config.js', import.meta.url).href);
const find = (test: (e: Element) => boolean) => { const e = body.find(test); assert.ok(e); return e; };
const field = (name: string) => find((e) => e.attrs.name === name);
const error = (name: string) => find((e) => e.attrs['data-config-error'] === name);
const byAttr = (k: string, v = '') => find((e) => e.attrs[k] === v);
const edit = (name: string, v: string) => { const e = field(name); e.value = v; e.fire('input'); };
const save = () => find((e) => e.tag === 'form').fire('submit');
const declaration = (name: string, type: string, extra = {}) => ({ name, label: name, type, ...extra });
const config = (clusterId: string | null = null, extra = {}) => ({
  pluginId: 'demo', pluginName: '示例', clusterId, revision: 0, scopes: ['global','cluster'], errors: {},
  clusters: [{ id: 'one', name: '一群' }], members: [{ id: 'm1', name: '甲', clusterId: 'one' }],
  fields: clusterId ? [declaration('sections','list')] : [declaration('title','text'), declaration('directory','path'),
    declaration('n','number'), declaration('delay','duration'), declaration('format','enum',{options:['md','plain']}),
    declaration('owner','member'), declaration('flag','boolean'), declaration('date','boolean',{default:true})],
  values: clusterId ? { sections:['A','A'] } : { title:'one\ntwo', n:1, delay:900, format:'md', date:true },
  defaults: clusterId ? {} : { date:true },
  overriddenFields: clusterId ? ['sections'] : ['title','n','delay','format'],
  ...extra,
});

test('fields round-trip multiline text, absolute-path text, numeric zero, seconds, selections, optional booleans and an ordered list', async () => {
  body.replaceChildren();
  const sent: any[] = [];
  const api = async (method: string, url: string, payload: any) => {
    if (method === 'PUT') sent.push([url, payload]);
    return config(url.includes('clusterId=one') ? 'one' : null);
  };
  const dialog = createPluginConfig(api);
  await dialog.openPlugin({id:'demo'}, null);
  assert.equal(field('title').value,'one\ntwo');
  assert.equal(field('delay').value,'15m');
  assert.equal(field('flag').value,'');
  edit('directory','C:\\Reports'); edit('n','0'); edit('delay','1h30m'); edit('format','plain'); edit('owner','m1'); edit('flag','false');
  field('date').checked = false; field('date').fire('change');
  save(); await setImmediate();
  assert.deepEqual(sent[0], ['/api/plugins/demo/config', { revision:0, values:{
    title:'one\ntwo', directory:'C:\\Reports', n:0, delay:5400, format:'plain', owner:'m1', flag:false, date:false,
  }}]);
  edit('delay','1h30'); save(); await setImmediate();
  assert.equal(sent.length,1); assert.equal(error('delay').hidden,false);
  byAttr('data-config-scope','cluster').fire('click'); await setImmediate();
  assert.equal(field('sections').value,'A\nA');
  edit('sections','first\nsecond\nfirst\n'); save(); await setImmediate();
  assert.deepEqual(sent[1], ['/api/plugins/demo/config?clusterId=one',{revision:0,values:{sections:['first','second','first']}}]);
});

test('field resets preview the effective fallback, survive scope changes and omit only the reset overrides', async () => {
  body.replaceChildren();
  let posted: any;
  const remote = config(null, {
    defaults: { date: true },
    overriddenFields: ['title', 'date', 'owner'],
    values: { title: 'keep me', date: false, owner: 'm1' },
  });
  const api = async (method: string, url: string, payload: any) => {
    if (method === 'PUT') posted = payload;
    return url.includes('clusterId=one') ? config('one') : remote;
  };
  const dialog = createPluginConfig(api);
  await dialog.openPlugin({ id: 'demo' }, null);
  const source = (name: string) => byAttr('data-config-source', name).textContent;
  const reset = (name: string) => byAttr('data-config-reset', name).fire('click');
  assert.equal(source('date'), '已保存自定义');
  assert.equal(source('format'), '未设置');
  reset('date'); reset('owner');
  assert.equal(field('date').checked, true);
  assert.equal(field('owner').value, '');
  assert.equal(source('date'), '清单默认 · 待保存');
  assert.equal(source('owner'), '未设置 · 待保存');
  assert.equal(posted, undefined);
  byAttr('data-config-scope', 'cluster').fire('click'); await setImmediate();
  byAttr('data-config-scope', 'global').fire('click'); await setImmediate();
  assert.equal(source('date'), '清单默认 · 待保存');
  assert.equal(source('owner'), '未设置 · 待保存');
  save(); await setImmediate();
  assert.deepEqual(posted, { revision: 0, values: { title: 'keep me' } });
});

test('an older Hub response can be edited without dropping untouched values or guessing their sources', async () => {
  body.replaceChildren();
  const { defaults, overriddenFields, ...legacy } = config();
  let posted: unknown;
  const dialog = createPluginConfig(async (method: string, _url: string, payload: unknown) => {
    if (method === 'PUT') posted = payload;
    return legacy;
  });
  await dialog.openPlugin({ id: 'demo' }, null);
  assert.equal(field('title').value, 'one\ntwo');
  assert.equal(body.find((e) => 'data-config-source' in e.attrs || 'data-config-reset' in e.attrs), undefined);
  edit('title', 'changed');
  save(); await setImmediate();
  assert.deepEqual(posted, { revision: legacy.revision, values: { ...legacy.values, title: 'changed' } });
});

test('matching notifications refresh field feedback, preserve drafts, and surface conflicts without advancing the original revision', async () => {
  body.replaceChildren();
  let remote = config(), requests = 0;
  const api = async () => { requests++; return remote; };
  const dialog = createPluginConfig(api);
  await dialog.openPlugin({id:'demo'}, null);
  edit('title','draft');
  dialog.changed({pluginId:'other',clusterId:null,revision:0}); dialog.changed({pluginId:'demo',clusterId:'other',revision:0});
  assert.equal(requests,1);
  remote = config(null,{errors:{title:'old saved title',directory:'choose a folder'}});
  dialog.changed({pluginId:'demo',clusterId:null,revision:0}); await setImmediate();
  assert.equal(field('title').value,'draft');
  assert.equal(error('title').hidden,true); assert.equal(error('directory').textContent,'choose a folder');
  remote = config(null,{revision:1,values:{title:'saved elsewhere'}});
  dialog.changed({pluginId:'demo',clusterId:null,revision:1}); await setImmediate();
  assert.equal(field('title').value,'draft'); assert.equal(byAttr('type','submit').disabled,true);
  find((e) => e.tag === 'button' && e.textContent === '重新载入').fire('click'); await setImmediate();
  assert.equal(field('title').value,'saved elsewhere'); assert.equal(byAttr('type','submit').disabled,false);
});

test('a report received while saving is fetched after the PUT, and the group entry chooses the requested cluster', async () => {
  body.replaceChildren();
  let finish!: (value: object) => void, posted: any;
  const calls: string[] = [];
  let remote = config('one');
  const api = async (method: string, url: string, payload: any) => {
    calls.push(url);
    if (url.endsWith('/plugin-configs')) return {plugins:[{id:'demo',name:'示例'}]};
    if (method === 'PUT') { posted = payload; return new Promise((resolve) => {finish=resolve;}); }
    return remote;
  };
  const dialog = createPluginConfig(api);
  await dialog.openCluster('one',null);
  assert.equal(byAttr('data-config-cluster').value,'one');
  assert.deepEqual(calls, ['/api/clusters/one/plugin-configs','/api/plugins/demo/config?clusterId=one']);
  edit('sections','两条\n两条'); save();
  assert.deepEqual(posted,{revision:0,values:{sections:['两条','两条']}});
  dialog.changed({pluginId:'demo',clusterId:'one',revision:1});
  remote=config('one',{revision:1,errors:{sections:'重复栏目'},values:posted.values});
  finish({...remote,errors:{}}); await setImmediate();
  assert.equal(error('sections').textContent,'重复栏目');
  assert.equal(field('sections').attrs['aria-invalid'],'true');
  assert.equal(byAttr('type','submit').disabled,false);
});

test('a late read for a replaced dialog cannot change the new plugin scope', async () => {
  body.replaceChildren();
  let finish!: (value: object) => void;
  const api=async (_method: string, url: string) => url.startsWith('/api/clusters/') ? new Promise((resolve) => {finish=resolve;}) : config();
  const dialog=createPluginConfig(api);
  const previous=dialog.openCluster('one',null);
  await dialog.openPlugin({id:'demo'},null);
  finish({plugins:[]}); await previous;
  assert.equal(field('title').value,'one\ntwo');
  assert.equal(body.find((e) => e.textContent === '这个群没有可配置的插件。'),undefined);
});

test('returning to cluster configuration keeps the last selected authorized group of this plugin', async () => {
  body.replaceChildren();
  let clusters = [{ id: 'one', name: '一群' }, { id: 'two', name: '二群' }];
  const api = async (_method: string, url: string) => {
    if (url.endsWith('/plugin-configs')) return { plugins: [{ id: 'demo', name: '示例' }] };
    const group = new URL(url, 'http://localhost').searchParams.get('clusterId');
    assert.ok(group === null || clusters.some((item) => item.id === group));
    return config(group, { clusters });
  };
  const dialog = createPluginConfig(api);
  const switchScope = async (scope: string) => { byAttr('data-config-scope', scope).fire('click'); await setImmediate(); };
  await dialog.openCluster('two', null);
  await switchScope('global'); await switchScope('cluster');
  assert.equal(byAttr('data-config-cluster').value, 'two', 'back to the entry group');
  const select = byAttr('data-config-cluster');
  select.value = 'one'; select.fire('change'); await setImmediate();
  await switchScope('global'); await switchScope('cluster');
  assert.equal(byAttr('data-config-cluster').value, 'one', 'back to the selection made in this dialog');
  clusters = clusters.filter((group) => group.id === 'two');
  await switchScope('global'); await switchScope('cluster');
  assert.equal(byAttr('data-config-cluster').value, 'two', 'use the first remaining authorized group');
});
