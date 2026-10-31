import { open, seal } from './secrets.js';
import * as faceid from './faceid.js';
import { Vault } from './vault.js';
import * as eleven from './eleven.js';
import { drawGraph, mentions } from './graph.js';
import { applyPlan, loadIndex, makePlan, newDictionaryEntries, saveMemo, unprocessed } from './flow.js';
import { cleanLinkedIn, contactFile, existingLinkedIn, findCandidates, linkedInSearchUrl, parseMemo, renderPreview, todayZurich, writeBlocker } from './lib.js';

const $ = (id) => document.getElementById(id);
const SECTIONS = ['setup', 'unlock', 'home', 'live', 'pick', 'working', 'review', 'done', 'settings'];
const show = (name) => { SECTIONS.forEach((s) => ($('s-' + s).hidden = s !== name)); window.scrollTo(0, 0); };
const say = (msg, err = false) => { $('result').textContent = msg; $('result').className = err ? 'err' : ''; };
const spoken = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

// ---------- storage: keys sealed twice, with the passphrase and (if available) with Face ID ----------
const PASS_KEY = 'debrief.sealed.v1', FACE_KEY = 'debrief.faceid.v1';
const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  del: (k) => localStorage.removeItem(k),
};

let K = null;                // decrypted keys, in memory only
let vault = null, index = null, names = [];
let job = null;              // the debrief being processed
const config = await fetch('config.json').then((r) => r.json()).catch(() => ({}));

// ---------- unlock ----------
async function boot() {
  say(''); $('gear').hidden = true;
  if (!store.get(PASS_KEY)) {
    $('k-repo').value = config.repo || ''; $('k-agent').value = config.agentId || '';
    return show('setup');
  }
  const hasFace = Boolean(store.get(FACE_KEY));
  $('face-go').hidden = !hasFace;
  $('u-pass-label').textContent = hasFace ? 'Or with your passphrase' : 'Passphrase';
  show('unlock');
}

async function turnOnFaceId(keys) {
  if (!(await faceid.faceIdAvailable().catch(() => false))) return 'Face ID is not available here; you unlock with the passphrase.';
  try { store.set(FACE_KEY, await faceid.enroll(keys)); return ''; } catch (e) { return e.message || 'Face ID was not set up; you unlock with the passphrase.'; }
}

$('setup-go').onclick = async () => {
  const k = { elevenKey: $('k-el').value.trim(), anthropicKey: $('k-an').value.trim(), githubToken: $('k-gh').value.trim(), repo: $('k-repo').value.trim(), agentId: $('k-agent').value.trim() };
  if (Object.values(k).some((v) => !v) || !$('k-pass').value) return say('Fill in every field, including the passphrase.', true);
  store.set(PASS_KEY, await seal(k, $('k-pass').value));
  ['k-el', 'k-an', 'k-gh', 'k-pass'].forEach((id) => ($(id).value = ''));
  const note = await turnOnFaceId(k);
  K = k; await enter(); if (note) say(note);
};
$('face-go').onclick = async () => {
  try { K = await faceid.unlock(store.get(FACE_KEY)); await enter(); } catch (e) { say(e.message, true); }
};
$('unlock-go').onclick = async () => {
  try { K = await open(store.get(PASS_KEY), $('u-pass').value); $('u-pass').value = ''; await enter(); } catch (e) { say(e.message, true); }
};
$('u-pass').onkeydown = (e) => e.key === 'Enter' && $('unlock-go').click();

