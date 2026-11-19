// Commands the user runs from a cluster's composer ("/"): argument checks and the in-memory runs of long commands.
// Nothing here writes a message, a delivery or an event to the Hub's log; the only reader of a run is the user's page.
import { randomUUID } from 'node:crypto';
import { checkArgument, invalidArgument, missingArgument } from './command-args.js';
import type { ExternalCommand } from './external-plugin-config.ts';

export { parseDuration } from './command-args.js';

/** A refused run or cancel: a stable `code` (HTTP answers carry it), a sentence for the page, and the argument at fault. */
export class CommandRefusal extends Error {
  readonly code: string;
  readonly field: string | null;
  constructor(code: string, message: string, field: string | null = null) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

/**
 * The limits of user-run commands. `runMs`: a run that never reports `command.done` ends as failed after this (30
 * minutes: long enough for a timed session or a slow check, short enough that a forgotten run does not sit in the header
 * all day). `cancelGraceMs`: how long a cancelled run waits for the plugin's own `command.done` before Hub stops waiting.
 * `maxRunsPerPlugin`: runs of one plugin at once (starting, running or cancelling). `progressIntervalMs`: the page is
 * told about progress at most this often per run; the newest text wins, nothing older is replayed.
 */
export interface CommandLimits { runMs: number; cancelGraceMs: number; maxRunsPerPlugin: number; progressIntervalMs: number }
export const COMMAND_LIMITS: Readonly<CommandLimits> = { runMs: 30 * 60_000, cancelGraceMs: 10_000, maxRunsPerPlugin: 4, progressIntervalMs: 500 };
const MAX_PROGRESS_TEXT = 200;
const MAX_RESULT_TEXT = 2000;
const MAX_RESULT_DATA = 16 * 1024;

/**
 * The arguments a command is invoked with: only declared names, each checked against its type and bounds (`members`:
 * the ids of the cluster's current members) by the rules the page shares (command-args.js). A missing or null optional
 * one takes its default or is left out; a blank required text counts as missing. Names are read as own properties
 * only (a param may be called `constructor` or `toString`) and the result is built fresh with Object.fromEntries.
 * Refusals: UNKNOWN_ARGUMENT, MISSING_ARGUMENT, INVALID_ARGUMENT (with the field).
 */
export function validateArguments(command: ExternalCommand, raw: unknown, members: ReadonlySet<string>): Record<string, unknown> {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new CommandRefusal('INVALID_ARGUMENT', '参数须是一个 JSON 对象。');
  const input = raw as Record<string, unknown>;
  const params = command.params ?? [];
  const unknown = Object.keys(input).find((key) => !params.some((p) => p.name === key));
  if (unknown !== undefined) throw new CommandRefusal('UNKNOWN_ARGUMENT', `这个命令没有参数「${unknown}」。`, unknown);
  const values: [string, unknown][] = [];
  for (const param of params) {
    const given = Object.hasOwn(input, param.name) ? input[param.name] : undefined;
    const blank = given === undefined || given === null || (param.type === 'text' && typeof given === 'string' && !given.trim() && param.required);
    if (blank) {
      if (param.default !== undefined) values.push([param.name, param.default]);
      else if (param.required) throw new CommandRefusal('MISSING_ARGUMENT', missingArgument(param), param.name);
      continue;
    }
    const value = checkArgument(param, given, members);
    if (value === undefined) throw new CommandRefusal('INVALID_ARGUMENT', invalidArgument(param), param.name);
    values.push([param.name, value]);
  }
  return Object.fromEntries(values);
}

/** Text a plugin sends for the page: no control or format characters, at most `max` UTF-16 units; one line unless `lines`. */
export function cleanText(value: string, max: number, lines = false): string {
  const cleaned = lines
    ? value.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}](?<!\n)/gu, '')
    : value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ');
  return cleaned.trim().slice(0, max).toWellFormed().trim();
}

/**
 * starting: invoke sent, its answer not yet in (at most the plugin call timeout). running: answered `{accepted:true}`,
 * waiting for command.done. cancelling: the user cancelled and the plugin was sent command.cancel; it has
 * cancelGraceMs to send command.done. The other three are final: the run is reported once more, then forgotten.
 */
export type RunState = 'starting' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
/**
 * Why a run ended as it did. plugin: its own command.done (or, cancelling, its confirmation). plugin_error: the invoke
 * was answered with an error. timeout: runMs passed. plugin_stopped: the plugin stopped or failed. no_answer: cancelled
 * without the plugin's confirmation in time. unsupported: cancelled at once, the plugin takes no command.cancel.
 */
