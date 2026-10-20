import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { RpcErrorCode, ungroupedInput } from '@boite/contracts';

/** A machine's key as a core makes it (`coordination-key.pem`): its id, and the refusal it says it is in no group with. */
export function machineKey(): { coreId: string; ungrouped(nonce: string, as?: string): { code: number; message: string; data: object } } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const coreId = createHash('sha256').update(pem).digest('hex');
  return {
    coreId,
    // `as` signs it for another machine's id, as a machine at that machine's old address would.
    ungrouped: (nonce, as = coreId) => ({
      code: RpcErrorCode.Unavailable,
      message: 'this machine belongs to no group',
      data: { reason: 'ungrouped', publicKey: pem, sig: sign(null, Buffer.from(ungroupedInput(as, nonce)), privateKey).toString('base64') }
    })
  };
}
