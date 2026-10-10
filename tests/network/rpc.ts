// Owner calls on the core of this namespace: bun rpc.ts <dataDir> <method> [json]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '../../packages/core/src/client.ts';

const [dataDir, method, params] = process.argv.slice(2);
const info = JSON.parse(readFileSync(join(dataDir!, 'core.json'), 'utf8'));
const client = await connect(`http://127.0.0.1:${info.port}`, info.token);
try {
  const result = await client.call(method as never, (params ? JSON.parse(params) : {}) as never);
  console.log(JSON.stringify(result));
} finally {
  client.close();
}
