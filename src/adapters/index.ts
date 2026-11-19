// harness name → native adapter factory. Each new adapter adds one line here.
import type { NativeAdapter } from '../core/types.ts';
import { createAntigravityNativeAdapter } from './antigravity/native.ts';
import { createClaudeNativeAdapter } from './claude/native.ts';
import { createCodexNativeAdapter } from './codex/native.ts';
import { createCursorNativeAdapter } from './cursor/native.ts';
import { createDeepseekNativeAdapter } from './deepseek/native.ts';
import { createKimiNativeAdapter } from './kimi/native.ts';
import { createDemoMockAdapter } from './mock/demo.ts';
import { createQoderNativeAdapter } from './qoder/native.ts';
import { createWorkbuddyNativeAdapter } from './workbuddy/native.ts';
import { createZcodeNativeAdapter } from './zcode/native.ts';

export const nativeFactories: Record<string, () => NativeAdapter> = {
  codex: () => createCodexNativeAdapter(),
  claude: () => createClaudeNativeAdapter(),
  deepseek: () => createDeepseekNativeAdapter(),
  antigravity: () => createAntigravityNativeAdapter(),
  kimi: () => createKimiNativeAdapter(),
  zcode: () => createZcodeNativeAdapter(),
  qoder: () => createQoderNativeAdapter(),
  workbuddy: () => createWorkbuddyNativeAdapter(),
  cursor: () => createCursorNativeAdapter(),
};

/**
 * The registry a Hub starts with. The demo harness `mock` (./mock/demo.ts) is in it only on request (ORRERY_MOCK=1: try the web
 * without any real app), so the normal web never offers it.
 */
export function registries(withMock: boolean): Record<string, () => NativeAdapter> {
  return withMock ? { ...nativeFactories, mock: () => createDemoMockAdapter() } : nativeFactories;
}
