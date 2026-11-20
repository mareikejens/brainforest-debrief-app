// Gradium voice engine: the interviewer loop built from parts, because Gradium sells speech, not agents.
//
//   mic ──24 kHz PCM──▶ Gradium STT (semantic VAD) ──turn ended──▶ Claude (streams, may call skip_turn / end_call)
//                                                                       │ text, sentence by sentence
//                                         speaker ◀──PCM── Gradium TTS ◀┘
//
// It exposes the same small surface the page already uses for the ElevenLabs SDK:
//   getId(), endSession(), sendUserMessage(text), setMicMuted(bool),
// and reports through onConnect / onModeChange / onMessage / onError / onDisconnect({reason}).
//
// Half duplex on purpose: while the interviewer talks (and for a moment after), the mic is sent as silence.
// That removes speaker echo on phones and means the interviewer never hears itself. Cost: no barge-in.
// Nothing here touches `window` at import time, so the same file is tested in Node with fakes.

const API = 'https://api.gradium.ai';
const WSS = 'wss://api.gradium.ai';
const STT_RATE = 24000;                    // "pcm" input = 24 kHz, 16-bit mono
const FRAME = 1920;                        // 80 ms at 24 kHz, the size Gradium recommends

/** Turn-taking knobs. patienceSteps counts 80 ms VAD steps: 30 steps = 2.4 s of confident silence. */
export const TURN = { vadThreshold: 0.5, patienceSteps: 30, fallbackMs: 5000, flushWaitMs: 1500, tailMs: 400 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- pure helpers (tested in Node) ----------
export function pcm16Base64(f32) {
  const bytes = new Uint8Array(f32.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    view.setInt16(i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToFloat32(b64) {
  const bin = atob(b64);
  const view = new DataView(new ArrayBuffer(bin.length - (bin.length % 2)));
  for (let i = 0; i < view.byteLength; i++) view.setUint8(i, bin.charCodeAt(i));
  const out = new Float32Array(view.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** Streaming downsampler by averaging. Keeps its phase across chunks, so chunk size does not matter. */
export class Resampler {
  constructor(from, to = STT_RATE) { this.ratio = from / to; this.pos = 0; this.sum = 0; this.n = 0; }
  push(input) {
    if (this.ratio <= 1) return input;                       // never upsample a mic; pass through
    const out = [];
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i]; this.n++; this.pos++;
      if (this.pos >= this.ratio) { out.push(this.sum / this.n); this.sum = 0; this.n = 0; this.pos -= this.ratio; }
    }
    return Float32Array.from(out);
  }
}

/** Dictionary terms to bias STT. Gradium matches one token at a time, case and accent sensitive. */
export function buildKeywords(terms) {
  const strip = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const out = [];
  for (const term of terms) for (const tok of String(term).split(/\s+/).filter(Boolean)) {
    for (const v of [tok, tok.toLowerCase(), strip(tok), strip(tok).toLowerCase()]) if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, 500);
}

/** The dictionary table: [term, meaning] rows. Same parsing as setup.mjs. */
export function dictionaryRows(text) {
  return String(text || '').split('\n').filter((l) => l.startsWith('|'))
    .map((l) => l.split('|').slice(1, 3).map((s) => s.trim()))
    .filter(([term]) => term && term !== 'Write as' && !/^-+$/.test(term));
}

/** Same substitution the ElevenLabs agent does server-side. */
export function fillPrompt(template, vars, dictText) {
  const known = dictionaryRows(dictText).map(([t, m]) => `- ${t}: ${m}`).join('\n') || '- (none yet)';
  return String(template).replace('<<DICTIONARY>>', known).replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : ''));
}

/** Cut speakable chunks off a growing text buffer: after a sentence or clause end, or at ~80 characters. */
export function splitSpeakable(buf, final = false) {
  if (final) return [buf.trim() ? buf.trim() : '', ''];
  let cut = -1; const re = /[.!?,;:](?=\s)/g; let m;
  while ((m = re.exec(buf))) cut = m.index + 1;
  if (cut < 0 && buf.length > 80) cut = buf.lastIndexOf(' ');
  if (cut <= 0) return ['', buf];
  return [buf.slice(0, cut) + ' ', buf.slice(cut).replace(/^\s+/, '')];
}

// ---------- Gradium auth: short-lived single-use tokens, minted from the key (CORS allows the browser) ----------
export async function mintToken(apiKey, fetchFn = (...a) => fetch(...a)) {
  const res = await fetchFn(`${API}/api/api-keys/token`, { headers: { 'x-api-key': apiKey } });
  if (res.status === 401 || res.status === 403) throw new Error('Gradium key invalid or revoked. Open Settings and paste a new one.');
  if (!res.ok) throw new Error(`Gradium ${res.status}`);                 // never echo the body
  const b = await res.json().catch(() => ({}));
  if (!b.token) throw new Error('Gradium sent no token.');
  return { token: b.token, expires: b.expires_at ? Date.parse(b.expires_at) : Date.now() + 30000 };
}

/** One token ahead of time, so a TTS socket never waits for a round trip. Tokens are consumed on use. */
function tokenSource(apiKey, fetchFn) {
  let next = null;
  const fresh = (t) => t && t.expires - Date.now() > 5000;
  const warm = () => { next = mintToken(apiKey, fetchFn).catch(() => null); };
  return {
    async get() {
      const t = next ? await next : null; next = null;
      const use = fresh(t) ? t : await mintToken(apiKey, fetchFn);
      warm(); return use.token;
    },
    warm,
  };
}

// ---------- Claude, streamed ----------
export async function* claudeStream({ apiKey, model, system, messages, tools, signal, fetchFn = (...a) => fetch(...a) }) {
  const res = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model, max_tokens: 400, stream: true, system, messages, tools }),
  });
  if (res.status === 401) throw new Error('Anthropic key invalid or revoked. Open Settings and paste a new one.');
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(`Anthropic ${res.status}: ${b.error?.message || 'error'}`); }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data:')); buf = buf.slice(i + 2);
      if (!line) continue;
      let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
      if (d.type === 'content_block_start' && d.content_block?.type === 'tool_use') yield { type: 'tool', name: d.content_block.name };
      else if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') yield { type: 'text', text: d.delta.text };
      else if (d.type === 'error') throw new Error(`Anthropic: ${d.error?.message || 'error'}`);
    }
  }
}

