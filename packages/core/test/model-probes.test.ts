import { expect, test } from 'bun:test';
import type { ModelInfo } from '@boite/contracts';
import { ModelProbes } from '../src/drivers/model-probes.ts';
import type { ProbeContext } from '../src/drivers/types.ts';

const context = (providerId = 'provider', accountId = 'account') => ({ provider: { id: providerId }, accountId } as ProbeContext);
const models: ModelInfo[] = [{ id: 'model', name: 'Model', default: true }];

test('concurrent probes share the read, cached models remain account scoped', async () => {
  let reads = 0;
  const cache = new ModelProbes(async () => { reads++; return models; });
  const [a, b] = await Promise.all([cache.probe(context()), cache.probe(context())]);
  expect(a).toBe(b);
  expect(reads).toBe(1);
  expect(await cache.probe(context())).toBe(a);
  await cache.probe(context('provider', 'other'));
  expect(reads).toBe(2);
  cache.forget({ accountId: 'account' });
  expect(cache.models('provider', 'account')).toBeNull();
  expect(cache.models('provider', 'other')).toEqual(models);
});

test.each(['resolve', 'reject'] as const)('an old %s cannot replace or delete the new entry after invalidation', async outcome => {
  const old = Promise.withResolvers<ModelInfo[]>();
  let reads = 0;
  const cache = new ModelProbes(() => ++reads === 1 ? old.promise : Promise.resolve(models));
  const stale = cache.probe(context());
  // Attach a rejection handler before settling the old request.
  const observed = stale.catch(error => error);
  await Promise.resolve();
  cache.forget({ providerId: 'provider' });
  const fresh = await cache.probe(context());
  if (outcome === 'resolve') old.resolve([]);
  else old.reject(new Error('old read failed'));
  await observed;
  expect(await cache.probe(context())).toBe(fresh);
  expect(cache.models('provider', 'account')).toEqual(models);
  cache.forget();
  expect(cache.models('provider', 'account')).toBeNull();
});

test('a failed probe is retried and composite keys cannot collide', async () => {
  let reads = 0;
  const cache = new ModelProbes(async () => {
    if (++reads === 1) throw new Error('offline');
    return models;
  });
  await expect(cache.probe(context())).rejects.toThrow('offline');
  await cache.probe(context());
  await cache.probe(context('a::b', 'c'));
  await cache.probe(context('a', 'b::c'));
  expect(reads).toBe(4);
});