// ---------- settings ----------
$('gear').onclick = () => { $('x-repo').value = K.repo; $('x-agent').value = K.agentId; say(''); show('settings'); };
$('x-back').onclick = () => enter();
$('x-save').onclick = async () => {
  let current;
  try { current = await open(store.get(PASS_KEY), $('x-pass').value); } catch { return say('Wrong passphrase. Nothing changed.', true); }
  const pick = (id, old) => $(id).value.trim() || old;
  const k = { elevenKey: pick('x-el', current.elevenKey), anthropicKey: pick('x-an', current.anthropicKey), githubToken: pick('x-gh', current.githubToken), repo: pick('x-repo', current.repo), agentId: pick('x-agent', current.agentId) };
  store.set(PASS_KEY, await seal(k, $('x-pass').value));
  let note = '';
  const face = store.get(FACE_KEY);
  if (face) { try { store.set(FACE_KEY, await faceid.seal(k, faceid.credentialId(face))); } catch { note = ' Face ID was not updated: unlock with the passphrase once, then save again.'; } }
  ['x-el', 'x-an', 'x-gh', 'x-pass'].forEach((id) => ($(id).value = ''));
  K = k; await enter(); say('Saved.' + note);
};
$('forget').onclick = () => { if (confirm('Remove the keys from this device? You can paste them again any time.')) { store.del(PASS_KEY); store.del(FACE_KEY); K = null; boot(); } };

// ---------- home ----------
async function enter() {
  vault = new Vault({ token: K.githubToken, repo: K.repo });
  $('gear').hidden = false;
  show('home'); say('Reading your vault…');
  const hashArgs = new URLSearchParams(location.hash.slice(1));
  if (hashArgs.get('person') && !$('person').value) $('person').value = hashArgs.get('person').slice(0, 80);
  if (/^\d{4}-\d{2}-\d{2}$/.test(hashArgs.get('date') || '') && !$('date').value) $('date').value = hashArgs.get('date');
  try {
    index = await loadIndex(vault);
    const dict = (await vault.read('.claude/skills/voice-contact-debrief/dictionary.md').catch(() => null))?.text ?? '';
    const dictNames = dict.split('\n').filter((l) => l.startsWith('|')).map((l) => l.split('|')[1]?.trim()).filter((t) => t && t !== 'Write as' && !/^-+$/.test(t));
    names = [...index.notes, ...index.contacts.map((f) => f.replace(/^@ /, '').replace(/\.md$/, '')), ...dictNames];
    say('');
    const list = unprocessed(index);
    $('pending').hidden = !list.length;
    $('memos').replaceChildren(...list.map((b) => {
      const row = document.createElement('div'); row.className = 'memo';
      const m = /^(\d{4}-\d{2}-\d{2}) (.+) debrief/.exec(b);
      const label = document.createElement('span'); label.textContent = m ? m[2] : b;
      if (m) label.append(Object.assign(document.createElement('small'), { textContent: m[1] }));
      const btn = Object.assign(document.createElement('button'), { className: 'btn small', textContent: 'Review' });
      btn.onclick = () => resume(b);
      row.append(label, btn); return row;
    }));
  } catch (e) { say(e.message, true); }
  homeGraph();
}
function homeGraph() {
  const pool = (index ? index.notes : []).filter((n) => n.length >= 3 && n.length <= 16 && !/^\d/.test(n));
  const day = todayZurich();
  const nodes = pool.sort((a, b) => hash(a + day) - hash(b + day)).slice(0, 7).map((label) => ({ label }));
  drawGraph($('g-home'), { center: $('person').value.trim() || 'Someone new', nodes, mode: 'start' });
}
$('person').oninput = homeGraph;

// ---------- interview ----------
let conversation = null, turns = [], convIds = [], finishing = false, person = '', meetingDate = '', wake = null;
const keepAwake = async () => { try { wake = await navigator.wakeLock?.request('screen'); } catch { wake = null; } };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && conversation && !finishing) keepAwake(); });

function liveGraph(speaking) {
  const said = turns.filter((t) => t.role === 'user').map((t) => t.text).join(' ');
  const nodes = mentions(said, names).map((label) => ({ label, fresh: true }));
  drawGraph($('g-live'), { center: person, nodes, mode: 'live' });
  $('g-live').classList.toggle('speaking', Boolean(speaking));
}
function addTurn(role, text) {
  turns.push({ role, text });
  const d = document.createElement('div');
  d.className = 'say ' + (role === 'user' ? 'me' : 'ai');
  d.append(Object.assign(document.createElement('span'), { className: 'who', textContent: role === 'user' ? 'You' : 'Interviewer' }), text);
  $('log').append(d); $('log').scrollTop = $('log').scrollHeight;
  if (role === 'user') liveGraph();
}
const setState = (label, speaking) => { $('state').textContent = label; $('g-live').classList.toggle('speaking', Boolean(speaking)); };

