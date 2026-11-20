// Official package web modules import the page's public helpers by their served address, /plugin-host/v1.js. Node has
// no page origin, so tests that import those modules map that one address to the file the Hub serves for it.
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const host = pathToFileURL(join(import.meta.dirname, '../src/web/public/plugin-host/v1.js')).href;
registerHooks({ resolve: (specifier, context, next) => next(specifier === '/plugin-host/v1.js' ? host : specifier, context) });
