// Write the offline catalogs shipped to harnesses. The SDK is the source of their wire schemas.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hub } from '../src/core/hub.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { Store } from '../src/core/store.ts';
import { standardToolDeclarations } from '../src/mcp/server.ts';
import { officialPlugins } from '../src/plugins/index.ts';

const command = 'node scripts/sync-mcp-tools.ts';
const root = join(import.meta.dirname, '..');
const check = process.argv.includes('--check');
const block = /(?<=\/\/ BEGIN GENERATED MCP TOOLS\n)[\s\S]+?(?=\/\/ END GENERATED MCP TOOLS)/;

async function declarations() {
  const store = new Store(':memory:', new PluginHost(officialPlugins));
  try {
    const hub = new Hub({ store, nativeAdapters: {}, avatarPresets: [] });
    try { return await standardToolDeclarations(hub); }
    finally { await hub.close(); }
  } finally {
    store.close();
  }
}

function sync(file: string, render: (source: string) => string) {
  const path = join(root, file);
  const source = readFileSync(path, 'utf8');
  const normalized = source.replaceAll('\r\n', '\n');
  const expected = render(normalized);
  if (expected === normalized) return;
  if (check) {
    console.error(`${file} is out of date. Run ${command}.`);
    process.exitCode = 1;
  } else {
    writeFileSync(path, source.includes('\r\n') ? expected.replaceAll('\n', '\r\n') : expected);
  }
}

const tools = await declarations();
const entries = tools.map((tool) => `  ${JSON.stringify(tool)},\n`).join('');
for (const [file, prefix] of [
  ['src/bridge/claude-bridge.ts', ''],
  ['plugins/dsh-orrery/lib/index.js', 'export '],
]) {
  sync(file, (source) => {
    if (!block.test(source)) throw new Error(`missing generated MCP tools block in ${file}`);
    return source.replace(block, () => `${prefix}const TOOLS = [\n${entries}];\n`);
  });
}
sync('plugins/cursor-orrery/tools.json', () => `${JSON.stringify(tools, null, 2)}\n`);
