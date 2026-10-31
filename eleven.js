// ElevenLabs calls made straight from the page (the API allows browser origins).
const BASE = 'https://api.elevenlabs.io';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function el(apiKey, path, init = {}, fetchFn = (...a) => fetch(...a)) {
  const res = await fetchFn(BASE + path, { ...init, headers: { 'xi-api-key': apiKey } });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}`); // never echo the body
  return res.status === 204 ? null : res.json().catch(() => null);
}

export const signedUrl = async (apiKey, agentId, f) =>
  (await el(apiKey, `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`, {}, f)).signed_url;

/** Authoritative transcript from the server side; null if it never became ready. */
export async function transcript(apiKey, id, f, wait = 2000) {
  for (let i = 0; i < 10; i++) {
    const c = await el(apiKey, `/v1/convai/conversations/${encodeURIComponent(id)}`, {}, f).catch(() => null);
    if (c?.status === 'failed') return null;
    if (c?.status === 'done') return (c.transcript || []).filter((t) => t.message).map((t) => ({ role: t.role === 'user' ? 'user' : 'agent', text: String(t.message) }));
    await sleep(wait);
  }
  return null;
}

export const deleteConversation = (apiKey, id, f) =>
  el(apiKey, `/v1/convai/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }, f).then(() => true, () => false);
