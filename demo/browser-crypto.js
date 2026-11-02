// Browser stand-in for src/crypto.js (demo only — sample accounts, no real secrets).
import { sha256 as jsSha256 } from 'js-sha256';

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));

export const sha256 = (s) => jsSha256(String(s));

export function hashPassword(password) {
  const salt = randomHex(16);
  return `demo$${salt}$${sha256(salt + password)}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  return scheme === 'demo' && sha256(salt + password) === hash;
}

export function randomToken(bytes = 32) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