async function connect(previous) {
  const url = await eleven.signedUrl(K.elevenKey, K.agentId);
  conversation = await ElevenLabsClient.Conversation.startSession({
    signedUrl: url, connectionType: 'websocket',
    dynamicVariables: { person, meeting_date: meetingDate ? spoken(meetingDate) : 'not given yet', today: spoken(todayZurich()), previous_conversation: previous || 'none' },
    onConnect: () => setState('Listening'),
    onModeChange: ({ mode }) => setState(mode === 'speaking' ? 'Interviewer speaking' : 'Listening', mode === 'speaking'),
    onMessage: ({ role, message }) => message && addTurn(role === 'user' ? 'user' : 'agent', message),
    onError: (e) => say('Error: ' + (e?.message || e), true),
    onDisconnect: (details) => {
      if (finishing) return;
      try { const id = conversation?.getId(); if (id && !convIds.includes(id)) convIds.push(id); } catch {}
      if (details?.reason === 'agent') return finish();             // the interviewer hung up after its last question
      $('interrupted').hidden = false; setState('Paused');           // phone locked, network gone: keep everything, offer to continue
      wake?.release?.(); wake = null;
    },
  });
  try { const id = conversation.getId(); if (id && !convIds.includes(id)) convIds.push(id); } catch {}
}

$('start').onclick = async () => {
  person = $('person').value.replace(/\s+/g, ' ').trim(); meetingDate = $('date').value;
  if (!person) return say('Type the name first.', true);
  say(''); $('start').disabled = true;
  turns = []; convIds = []; finishing = false; $('log').replaceChildren(); $('interrupted').hidden = true; $('end').disabled = false;
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    $('live-title').textContent = person; show('live'); liveGraph(); setState('Connecting');
    await keepAwake();
    await connect(null);
  } catch (e) {
    show('home'); say(e.name === 'NotAllowedError' ? 'Microphone blocked. Allow it for this site in the browser settings.' : e.message, true);
  } finally { $('start').disabled = false; }
};
$('resume').onclick = async () => {
  $('interrupted').hidden = true; setState('Connecting');
  const previous = turns.map((t) => `${t.role === 'user' ? 'Mareike' : 'Interviewer'}: ${t.text}`).join('\n').slice(-6000);
  try { await keepAwake(); await connect(previous); } catch (e) { $('interrupted').hidden = false; say(e.message, true); }
};
$('save-now').onclick = () => finish();
$('typeform').onsubmit = (e) => {
  e.preventDefault();
  const text = $('typed').value.trim();
  if (!text || !conversation) return;
  try { conversation.sendUserMessage(`(typed) ${text}`); } catch {}
  addTurn('user', `(typed) ${text}`); $('typed').value = '';
};
let muted = false;
$('mute').onclick = () => { muted = !muted; conversation?.setMicMuted(muted); $('mute').textContent = muted ? 'Unmute' : 'Mute'; };
$('end').onclick = () => finish();
window.addEventListener('beforeunload', (e) => { if (conversation && !finishing) { e.preventDefault(); e.returnValue = ''; } });