// ---------- browser audio (not used by the Node tests, which inject fakes) ----------
/** Call synchronously inside the tap on Start/Continue: iOS only unlocks audio from a user gesture. */
export function prepareAudio() {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  const ctx = new Ctx(); ctx.resume?.().catch?.(() => {}); return ctx;
}

export class Player {
  constructor(ctx) { this.ctx = ctx; this.next = 0; this.live = 0; this.waiters = []; this.nodes = new Set(); }
  enqueue(f32, rate) {
    if (!f32.length) return;
    const buf = this.ctx.createBuffer(1, f32.length, rate); buf.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.connect(this.ctx.destination);
    const at = Math.max(this.ctx.currentTime + 0.03, this.next);
    src.start(at); this.next = at + buf.duration; this.live++; this.nodes.add(src);
    src.onended = () => { this.nodes.delete(src); this.live--; this.#settle(); };
  }
  #settle() { if (this.live === 0) { const w = this.waiters; this.waiters = []; w.forEach((r) => r()); } }
  /** Resolves when everything enqueued so far has been played. Call after the last chunk arrived. */
  whenIdle() { return new Promise((r) => { this.waiters.push(r); this.#settle(); }); }
  stop() { for (const n of this.nodes) { try { n.stop(); } catch {} } this.nodes.clear(); this.live = 0; this.#settle(); }
}

/** Microphone as 80 ms frames of 24 kHz floats. AudioWorklet when possible, ScriptProcessor otherwise. */
export async function startMic(ctx, onFrame) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const src = ctx.createMediaStreamSource(stream);
  const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);   // Safari pulls audio only through a connected graph
  const rs = new Resampler(ctx.sampleRate); let pend = new Float32Array(0);
  const take = (f32) => {
    const r = rs.push(f32); const merged = new Float32Array(pend.length + r.length); merged.set(pend); merged.set(r, pend.length);
    let o = 0; while (merged.length - o >= FRAME) { onFrame(merged.slice(o, o + FRAME)); o += FRAME; }
    pend = merged.slice(o);
  };
  let node;
  try {
    const code = "class C extends AudioWorkletProcessor{process(i){const c=i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('cap',C)";
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    node = new AudioWorkletNode(ctx, 'cap'); node.port.onmessage = (e) => take(e.data);
  } catch {
    node = ctx.createScriptProcessor(4096, 1, 1); node.onaudioprocess = (e) => take(new Float32Array(e.inputBuffer.getChannelData(0)));
  }
  src.connect(node); node.connect(sink);
  return { stop() { try { node.disconnect(); src.disconnect(); } catch {} stream.getTracks().forEach((t) => t.stop()); } };
}

// ---------- the session ----------
const TOOL_SCHEMA = { type: 'object', properties: {} };

/**
 * opts: gradiumKey, anthropicKey, system, model, voiceId, firstMessage, tools [{name, description}], keywords [string],
 *       language, maxSeconds, history (earlier call, only for the transcript prompt), cb {...callbacks},
 *       io { player, startMic(onFrame) }  (real ones from audioCtx, fakes in tests),
 *       deps { fetch, WebSocket, sleep }, turn (override TURN)
 */
export async function startSession(opts) {
  const { gradiumKey, anthropicKey, system, model = 'claude-sonnet-5-5', voiceId, firstMessage, keywords = [], language = 'any', maxSeconds = 1500, cb = {} } = opts;
  const turn = { ...TURN, ...(opts.turn || {}) };
  const fetchFn = opts.deps?.fetch || ((...a) => fetch(...a));
  const WS = opts.deps?.WebSocket || globalThis.WebSocket;
  const nap = opts.deps?.sleep || sleep;
  const io = opts.io;
  const tools = (opts.tools || []).map((t) => ({ name: t.name, description: t.description, input_schema: TOOL_SCHEMA }));
  const tokens = tokenSource(gradiumKey, fetchFn);

  let ended = false, muted = false, speaking = false, tail = false, llm = null, thinking = false;
  let utter = [], quiet = 0, lastTextAt = 0, committing = false, flushId = 0, flushWaiter = null;
  const history = [{ role: 'user', content: opts.reconnected ? '(call reconnected)' : '(call connected)' }];
  let chain = Promise.resolve();
  const schedule = (fn) => (chain = chain.then(fn).catch((e) => fail(e)));
  const fail = (e) => { if (!ended) cb.onError?.(e); };
  const mode = (m) => cb.onModeChange?.({ mode: m });

  // ---- sockets ----
  const open = async (path, setup, onMsg, onClose) => {
    const url = `${WSS}/api/speech/${path}?token=${encodeURIComponent(await tokens.get())}`;
    const ws = new WS(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('Could not reach Gradium.')); });
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMsg(m); };
    ws.onclose = () => onClose?.();
    ws.send(JSON.stringify({ type: 'setup', ...setup }));
    return ws;
  };

