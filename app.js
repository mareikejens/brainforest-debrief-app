import { open, seal } from './secrets.js';
import { Vault } from './vault.js';
import * as eleven from './eleven.js';
import { applyPlan, loadIndex, makePlan, saveMemo, unprocessed } from './flow.js';
import { findCandidates, contactFile, parseMemo, renderPreview, todayZurich } from './lib.js';

const $ = (id) => document.getElementById(id);
const SECTIONS = ['setup', 'unlock', 'home', 'live', 'pick', 'review'];
const show = (...names) => SECTIONS.forEach((s) => ($('s-' + s).hidden = !names.includes(s)));
const say = (msg, err = false) => { $('result').textContent = msg; $('result').className = err ? 'err' : 'hint'; };
const STORE = 'debrief.sealed.v1';
const store = {
  get: () => { try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; } },
  set: (v) => localStorage.setItem(STORE, JSON.stringify(v)),
  clear: () => localStorage.removeItem(STORE),
};
const spoken = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

let K = null;          // decrypted keys, memory only
let vault = null, index = null;
let job = null;        // the debrief being processed: { person, formDate, memoBase, transcript, target, plan }
let conversation = null, turns = [], finishing = false, person = '', meetingDate = '';

const config = await fetch('config.json').then((r) => r.json()).catch(() => ({}));

// ---------- unlock ----------
async function boot() {
  say('');
  if (!store.get()) {
    $('k-repo').value = config.repo || ''; $('k-agent').value = config.agentId || '';
    return show('setup');
  }
  show('unlock'); $('u-pass').focus();
}
$('setup-go').onclick = async () => {
  const k = { elevenKey: $('k-el').value.trim(), anthropicKey: $('k-an').value.trim(), githubToken: $('k-gh').value.trim(), repo: $('k-repo').value.trim(), agentId: $('k-agent').value.trim() };
  if (Object.values(k).some((v) => !v) || !$('k-pass').value) return say('Fill in every field, including the passphrase.', true);
  store.set(await seal(k, $('k-pass').value));
  for (const id of ['k-el', 'k-an', 'k-gh', 'k-pass']) $(id).value = '';
  K = k; await enter();
};
$('unlock-go').onclick = async () => {
  try { K = await open(store.get(), $('u-pass').value); $('u-pass').value = ''; await enter(); } catch (e) { say(e.message, true); }
};
$('u-pass').onkeydown = (e) => e.key === 'Enter' && $('unlock-go').click();
$('forget').onclick = () => { if (confirm('Remove the encrypted keys from this device?')) { store.clear(); boot(); } };

async function enter() {
  vault = new Vault({ token: K.githubToken, repo: K.repo });
  show('home'); say('Reading the vault…');
  try {
    index = await loadIndex(vault);
    say('');
    const list = unprocessed(index);
    $('pending').hidden = !list.length;
    $('memos').replaceChildren(...list.map((b) => {
      const li = document.createElement('li');
      const span = document.createElement('span'); span.textContent = b;
      const btn = document.createElement('button'); btn.textContent = 'Process'; btn.onclick = () => resume(b);
      li.append(span, btn); return li;
    }));
  } catch (e) { say('Could not read the vault: ' + e.message, true); }
  const hash = new URLSearchParams(location.hash.slice(1));
  $('person').value = $('person').value || (hash.get('person') || '').slice(0, 80);
}

// ---------- interview ----------
function addTurn(role, text) {
  turns.push({ role, text });
  const el = document.createElement('div');
  el.className = 't ' + (role === 'user' ? 'user' : 'agent');
  el.textContent = text; $('log').append(el); $('log').scrollTop = $('log').scrollHeight;
}
const setState = (mode, label) => { $('dot').className = 'dot ' + mode; $('state').textContent = label; };

$('start').onclick = async () => {
  person = $('person').value.replace(/\s+/g, ' ').trim(); meetingDate = $('date').value;
  if (!person) return say('Type the name first.', true);
  say(''); $('start').disabled = true; turns = []; $('log').replaceChildren(); finishing = false;
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const url = await eleven.signedUrl(K.elevenKey, K.agentId);
    show('live');
    conversation = await ElevenLabsClient.Conversation.startSession({
      signedUrl: url, connectionType: 'websocket',
      dynamicVariables: { person, meeting_date: meetingDate ? spoken(meetingDate) : 'not given yet', today: spoken(todayZurich()) },
      onConnect: () => setState('listening', 'Connected'),
      onModeChange: ({ mode }) => setState(mode, mode === 'speaking' ? 'Interviewer speaking' : 'Listening'),
      onMessage: ({ role, message }) => message && addTurn(role === 'user' ? 'user' : 'agent', message),
      onError: (e) => say('Error: ' + (e?.message || e), true),
      onDisconnect: () => { if (!finishing) finish(); },
    });
  } catch (e) {
    show('home'); say(e.name === 'NotAllowedError' ? 'Microphone blocked. Allow it for this site in the browser settings.' : e.message, true);
  } finally { $('start').disabled = false; }
};
$('typeform').onsubmit = (e) => {
  e.preventDefault();
  const text = $('typed').value.trim();
  if (!text || !conversation) return;
  conversation.sendUserMessage(`(typed) ${text}`); addTurn('user', `(typed) ${text}`); $('typed').value = '';
};
let muted = false;
$('mute').onclick = () => { muted = !muted; conversation?.setMicMuted(muted); $('mute').textContent = muted ? 'Unmute' : 'Mute'; };
$('end').onclick = () => finish();
window.addEventListener('beforeunload', (e) => { if (conversation && !finishing) { e.preventDefault(); e.returnValue = ''; } });