async function finish() {
  if (finishing) return; finishing = true; $('end').disabled = true;
  try { const id = conversation?.getId(); if (id && !convIds.includes(id)) convIds.push(id); } catch {}
  try { await conversation?.endSession(); } catch {}
  wake?.release?.(); wake = null;
  working(person, 'Saving the transcript…');
  try {
    // Server-side transcripts are authoritative; use them only if every part of the call came back.
    const parts = await Promise.all(convIds.map((id) => eleven.transcript(K.elevenKey, id)));
    const remote = parts.length && parts.every((p) => p?.length) ? parts.flat() : null;
    const t = remote || turns;
    if (!t.some((x) => x.role === 'user')) { show('home'); return say('No speech captured, nothing saved.', true); }
    const memoBase = await saveMemo({ vault, index, person, meetingDate: meetingDate || null, turns: t, origin: remote ? 'elevenlabs' : 'browser' });
    await Promise.all(convIds.map((id) => eleven.deleteConversation(K.elevenKey, id))); // memo is safe in the vault
    conversation = null;
    const text = (await vault.read(`${index.memoDir}/${memoBase}.md`)).text;
    begin({ person, formDate: meetingDate || null, memoBase, transcript: parseMemo(text).body });
  } catch (e) {
    finishing = false; $('end').disabled = false; show('live');
    say('Not saved: ' + e.message + ' Press End & save to retry; the transcript is still here.', true);
  }
}

async function resume(memoBase) {
  say('Loading…');
  try {
    const log = (await vault.read('log.md'))?.text ?? '';
    if (log.includes(`Voice Memos/${memoBase}`)) { say('Already processed.'); return enter(); }
    const m = parseMemo((await vault.read(`${index.memoDir}/${memoBase}.md`)).text);
    const name = m.person || prompt('Whose memo is this? Type the full name.');
    if (!name) return say('');
    say('');
    begin({ person: name, formDate: m.date, memoBase, transcript: m.body });
  } catch (e) { say(e.message, true); }
}

// ---------- sorting (with the graph at work) ----------
let workTimer = null;
function working(name, first) {
  clearInterval(workTimer);
  $('work-title').textContent = name;
  const nodes = mentions((job?.transcript || turns.filter((t) => t.role === 'user').map((t) => t.text).join(' ')), names).map((label) => ({ label, fresh: true }));
  drawGraph($('g-work'), { center: name, nodes, mode: 'working' });
  const lines = [first || 'Reading the transcript…', 'Checking what the note already says…', 'Matching your tags…', 'Working out the dates…', 'Building the preview…'];
  let i = 0; $('work-line').textContent = lines[0];
  workTimer = setInterval(() => { i = Math.min(i + 1, lines.length - 1); $('work-line').textContent = lines[i]; }, 3500);
  show('working');
}
const stopWorking = () => clearInterval(workTimer);

function begin(j) {
  job = { ...j, target: null, plan: null, linkedin: null };
  const { exact, candidates } = findCandidates(job.person, index.contacts);
  if (exact) { job.target = { file: exact, isNew: false }; return plan(); }
  if (!candidates.length) { job.target = { file: contactFile(job.person), isNew: true }; return plan(); }
  $('pick-title').textContent = `Is ${job.person} one of these?`;
  const btn = (label, fn, go) => Object.assign(document.createElement('button'), { className: go ? 'btn go' : 'btn', textContent: label, onclick: fn });
  $('pick-buttons').replaceChildren(
    ...candidates.map((f) => btn(f.replace(/^@ /, '').replace(/\.md$/, ''), () => { job.target = { file: f, isNew: false }; plan(); })),
    btn(`New person: ${job.person}`, () => { job.target = { file: contactFile(job.person), isNew: true }; plan(); }, true));
  show('pick');
}

async function plan(feedback) {
  working(job.person, feedback ? 'Applying your changes…' : null);
  try {
    if (!job.target.isNew && job.linkedinKept === undefined) {
      job.linkedinKept = existingLinkedIn((await vault.read(`${index.contactsDir}/${job.target.file}`).catch(() => null))?.text);
    }
    job.plan = await makePlan({ anthropicKey: K.anthropicKey, vault, index, person: job.person, formDate: job.formDate, transcript: job.transcript,
      existingFile: job.target.isNew ? null : job.target.file, previous: feedback ? job.plan : null, feedback });
    job.newDict = await newDictionaryEntries(vault, job.plan).catch(() => []);
    stopWorking(); render(); $('feedback').value = '';
  } catch (e) {
    stopWorking();
    if (job.plan) { render(); say(e.message, true); } else { show('home'); say(e.message + ' The transcript is saved; find it under "Waiting for your yes".', true); }
  }
}