export type RunEndReason = 'plugin' | 'plugin_error' | 'timeout' | 'plugin_stopped' | 'no_answer' | 'unsupported';
/** A run as the page sees it (HTTP answers and the stream's plugin-run frames). */
export interface RunView {
  runId: string; clusterId: string; pluginId: string; pluginName: string; command: string; title: string; state: RunState;
  startedAt: string; endedAt: string | null; progress: string | null; fraction: number | null; text: string | null;
  reason: RunEndReason | null; data?: unknown; dataOmitted?: true;
}
interface Run extends RunView {
  cap?: ReturnType<typeof setTimeout>; grace?: ReturnType<typeof setTimeout>; pending?: ReturnType<typeof setTimeout>; lastEmit: number; long: boolean;
}

const ACTIVE: ReadonlySet<RunState> = new Set(['starting', 'running', 'cancelling']);
const span = (ms: number) => (ms < 1000 ? `${ms} 毫秒` : ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60_000)} 分钟`);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** `data` for the page: kept when its JSON is at most 16 KiB, otherwise left out and marked. */
function withData(value: unknown): Pick<RunView, 'data' | 'dataOmitted'> {
  if (value === undefined) return {};
  let size = Infinity;
  try { size = Buffer.byteLength(JSON.stringify(value) ?? ''); } catch { /* not encodable: omitted */ }
  return size <= MAX_RESULT_DATA ? { data: value } : { dataOmitted: true };
}

/**
 * The runs of user-run commands, in memory only: a Hub restart forgets them. `cancelPlugin(pluginId, runId)` queues a
 * command.cancel for the plugin and says whether it could (false: the plugin did not opt in, or is not running).
 */
export class CommandRuns {
  private readonly runs = new Map<string, Run>();
  private readonly listeners = new Set<(run: RunView) => void>();
  readonly limits: CommandLimits;
  private readonly cancelPlugin: (pluginId: string, runId: string) => boolean;

  constructor(limits: CommandLimits, cancelPlugin: (pluginId: string, runId: string) => boolean) {
    this.limits = limits;
    this.cancelPlugin = cancelPlugin;
  }

  /** Every change of a run, final ones included. The web stream is the only listener. */
  onRun(listener: (run: RunView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(run: Run): void {
    const view = CommandRuns.view(run);
    for (const listener of this.listeners) {
      try { listener(view); } catch { /* one closed stream must not stop the others */ }
    }
  }

  static view(run: Run): RunView {
    const { cap: _c, grace: _g, pending: _p, lastEmit: _l, long: _long, ...view } = run;
    return { ...view };
  }

  active(clusterId: string): RunView[] {
    return [...this.runs.values()].filter((run) => run.clusterId === clusterId).map(CommandRuns.view);
  }

  count(pluginId: string): number {
    return [...this.runs.values()].filter((run) => run.pluginId === pluginId).length;
  }

  /**
   * A new run, starting; the cap counts from here. `long`: the command is declared longRunning, so it may answer
   * `{accepted:true}` and report with notifications; another command's run takes no progress or done.
   */
  create(fields: Pick<RunView, 'clusterId' | 'pluginId' | 'pluginName' | 'command' | 'title'>, long = false): Run {
    const run: Run = { runId: randomUUID(), ...fields, state: 'starting', startedAt: new Date().toISOString(), endedAt: null,
      progress: null, fraction: null, text: null, reason: null, lastEmit: 0, long };
    this.runs.set(run.runId, run);
    run.cap = setTimeout(() => {
      if (this.runs.get(run.runId) !== run) return;
      const told = this.cancelPlugin(run.pluginId, run.runId);
      this.finish(run, 'failed', { reason: 'timeout',
        text: `命令运行超过 ${span(this.limits.runMs)}，Hub 不再等它的结果${told ? '，已通知插件取消' : '；插件不接收取消通知，可能仍在运行'}。` });
    }, this.limits.runMs);
    run.cap.unref?.();
    this.emit(run);
    return run;
  }

  /** The invoke's answer, read after the await: only a run still starting takes it (a final or cancelled one ignores it). */
  answered(run: Run, answer: unknown): void {
    if (this.runs.get(run.runId) !== run || run.state !== 'starting') return;
    const result = record(answer);
    // Only a command the manifest declares longRunning goes to the background; any other answer is final as it is.
    if (run.long && result?.accepted === true) {
      run.state = 'running';
      // A command.progress that came in the same chunk as this answer was handled first and is newer: keep it.
      if (typeof result.text === 'string' && run.progress === null) run.progress = cleanText(result.text, MAX_PROGRESS_TEXT) || null;
      run.lastEmit = Date.now();
      this.emit(run);
      return;
    }
    const text = typeof answer === 'string' ? answer : typeof result?.text === 'string' ? result.text : null;
    this.finish(run, 'succeeded', { text: text === null ? null : cleanText(text, MAX_RESULT_TEXT, true) || null, ...withData(answer) });
  }

  /** The invoke failed (an error answer, the plugin call limit, or the plugin failing on it). */
  failed(run: Run): void {
    if (this.runs.get(run.runId) !== run || run.state !== 'starting') return;
    this.finish(run, 'failed', { reason: 'plugin_error', text: '插件报告命令失败。' });
  }

  /** A run of this plugin's, or undefined: an unknown, ended or another plugin's runId is dropped without a word. */
  private owned(pluginId: string, params: unknown): { run: Run; params: Record<string, unknown> } | undefined {
    const p = record(params);
    const run = typeof p?.runId === 'string' ? this.runs.get(p.runId) : undefined;
    return run && run.long && run.pluginId === pluginId ? { run, params: p! } : undefined;
  }

  /** command.progress `{runId, text, fraction?}`; accepted while starting or running, otherwise (or malformed) dropped. */
  progress(pluginId: string, raw: unknown): void {
    const found = this.owned(pluginId, raw);
    if (!found || (found.run.state !== 'starting' && found.run.state !== 'running')) return;
    const { run, params } = found;
    if (typeof params.text !== 'string') return;
    const fraction = params.fraction;
    if (fraction !== undefined && (typeof fraction !== 'number' || !(fraction >= 0 && fraction <= 1))) return;
    run.progress = cleanText(params.text, MAX_PROGRESS_TEXT) || null;
    run.fraction = fraction ?? null;
    if (run.pending) return;   // a later frame is already planned; it carries this newest text
    const wait = run.lastEmit + this.limits.progressIntervalMs - Date.now();
    if (wait <= 0) { run.lastEmit = Date.now(); this.emit(run); return; }
    run.pending = setTimeout(() => {
      run.pending = undefined;
      if (this.runs.get(run.runId) !== run) return;
      run.lastEmit = Date.now();
      this.emit(run);
    }, wait);
  }

  /** command.done `{runId, ok, text?, data?}`: ends a run that is still active; while cancelling it confirms the cancel. */
  done(pluginId: string, raw: unknown): void {
    const found = this.owned(pluginId, raw);
    if (!found) return;
    const { run, params } = found;
    if (typeof params.ok !== 'boolean' || (params.text !== undefined && typeof params.text !== 'string')) return;
    const text = typeof params.text === 'string' ? cleanText(params.text, MAX_RESULT_TEXT, true) || null : null;
    if (run.state === 'cancelling') this.finish(run, 'cancelled', { reason: 'plugin', text, ...withData(params.data) });
    else this.finish(run, params.ok ? 'succeeded' : 'failed', { reason: params.ok ? null : 'plugin', text, ...withData(params.data) });
  }

  /** The user's cancel: only a run of this cluster, once it is running. */
  cancel(clusterId: string, runId: string): RunView {
    const run = this.runs.get(runId);
    if (!run || run.clusterId !== clusterId) throw new CommandRefusal('RUN_NOT_FOUND', '没有这个正在运行的命令。');
    if (run.state === 'starting') throw new CommandRefusal('NOT_CANCELLABLE', '命令还在启动，稍后再取消。');
    if (run.state === 'cancelling') return CommandRuns.view(run);
    if (!this.cancelPlugin(run.pluginId, run.runId)) {
      this.finish(run, 'cancelled', { reason: 'unsupported', text: '这个插件不接收取消通知：Hub 不再等它的结果，插件可能仍在运行这个命令。' });
      return CommandRuns.view(run);
    }
    run.state = 'cancelling';
    run.grace = setTimeout(() => {
      if (this.runs.get(run.runId) !== run) return;
      this.finish(run, 'cancelled', { reason: 'no_answer',
        text: `插件没有在 ${span(this.limits.cancelGraceMs)}内确认取消：Hub 不再等它的结果，插件可能仍在运行这个命令。` });
    }, this.limits.cancelGraceMs);
    this.emit(run);
    return CommandRuns.view(run);
  }

  /** The plugin stopped or failed: each of its active runs fails. */
  endPlugin(pluginId: string): void {
    for (const run of [...this.runs.values()]) {
      if (run.pluginId === pluginId) this.finish(run, 'failed', { reason: 'plugin_stopped', text: '插件已停止或正在重启，命令没有完成；等它重新运行后可以再试。' });
    }
  }

  private finish(run: Run, state: RunState, fields: Partial<Pick<RunView, 'text' | 'reason' | 'data' | 'dataOmitted'>>): void {
    if (!ACTIVE.has(run.state) || this.runs.get(run.runId) !== run) return;
    clearTimeout(run.cap);
    clearTimeout(run.grace);
    clearTimeout(run.pending);
    run.pending = undefined;
    Object.assign(run, { text: null, reason: null }, fields, { state, endedAt: new Date().toISOString() });
    this.runs.delete(run.runId);
    this.emit(run);
  }

  /** Hub shutdown: timers stop, nothing more is reported. */
  close(): void {
    for (const run of this.runs.values()) { clearTimeout(run.cap); clearTimeout(run.grace); clearTimeout(run.pending); }
    this.runs.clear();
    this.listeners.clear();
  }
}
