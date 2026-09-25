import { expect, test, vi } from 'vitest';
import { RpcErrorCode } from '@boite/contracts';
import { RpcFailure, type Client } from './client';
import { lookupPullRequest, resetPullRequestSupport } from './pull-request';

test('one unsupported probe covers concurrent threads on the same core', async () => {
  const call = vi.fn().mockRejectedValue(new RpcFailure({code:RpcErrorCode.MethodNotFound,message:'unknown method threads.pullRequest'}));
  const client = {call} as unknown as Client;
  const results = await Promise.all(['one','two','three'].map(id => lookupPullRequest(client,id)));
  expect(results).toEqual([{supported:false},{supported:false},{supported:false}]);
  await lookupPullRequest(client,'four');
  expect(call).toHaveBeenCalledTimes(1);
});

test('a supported core returns each thread PR and a different core probes independently', async () => {
  const pr = {number:42,url:'https://github.com/example/project/pull/42',state:'OPEN'};
  const call = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(pr);
  const client = {call} as unknown as Client;
  expect(await lookupPullRequest(client,'one')).toEqual({supported:true,pullRequest:null});
  expect(await lookupPullRequest(client,'two')).toEqual({supported:true,pullRequest:pr});
});

test('authorization and transport errors are still reported and can be retried', async () => {
  const failure = new RpcFailure({code:RpcErrorCode.Unauthorized,message:'Access denied'});
  const call = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(null);
  const client = {call} as unknown as Client;
  await expect(lookupPullRequest(client,'one')).rejects.toBe(failure);
  expect(await lookupPullRequest(client,'one')).toEqual({supported:true,pullRequest:null});
});

test('reconnecting after an upgrade probes again', async () => {
  const call = vi.fn().mockRejectedValueOnce(new RpcFailure({code:RpcErrorCode.MethodNotFound,message:'unknown method'})).mockResolvedValue(null);
  const client = {call} as unknown as Client;
  expect(await lookupPullRequest(client,'one')).toEqual({supported:false});
  resetPullRequestSupport(client);
  expect(await lookupPullRequest(client,'one')).toEqual({supported:true,pullRequest:null});
});

test('only a refresh the user asked for tells the core to read the repository again', async () => {
  const call = vi.fn().mockResolvedValue(null);
  const client = {call} as unknown as Client;
  await lookupPullRequest(client,'one');
  await lookupPullRequest(client,'one',true);
  expect(call.mock.calls.map(args => args[1])).toEqual([{threadId:'one'},{threadId:'one',refresh:true}]);
});
