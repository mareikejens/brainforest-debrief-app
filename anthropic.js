export async function callClaude({ apiKey, system, user, model = 'claude-sonnet-5-5', fetchFn = (...a) => fetch(...a) }) {
  const res = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model, max_tokens: 6000, system, messages: [{ role: 'user', content: user }] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${body.error?.message || 'error'}`);
  return (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}
