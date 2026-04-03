/**
 * Crypto Helpers
 *
 * Phase 1 implementation status:
 * - This file now handles the first working crypto helpers for refresh-token hashing
 *   and provider-credential encryption/decryption.
 * - Future phases can reuse these helpers for invites, password resets, and MCP secrets.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { env } from '@/config/env.js';

function getEncryptionKey() {
  return createHash('sha256').update(env.ENCRYPTION_KEY).digest();
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function encryptJson(value: unknown) {
  const iv = randomBytes(12);
  const key = getEncryptionKey();
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptJson<T>(payload: string): T {
  const data = Buffer.from(payload, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);

  const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted) as T;
}
