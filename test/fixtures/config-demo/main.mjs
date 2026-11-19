import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

// The Hub accepts lists with repeated strings. This plugin's format requires unique section names.
function checkSections(clusterId, { revision, values }) {
  const sections = values.sections ?? [];
  const errors = new Set(sections).size === sections.length ? {} : { sections: '栏目名称重复了。' };
  send({ method: 'config.errors', params: { clusterId, revision, errors } });
}

input.on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') {
    send({ id, result: { apiVersion: 1 } });
    for (const clusterId of params.clusterIds) {
      const scope = params.config.clusters[clusterId] ?? { revision: 0, values: params.config.clusterDefaults };
      checkSections(clusterId, scope);
    }
  } else if (method === 'config.changed') {
    if (params.clusterId !== null) checkSections(params.clusterId, params);
  } else if (method === 'shutdown') {
    send({ id, result: {} });
    input.close();
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: 'Unknown method' } });
  }
});
