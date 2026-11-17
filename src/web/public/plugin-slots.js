// Browser entries are local assets named by the Hub's enabled first-party registry.
function protect(label, callback) {
  const warn = (error) => { console.warn(`plugin UI failed in ${label}`, error); };
  return function (...args) {
    try {
      const result = callback.apply(this, args);
      return result instanceof Promise ? result.catch(warn) : result;
    } catch (error) {
      warn(error);
    }
  };
}

function protectMethods(label, owner, methods) {
  const hooks = { ...owner };
  for (const name of methods) {
    if (typeof owner[name] === 'function') hooks[name] = protect(`${label}.${name}`, owner[name].bind(owner));
  }
  return hooks;
}

export async function loadPluginSlots(result, host, load = (id) => import(`./official-plugins/${id}.js`)) {
  const slots = { message: [], composer: [], workbench: [], settings: [] };
  const running = new Set(result?.plugins.map((plugin) => plugin.id));
  for (const id of new Set(result?.frontend)) {
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id) || !running.has(id)) continue;
    try {
      const { register } = await load(id);
      const hooks = register(host);
      if (hooks.message) slots.message.push(protectMethods(`${id}.message`, hooks.message, ['render', 'key', 'capture', 'restore', 'update']));
      for (const name of ['composer', 'settings']) {
        if (hooks[name]) slots[name].push(protect(`${id}.${name}`, hooks[name]));
      }
      const createTab = hooks.workbench;
      if (createTab) slots.workbench.push(protect(`${id}.workbench`, function (...args) {
        const tab = createTab.apply(this, args);
        return tab && protectMethods(`${id}.workbench`, tab, ['render', 'load', 'reset', 'itemRow']);
      }));
    } catch (error) {
      console.warn(`plugin UI failed to load: ${id}`, error);
    }
  }
  return slots;
}