  // ---- speaking: one TTS socket per agent turn, audio goes straight to the player ----
  async function speaker() {
    let rate = 48000, finished = false, resolveDone; const done = new Promise((r) => (resolveDone = r));
    let ws = null;
    const end = () => { if (!finished) { finished = true; resolveDone(); } };
    ws = await open('tts', { model_name: 'default', voice_id: voiceId, output_format: 'pcm' }, (m) => {
      if (m.type === 'ready') rate = m.sample_rate || rate;
      else if (m.type === 'audio' && m.audio) io.player.enqueue(base64ToFloat32(m.audio), rate);
      else if (m.type === 'end_of_stream') end();
      else if (m.type === 'error') { fail(new Error('Gradium voice error: ' + (m.message || m.error || 'unknown'))); end(); }
    }, end);
    return {
      say: (text) => { if (text) ws.send(JSON.stringify({ type: 'text', text })); },
      finish: () => ws.send(JSON.stringify({ type: 'end_of_stream' })),
      done: done.then(() => { try { ws.close(); } catch {} }),
      cancel: () => { end(); try { ws.close(); } catch {} },
    };
  }

  async function sayWhole(text) {
    speaking = true; mode('speaking');
    const sp = await speaker(); sp.say(text + ' <flush>'); sp.finish();
    await sp.done; await io.player.whenIdle(); await nap(turn.tailMs);
    speaking = false; mode('listening');
  }

  // ---- listening: one STT socket for the whole call ----
  const sttSetup = { model_name: 'default', input_format: 'pcm', json_config: { language, delay_in_frames: 16, ...(keywords.length ? { keywords: { words: keywords, boost: 3 } } : {}) } };
  let stt = null, sttRetried = false;
  const onStt = (m) => {
    if (m.type === 'text' && m.text) {
      if (speaking || tail) return;                      // silence was sent; this is just trailing output from before
      utter.push(m.text.trim()); quiet = 0; lastTextAt = Date.now();
      if (thinking && llm) { llm.abort(); }              // she kept talking: drop the draft reply, answer all of it later
    } else if (m.type === 'step' && m.vad?.length) {
      const h = m.vad[m.vad.length - 1];
      quiet = h.inactivity_prob > turn.vadThreshold ? quiet + 1 : 0;
      maybeCommit();
    } else if (m.type === 'flushed') { flushWaiter?.(m.flush_id); }
    else if (m.type === 'error') fail(new Error('Gradium listening error: ' + (m.message || m.error || 'unknown')));
  };
  const connectStt = async () => { stt = await open('asr', sttSetup, onStt, onSttClosed); };
  const onSttClosed = async () => {
    if (ended) return;
    if (!sttRetried) { sttRetried = true; try { await connectStt(); sttRetried = false; return; } catch {} }
    disconnect('error');
  };

