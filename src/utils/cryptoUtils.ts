import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
const SALT = Buffer.from('salt'); // must match spx-ui

/** Decrypt the config payload spx-ui returns. Mirrors uiServices/src/utils/cryptoUtils.ts. */
export function decryptJSON(payload: string, ivHex: string, passphrase: string): any {
  const key = crypto.pbkdf2Sync(passphrase, SALT, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload, 'hex')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}