function previewNodes(p) {
  const people = [...new Set([...p.private, ...p.business, ...p.followups.map((f) => f.text), p.connected_by || ''].join(' ').matchAll(/\[\[@ ([^\]|]+)/g))].map((m) => m[1]);
  return [...p.tags.map((t) => ({ label: t.name, fresh: !t.existing })), ...people.map((label) => ({ label }))].slice(0, 7);
}

// The preview as you will read it in Obsidian; the exact Markdown sits one tap below.
function richPreview(p) {
  const box = $('rich'); box.replaceChildren();
  const h = (t) => box.append(Object.assign(document.createElement('h2'), { textContent: t }));
  const textWithLinks = (node, text) => {            // [[@ Name|shown]] -> "shown" in lavender, like Obsidian
    let last = 0;
    for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
      node.append(text.slice(last, m.index), Object.assign(document.createElement('span'), { className: 'wl', textContent: m[2] || m[1].replace(/^@ /, '') }));
      last = m.index + m[0].length;
    }
    node.append(text.slice(last));
    return node;
  };
  const line = (t, cls = 'add') => box.append(textWithLinks(Object.assign(document.createElement('div'), { className: cls }), t));
  const task = (t, due, muted) => {
    const d = Object.assign(document.createElement('div'), { className: muted ? 'task muted' : 'task' });
    const s = textWithLinks(document.createElement('span'), t);
    if (due) s.append(' ', Object.assign(document.createElement('span'), { className: 'due', textContent: '· ' + new Date(due + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) }));
    d.append(Object.assign(document.createElement('span'), { className: 'box' }), s); box.append(d);
  };
  if (!p.meeting_date) line('⚠️ Meeting date missing: tell me below when you met.', 'add muted');
  if (p.connected_by) { h('Connected by'); line(p.connected_by); }
  if (p.private.length) { h('Private'); p.private.forEach((t) => line(t)); }
  if (p.business.length) { h('Business'); p.business.forEach((t) => line(t)); }
  if (p.meeting_date && p.interaction) { h('Interaction'); line(`${p.meeting_date} — ${p.interaction}`); }
  const cadence = job.target.isNew && p.meeting_date;
  if (p.followups.length || cadence) {
    h('Follow-up');
    p.followups.forEach((f) => task(`${f.owner === 'them' ? '(them) ' : ''}${f.text}`, f.due));
    if (cadence) {
      const today = todayZurich();
      [[1, '24h note'], [7, '7-day note'], [30, '1-month note']].forEach(([d, l]) => {
        const due = new Date(new Date(p.meeting_date + 'T12:00:00Z').getTime() + d * 864e5).toISOString().slice(0, 10);
        task(l, due < today ? today : due, true);
      });
    }
  }
  if (p.tags.length) {
    h('Tags');
    const wrap = document.createElement('div');
    p.tags.forEach((t) => wrap.append(Object.assign(document.createElement('span'), { className: t.existing ? 'tag' : 'tag new', textContent: t.name, title: t.why || '' })));
    box.append(wrap);
  }
  if (p.linkedin || p.linkedinKept) { h('LinkedIn'); line(p.linkedin || p.linkedinKept, 'add muted'); }
  if (p.open_questions.length) { h('Open questions'); p.open_questions.forEach((q) => line('⚠️ ' + q, 'add muted')); }
  if (p.left_out.length) { h('Left out'); p.left_out.forEach((q) => line(q, 'add muted')); }
}

