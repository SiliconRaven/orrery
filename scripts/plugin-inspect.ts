import { cleanText } from '../src/core/external-plugin-commands.ts';
import { COMMAND_PARAM_TYPES, EXTERNAL_API_VERSION, EXTERNAL_PERMISSIONS, readExternalManifest, resolveExternalEntry } from '../src/core/external-plugin-config.ts';
import { MARK_STATES, MARK_TARGETS, UI_POSITIONS } from '../src/core/external-plugin-ui.ts';
import { FIELD_TYPES } from '../src/core/external-plugin-values.ts';

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error('usage: npm run plugin:inspect -- <manifest> | --capabilities');
  process.exitCode = 2;
} else if (args[0] === '--capabilities') {
  console.log(JSON.stringify({
    apiVersion: EXTERNAL_API_VERSION,
    permissions: EXTERNAL_PERMISSIONS,
    uiPositions: UI_POSITIONS,
    commandParamTypes: COMMAND_PARAM_TYPES,
    configFieldTypes: FIELD_TYPES,
    markTargets: MARK_TARGETS,
    markStates: MARK_STATES,
  }, null, 2));
} else {
  try {
    const { manifest, directory } = readExternalManifest(args[0]);
    resolveExternalEntry(directory, manifest);
    const rows: [string, readonly string[]][] = [
      ['Plugin dependencies (declared)', manifest.requires ?? []],
      ['Permissions requested', manifest.permissions],
      ['Event subscriptions requested', manifest.events],
      ['Published events declared', manifest.publishes.map((event) => event.type)],
      ['Commands declared', manifest.commands.map((command) => command.id)],
      ['Member tools declared', manifest.memberTools.map((tool) => tool.name)],
      ['Web UI positions declared', manifest.ui?.positions ?? []],
      ['Configuration fields declared', manifest.config?.map((field) => field.name) ?? []],
    ];
    console.log(`${manifest.id} ${manifest.version} (API v${manifest.apiVersion})`);
    const entry = JSON.stringify(manifest.entry).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
      (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`);
    console.log(`Entry: ${entry}`);
    for (const [label, values] of rows) console.log(`${label}: ${values.join(', ') || '(none)'}`);
  } catch (error) {
    console.error(`Plugin preflight failed: ${cleanText((error as Error).message, 4096)}`);
    process.exitCode = 1;
  }
}