async function finish() {
  if (finishing) return; finishing = true; $('end').disabled = true; say('Saving the transcript…');
  const id = (() => { try { return conversation?.getId(); } catch { return null; } })();
  try { await conversation?.endSession(); } catch {}
  try {
    const remote = id ? await eleven.transcript(K.elevenKey, id) : null;
    const t = remote?.length ? remote : turns;
    if (!t.some((x) => x.role === 'user')) { show('home'); return say('No speech captured, nothing saved.', true); }
    const memoBase = await saveMemo({ vault, index, person, meetingDate: meetingDate || null, turns: t, origin: remote?.length ? 'elevenlabs' : 'browser' });
    if (id) await eleven.deleteConversation(K.elevenKey, id); // memo is safe in the vault, so drop the copy at ElevenLabs
    const text = (await vault.read(`${index.memoDir}/${memoBase}.md`)).text;
    begin({ person, formDate: meetingDate || null, memoBase, transcript: parseMemo(text).body });
  } catch (e) { finishing = false; $('end').disabled = false; say('Not saved: ' + e.message + '. Press End & save to retry; the transcript is still here.', true); }
}

async function resume(memoBase) {
  say('Loading the memo…');
  try {
    const m = parseMemo((await vault.read(`${index.memoDir}/${memoBase}.md`)).text);
    const name = m.person || prompt('Whose memo is this? Type the full name.');
    if (!name) return say('');
    begin({ person: name, formDate: m.date, memoBase, transcript: m.body });
  } catch (e) { say(e.message, true); }
}

// ---------- match, plan, review ----------
function begin(j) {
  job = { ...j, target: null, plan: null };
  const { exact, candidates } = findCandidates(job.person, index.contacts);
  if (exact) { job.target = { file: exact, isNew: false }; return plan(); }
  if (!candidates.length) { job.target = { file: contactFile(job.person), isNew: true }; return plan(); }
  $('pick-title').textContent = `No contact called ${job.person}. Is it one of these?`;
  $('pick-buttons').replaceChildren(...candidates.map((f) => btn(f.replace(/\.md$/, ''), () => { job.target = { file: f, isNew: false }; plan(); })),
    btn(`New person: ${job.person}`, () => { job.target = { file: contactFile(job.person), isNew: true }; plan(); }, true));
  show('pick');
}
function btn(label, fn, primary) { const b = document.createElement('button'); b.textContent = label; if (primary) b.className = 'primary'; b.onclick = fn; return b; }

async function plan(feedback) {
  say('Sorting it into the contact note…'); $('revise').disabled = $('write').disabled = true;
  try {
    job.plan = await makePlan({ anthropicKey: K.anthropicKey, vault, index, person: job.person, formDate: job.formDate, transcript: job.transcript,
      existingFile: job.target.isNew ? null : job.target.file, previous: feedback ? job.plan : null, feedback });
    render();
  } catch (e) { say(e.message, true); show('review'); }
  finally { $('revise').disabled = false; }
}
function render() {
  const p = job.plan;
  $('preview').textContent = renderPreview(p, { person: job.person, file: job.target.file, isNew: job.target.isNew, memoBase: job.memoBase, today: todayZurich() });
  $('qbox').hidden = !p.questions.length;
  $('questions').replaceChildren(...p.questions.map((q) => Object.assign(document.createElement('li'), { textContent: q })));
  $('write').disabled = Boolean(p.questions.length) || !p.meeting_date || !p.interaction;
  $('feedback').value = ''; say(''); show('review');
}
$('revise').onclick = () => { const f = $('feedback').value.trim(); if (f) plan(f); };
$('cancel').onclick = () => { job = null; say('Cancelled. The transcript stays saved in your vault; it will show up under "Saved but not processed".'); enter(); };
$('write').onclick = async () => {
  $('write').disabled = $('revise').disabled = true; say('Writing to the vault…');
  try {
    await applyPlan({ vault, index, person: job.person, plan: job.plan, memoBase: job.memoBase, target: job.target });
    const w = job.target.warnings?.length ? ' Note: ' + job.target.warnings.join(' ') : '';
    const done = `${job.person}: ${job.target.isNew ? 'new contact written' : 'contact updated'} and logged. Obsidian picks it up on its next sync.${w}`;
    job = null; await enter(); say(done);
  } catch (e) { say(e.message, true); $('write').disabled = $('revise').disabled = false; }
};

boot();
