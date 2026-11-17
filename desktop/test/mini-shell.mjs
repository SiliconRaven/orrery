// The shell's window logic without its Electron windows, for the Win32 check (test F): the same reducer, writer and
// runOps wiring as shell.mjs, with `rect` standing in for the dock area. Plus `recording`, an interceptor that logs
// every Win32 write (target, arguments, how long it blocked).
import { afterOps, initialState, liveIn, runOps, step } from '../lib/dock.mjs';
import { listCandidates } from '../lib/windows.mjs';
import { createWriter } from '../lib/writer.mjs';

const WRITES = ['setWindowPos', 'showWindow', 'setWindowPlacement', 'setForegroundWindow'];

export function recording(ffi) {
  const calls = [];
  const wrapped = { ...ffi };
  for (const name of WRITES) {
    wrapped[name] = (...args) => {
      const t = performance.now();
      const result = ffi[name](...args);
      calls.push({ fn: name, hwnd: args[0], args: args.slice(1), ms: Math.round(performance.now() - t), result, tag: wrapped.tag });
      return result;
    };
  }
  wrapped.tag = null;
  return { ffi: wrapped, calls };
}

export function miniShell(ffi, { apps, rect, focused = false }) {
  const writer = createWriter(ffi, { apps });
  let state = initialState();
  const shell = {
    rect,
    focused,
    writer,
    notices: [],
    failures: [],
    get state() { return state; },
    dispatch(event) {
      const env = { rect: shell.rect, focused: shell.focused, capture: (c) => writer.capture(c) };
      ffi.tag = event.type;
      const r = step(state, event, env, apps);
      state = r.state;
      const out = runOps(r.ops, (o) => writer.write(o), liveIn(state));
      const after = afterOps(state, out, env, apps);
      state = after.state;
      shell.notices.push(...after.notices.map((n) => n.text));
      shell.notices.push(...r.notices.map((n) => n.text));
      shell.failures.push(...out.failures);
      ffi.tag = null;
      return out;
    },
    candidates(keep) {
      const exclude = state.tabs.flatMap((t) => (t.binding ? [t.binding.hwnd] : []));
      return listCandidates(ffi, { apps, exclude }).filter(keep);
    },
  };
  return shell;
}
