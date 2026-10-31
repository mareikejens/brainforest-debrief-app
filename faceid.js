// Face ID unlock with a passkey (WebAuthn PRF). The passkey never leaves the Secure Enclave; with
// Face ID it hands this page a 32-byte secret, which becomes the AES key for the stored API keys.
// No passkey, no Face ID -> no secret -> the stored blob stays unreadable. The passphrase still works as fallback.
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

export const faceIdAvailable = async () =>
  Boolean(window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()));

async function prfKey(rawId, salt) {
  const a = await navigator.credentials.get({
    publicKey: { challenge: rand(32), allowCredentials: [{ type: 'public-key', id: rawId }], userVerification: 'required', extensions: { prf: { eval: { first: salt } } } },
  });
  const out = a.getClientExtensionResults().prf?.results?.first;
  if (!out) throw new Error('Face ID unlock is not supported in this browser. Use the passphrase.');
  return crypto.subtle.importKey('raw', out, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Creates the passkey (Face ID prompt) and seals the keys with it (second Face ID prompt). */
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
  if (cred.getClientExtensionResults().prf?.enabled === false) throw new Error('This device cannot do Face ID unlock for web apps. The passphrase stays your unlock.');
  return seal(secrets, cred.rawId);
}

export async function seal(secrets, rawId) {
  const salt = rand(32), iv = rand(12);
  const key = await prfKey(rawId, salt);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(secrets)));
  return { v: 1, id: b64(rawId), salt: b64(salt), iv: b64(iv), data: b64(data) };
}

export async function unlock(blob) {
  const key = await prfKey(unb64(blob.id), unb64(blob.salt));
  try {
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.data))));
  } catch {
    throw new Error('Face ID unlock failed. Use the passphrase.');
  }
}

export const credentialId = (blob) => unb64(blob.id);