function render() {
  const p = job.plan;
  p.linkedin = job.linkedin || null;
  p.linkedinKept = job.linkedinKept || '';
  $('rev-eyebrow').textContent = `${job.target.isNew ? 'New node' : 'Update'}${p.meeting_date ? ' · met ' + new Date(p.meeting_date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : ''}`;
  $('rev-title').textContent = job.person;
  drawGraph($('g-rev'), { center: null, nodes: previewNodes(p), mode: 'preview' });
  richPreview(p);
  $('preview').textContent = renderPreview(p, { person: job.person, file: job.target.file, isNew: job.target.isNew, memoBase: job.memoBase, today: todayZurich() });
  $('qbox').hidden = !p.questions.length;
  $('questions').replaceChildren(...p.questions.map((q) => Object.assign(document.createElement('li'), { textContent: q })));

  // extras: talking point and dictionary, ticked by default
  const extras = [];
  if (p.talking_point) extras.push({ id: 'x-tp', text: `Talking point: ${p.talking_point}` });
  (job.newDict || []).forEach((d, i) => extras.push({ id: 'x-d' + i, text: `Dictionary: ${d.term}${d.meaning ? ' — ' + d.meaning : ''}` }));
  $('extras').hidden = !extras.length;
  $('extra-list').replaceChildren(...extras.map((x) => {
    const lab = document.createElement('label'); lab.className = 'check'; lab.style.textTransform = 'none'; lab.style.letterSpacing = '0';
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', id: x.id, checked: job.ticks?.[x.id] ?? true });
    box.onchange = () => { job.ticks = { ...job.ticks, [x.id]: box.checked }; };
    lab.append(box, Object.assign(document.createElement('span'), { textContent: x.text, style: 'color:var(--text);font-size:.92rem' }));
    return lab;
  }));

  $('libox').hidden = Boolean(job.linkedinKept);
  $('li-find').href = linkedInSearchUrl(job.person);
  $('li-url').value = job.linkedin || '';
  const why = writeBlocker(p);
  $('write').disabled = Boolean(why); $('why').textContent = why || '';
  say(''); show('review');
}
$('li-url').oninput = () => {
  const raw = $('li-url').value.trim();
  const url = raw ? cleanLinkedIn(raw) : null;
  if (raw && !url) { $('li-msg').textContent = 'That is not a profile link (it should contain linkedin.com/in/…).'; $('li-msg').className = 'hint err'; return; }
  job.linkedin = url; $('li-msg').textContent = url ? `Will write: ${url}` : ''; $('li-msg').className = 'hint';
  const keep = $('feedback').value; render(); $('feedback').value = keep;
};
$('revise').onclick = () => { const f = $('feedback').value.trim(); if (f) plan(f); };
$('cancel').onclick = () => { job = null; enter().then(() => say('Cancelled. The transcript stays saved under "Waiting for your yes".')); };
$('write').onclick = async () => {
  $('write').disabled = $('revise').disabled = true; say('Writing to your vault…');
  const ticked = (id) => document.getElementById(id)?.checked;
  try {
    await applyPlan({ vault, index, person: job.person, plan: job.plan, memoBase: job.memoBase, target: job.target,
      extras: { talkingPoint: ticked('x-tp'), dictionary: (job.newDict || []).filter((_, i) => ticked('x-d' + i)) } });
    const w = job.target.warnings?.length ? ' ' + job.target.warnings.join(' ') : '';
    const url = `https://github.com/${K.repo}/blob/main/${[index.contactsDir, job.target.file].map(encodeURIComponent).join('/')}`;
    drawGraph($('g-done'), { center: job.person, nodes: previewNodes(job.plan), mode: 'preview' });
    $('done-title').textContent = `${job.person} is in your vault`;
    $('done-body').replaceChildren(
      `${job.target.isNew ? 'New contact' : 'Contact updated'}, memo and log committed. Obsidian on the Mac shows it after its next sync. `,
      Object.assign(document.createElement('a'), { href: url, target: '_blank', rel: 'noopener', textContent: 'Open on GitHub', style: 'color:var(--soft)' }),
      w);
    say(''); show('done'); job = null;
  } catch (e) { say(e.message, true); }
  finally { $('write').disabled = $('revise').disabled = false; }
};
$('done-next').onclick = () => { $('person').value = ''; $('date').value = ''; history.replaceState(null, '', location.pathname); enter(); };

boot();
