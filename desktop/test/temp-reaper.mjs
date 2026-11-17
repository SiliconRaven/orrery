// node temp-reaper.mjs <pid> <dir> <prefix>: started hidden and detached by temp-dir.mjs. Waits for <pid> to exit
// (at most 3 hours), then deletes <dir> through removeCheckTempDir's guard, retrying for a minute while the exited
// processes' files are released. Best effort: it never reports anything.
import { setTimeout as sleep } from 'node:timers/promises';
import { removeCheckTempDir } from './temp-dir.mjs';

const [pidArg, dir, prefix] = process.argv.slice(2);
const pid = Number(pidArg);
const alive = () => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};

if (Number.isInteger(pid) && pid > 0 && dir && prefix) {
  for (const end = Date.now() + 3 * 60 * 60 * 1000; alive() && Date.now() < end;) await sleep(500);
  if (!alive()) {
    for (let i = 0; i < 60; i++) {
      try { removeCheckTempDir(dir, prefix); break; } catch { await sleep(1000); }
    }
  }
}