  function maybeCommit() {
    if (ended || committing || speaking || tail || !utter.length) return;
    if (quiet >= turn.patienceSteps || Date.now() - lastTextAt > turn.fallbackMs) commit();
  }
  function commit() {
    committing = true;
    schedule(async () => {
      try {
        // Ask STT to finish what it has heard, then take the text.
        const id = ++flushId;
        const flushed = new Promise((r) => (flushWaiter = (got) => got === id && r()));
        try { stt.send(JSON.stringify({ type: 'flush', flush_id: id })); await Promise.race([flushed, nap(turn.flushWaitMs)]); } catch {}
        flushWaiter = null;
        const text = utter.join(' ').replace(/\s+/g, ' ').trim(); utter = []; quiet = 0;
        if (!text) return;
        history.push({ role: 'user', content: text }); cb.onMessage?.({ role: 'user', message: text });
        await respond();
      } finally { committing = false; }
    });
  }

  // ---- thinking: Claude decides what, if anything, to say ----
  async function respond() {
    llm = new AbortController(); thinking = true;
    let sp = null, buf = '', said = '', endCall = false, aborted = false;
    try {
      for await (const ev of claudeStream({ apiKey: anthropicKey, model, system, messages: history, tools, signal: llm.signal, fetchFn })) {
        if (ev.type === 'tool') { if (ev.name === 'end_call') endCall = true; continue; }
        said += ev.text; buf += ev.text;
        if (!sp) { thinking = false; speaking = true; mode('speaking'); sp = await speaker(); }
        const [chunk, rest] = splitSpeakable(buf); buf = rest; if (chunk) sp.say(chunk);
      }
    } catch (e) {
      aborted = e?.name === 'AbortError';
      if (!aborted) fail(e);
    } finally { thinking = false; llm = null; }
    if (aborted && !said) return;                                   // she talked over the thinking: the next turn answers everything
    if (sp) {
      const [last] = splitSpeakable(buf, true); if (last) sp.say(last + ' <flush>'); else sp.say('<flush>');
      sp.finish();
    }
    const spoken = said.trim();
    if (spoken) { history.push({ role: 'assistant', content: spoken }); cb.onMessage?.({ role: 'agent', message: spoken }); }
    if (sp) { await sp.done; await io.player.whenIdle(); tail = true; await nap(turn.tailMs); tail = false; speaking = false; mode('listening'); }
    if (endCall) disconnect('agent');
  }

  // ---- lifecycle ----
  let micHandle = null, timer = null;
  function disconnect(reason) {
    if (ended) return; ended = true; teardown();
    cb.onDisconnect?.({ reason });
  }
  function teardown() {
    clearTimeout(timer); llm?.abort(); io.player.stop();
    try { micHandle?.stop(); } catch {}
    try { stt?.close(); } catch {}
  }

  tokens.warm();
  await connectStt();
  micHandle = await io.startMic((frame) => {
    if (ended || stt?.readyState === 3) return;
    const silent = muted || speaking || tail;
    try { stt.send(JSON.stringify({ type: 'audio', audio: pcm16Base64(silent ? new Float32Array(frame.length) : frame) })); } catch {}
    if (!silent) maybeCommit();                                    // fallback timer if no step messages ever arrive
  });
  timer = setTimeout(() => disconnect('timeout'), maxSeconds * 1000);
  cb.onConnect?.();
  schedule(() => sayWhole(firstMessage).then(() => { history.push({ role: 'assistant', content: firstMessage }); cb.onMessage?.({ role: 'agent', message: firstMessage }); }));

  return {
    getId: () => null,                                              // nothing is stored at the provider
    setMicMuted: (m) => { muted = Boolean(m); },
    sendUserMessage: (text) => {                                    // typed spellings: the page already shows them
      history.push({ role: 'user', content: text });
      if (thinking && llm) llm.abort();
      schedule(async () => { if (!ended) await respond(); });
    },
    endSession: async () => { if (ended) return; ended = true; teardown(); },
  };
}
