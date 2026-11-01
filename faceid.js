// Face ID unlock with a passkey. Two modes, picked automatically:
//  - "prf": the passkey itself releases a secret after Face ID (WebAuthn PRF). Strongest: without
//    Face ID there is no key at all. Not every iOS web app offers PRF.
//  - "gate": where PRF is missing, the keys are encrypted with a device key that cannot be exported
//    (a non-extractable WebCrypto key in IndexedDB), and the app only uses it after a passing Face ID
//    check. Protects against someone picking up the phone; not against someone with developer tools
//    on your unlocked phone. The passphrase blob stays as the fallback either way.
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const dec = (b) => JSON.parse(new TextDecoder().decode(b));

export const faceIdAvailable = async () =>
  Boolean(window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()));

// ---------- device key in IndexedDB (gate mode) ----------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('debrief', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction('keys', mode); const q = fn(t.objectStore('keys')); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
async function deviceKey(create) {
  let k = await idbDo('readonly', (s) => s.get('device')).catch(() => null);
  if (!k && create) {
    k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); // non-extractable
    await idbDo('readwrite', (s) => s.put(k, 'device'));
  }
  if (!k) throw new Error('Face ID key missing on this device. Unlock with the passphrase, then turn Face ID on again in Settings.');
  return k;
}

// ---------- passkey ----------
async function assert(rawId, salt) {
  const a = await navigator.credentials.get({
    publicKey: { challenge: rand(32), allowCredentials: [{ type: 'public-key', id: rawId }], userVerification: 'required', ...(salt && { extensions: { prf: { eval: { first: salt } } } }) },
  });
  if (!a.response.authenticatorData || !(new Uint8Array(a.response.authenticatorData)[32] & 0x04)) throw new Error('Face ID was not confirmed.'); // UV flag
  return a.getClientExtensionResults().prf?.results?.first || null;
}
const aesFrom = (bytes) => crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);

async function sealWith(key, secrets) {
  const iv = rand(12);
  return { iv: b64(iv), data: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc(secrets))) };
}

/** Creates the passkey (Face ID) and seals the keys with the best mode the device offers (second Face ID). */
export async function enroll(secrets) {
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Brainforest debrief' },
      user: { id: rand(16), name: 'debrief', displayName: 'Brainforest debrief' },
      challenge: rand(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
      extensions: { prf: {} },
    },
  });
  return seal(secrets, cred.rawId);
}

export async function seal(secrets, rawId) {
  const salt = rand(32);
  const prf = await assert(rawId, salt);
  if (prf) return { v: 2, mode: 'prf', id: b64(rawId), salt: b64(salt), ...(await sealWith(await aesFrom(prf), secrets)) };
  return { v: 2, mode: 'gate', id: b64(rawId), ...(await sealWith(await deviceKey(true), secrets)) };
}

export async function unlock(blob) {
  const prf = await assert(unb64(blob.id), blob.mode === 'prf' || !blob.mode ? unb64(blob.salt) : null);
  const key = blob.mode === 'gate' ? await deviceKey(false) : prf ? await aesFrom(prf) : null;
  if (!key) throw new Error('Face ID unlock failed. Use the passphrase.');
  try { return dec(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.data))); }
  catch { throw new Error('Face ID unlock failed. Use the passphrase.'); }
}

export const credentialId = (blob) => unb64(blob.id);
