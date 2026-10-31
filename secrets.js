// Keys never sit in the browser as plain text: they are sealed with a passphrase (PBKDF2 -> AES-GCM)
// and only decrypted in memory after you unlock. Same code runs in Node for the tests.
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(pass, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(obj, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(pass, salt), enc.encode(JSON.stringify(obj))));
  return { v: 1, salt: b64(salt), iv: b64(iv), data: b64(data) };
}

export async function open(sealed, pass) {
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, await key(pass, unb64(sealed.salt)), unb64(sealed.data));
    return JSON.parse(dec.decode(plain));
  } catch {
    throw new Error('Wrong passphrase');
  }
}
