// Pure functions: turn a plan (what Claude extracted) into exact file edits. No network, no DOM,
// so the tests can run them in Node. The model never writes vault files: it only fills the plan,
// and this code applies it with the skill's rules (append only, never edit an existing line).
import { safeName, yamlScalar } from './memo.mjs';

export const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const todayZurich = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' });
export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Date table the model reads instead of doing arithmetic. */
export function calendar(fromIso, toIso) {
  const out = [];
  for (let d = fromIso; d <= toIso && out.length < 200; d = addDays(d, 1)) {
    out.push(`${d} ${new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}`);
  }
  return out.join('\n');
}

/** Why "Yes" is disabled, in words. null = ready to write. */
export function writeBlocker(plan) {
  if (plan.questions.length) return 'Answer the question(s) above first, in the box.';
  if (!plan.meeting_date) return 'The meeting date is missing: type it in the box (e.g. "we met on 30 October").';
  if (!plan.interaction) return 'Nothing new to write: everything in this memo is already in the contact. Use Cancel.';
  return null;
}

/**
 * A pasted LinkedIn link -> the clean profile URL the skill writes, or null if it is not a profile link.
 * The app's "Copy link" adds tracking (?utm_source=share&...); a profile is linkedin.com/in/<public-id>.
 */
export function cleanLinkedIn(raw) {
  try {
    const u = new URL(String(raw).trim().replace(/^(?!https?:\/\/)/, 'https://'));
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
    const m = /^\/in\/([^/?#]+)/i.exec(u.pathname);
    return m ? `https://www.linkedin.com/in/${decodeURIComponent(m[1])}` : null;
  } catch { return null; }
}
export const linkedInSearchUrl = (person) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(person)}`;
/** The URL already in a contact's LinkedIn:: field, or '' if the field is empty or missing. */
export const existingLinkedIn = (text) => (/^\s*-?\s*LinkedIn::[ \t]*(\S*)/m.exec(text || '')?.[1] || '');

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/^[-*•]\s*/, '').trim();
const BAD_TAG = /[|/\\:*?"<>#^[\]]/g;
const GENERIC = /^(untitled|untitled \d+|new note)$/i;

export function extractJson(text) {
  const s = String(text);
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('No JSON in the answer');
  return JSON.parse(s.slice(a, b + 1));
}

/** Coerce whatever the model returned into a plan the rest of the code can trust. */
export function normalizePlan(raw) {
  const strs = (a) => (Array.isArray(a) ? a.map(oneLine).filter(Boolean) : []);
  return {
    meeting_date: ISO.test(raw.meeting_date || '') ? raw.meeting_date : null,
    connected_by: oneLine(raw.connected_by) || null,
    private: strs(raw.private),
    business: strs(raw.business),
    followups: (Array.isArray(raw.followups) ? raw.followups : [])
      .map((f) => ({ owner: f?.owner === 'them' ? 'them' : 'me', text: oneLine(f?.text), due: ISO.test(f?.due || '') ? f.due : null }))
      .filter((f) => f.text),
    interaction: oneLine(raw.interaction),
    tags: (Array.isArray(raw.tags) ? raw.tags : [])
      .map((t) => ({ name: oneLine(t?.name).replace(BAD_TAG, '').trim(), existing: Boolean(t?.existing), why: oneLine(t?.why) }))
      .filter((t) => t.name && !GENERIC.test(t.name))
      .slice(0, 6),
    open_questions: strs(raw.open_questions),
    left_out: strs(raw.left_out),
    questions: strs(raw.questions).slice(0, 5),
  };
}

// ---------- contact lookup ----------
export const contactFile = (person) => `@ ${safeName(person)}.md`;

/** Exact file, else same first or last name. Never merges silently: the page asks. */
export function findCandidates(person, contactFiles) {
  const want = contactFile(person).toLowerCase();
  const exact = contactFiles.find((f) => f.toLowerCase() === want);
  if (exact) return { exact, candidates: [] };
  const parts = person.toLowerCase().split(/\s+/).filter((p) => p.length > 1);
  const first = parts[0], last = parts.length > 1 ? parts[parts.length - 1] : null;
  const candidates = contactFiles.filter((f) => {
    const toks = f.replace(/^@ /, '').replace(/\.md$/, '').toLowerCase().split(/\s+/);
    return toks.includes(first) || (last && toks.includes(last));
  });
  return { exact: null, candidates: candidates.slice(0, 6) };
}

// ---------- editing an existing contact ----------
const TOP = /^(\*\*[^*].*\*\*\s*|#{1,6}\s.*)$/; // **Heading:** or ## Heading
const INTERACTIONS = /^(\*\*Interactions.*\*\*\s*|#{1,6}\s*Interactions.*)$/i;
const FOLLOWUP = /^(\*\*Follow-?up:?\*\*\s*|#{1,6}\s*Follow-?up.*)$/i;
const PRIVATE = /^\s*(?:-\s*)?\*Private:?\*:?\s*$/;
const BUSINESS = /^\s*(?:-\s*)?\*Business:?\*:?\s*$/;
const emptyBullet = (l) => /^\s*-\s*$/.test(l);

function blockEnd(lines, start, stopRe) {
  let end = start + 1;
  for (let i = start + 1; i < lines.length; i++) {
    if (TOP.test(lines[i]) || (stopRe && stopRe.test(lines[i]))) break;
    if (lines[i].trim() !== '') end = i + 1;
  }
  return end;
}

/** Add bullets at the end of a block; reuse a trailing empty placeholder bullet instead of leaving it. */
function appendToBlock(lines, start, bullets, stopRe) {
  const have = new Set(lines.map((l) => l.trim()));
  const fresh = bullets.filter((b) => !have.has(b.trim())); // idempotent: a retry never duplicates
  if (!fresh.length) return;
  let end = blockEnd(lines, start, stopRe);
  if (end - 1 > start && emptyBullet(lines[end - 1])) { lines.splice(end - 1, 1); end--; }
  lines.splice(end, 0, ...fresh);
}

export const fuTask = (f) => `- [ ] (${f.owner}) ${f.text}${f.due ? ` [due:: ${f.due}]` : ''}`;
export const interactionLine = (plan, memoBase) => `- ${plan.meeting_date} — ${plan.interaction} ([[${memoBase}]])`;

export function patchContact(text, plan, { memoBase, today }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const warnings = [];
  const priv = plan.private.map((t) => `\t- ${t}`);
  const biz = plan.business.map((t) => `\t- ${t}`);

  const pi = lines.findIndex((l) => PRIVATE.test(l));
  const bi = lines.findIndex((l) => BUSINESS.test(l));
  if (pi >= 0 && bi >= 0) {
    // Business first: inserting there does not shift the earlier Private index.
    if (bi > pi) { if (biz.length) appendToBlock(lines, bi, biz); if (priv.length) appendToBlock(lines, pi, priv, BUSINESS); }
    else { if (priv.length) appendToBlock(lines, pi, priv); if (biz.length) appendToBlock(lines, bi, biz, PRIVATE); }
  } else if (priv.length || biz.length) {
    lines.push('', '**Background:**', '- *Private:*', ...(priv.length ? priv : ['\t- ']), '- *Business:*', ...(biz.length ? biz : ['\t- ']));
    warnings.push('The contact had no Private/Business sections; added a Background block at the end.');
  }

  const line = interactionLine(plan, memoBase);
  const ii = lines.findIndex((l) => INTERACTIONS.test(l));
  if (ii >= 0) appendToBlock(lines, ii, [line]);
  else lines.push('', '**Interactions (meetings, events, etc)**', line);

  if (plan.followups.length) {
    const fi = lines.findIndex((l) => FOLLOWUP.test(l));
    const tasks = plan.followups.map(fuTask);
    if (fi >= 0) {
      const have = new Set(lines.map((l) => l.trim()));
      lines.splice(fi + 1, 0, ...tasks.filter((t) => !have.has(t.trim()))); // new to-dos go on top
    } else lines.push('', '**Follow-up:**', ...tasks);
  }

  if (plan.linkedin) {
    const li = lines.findIndex((l) => /^\s*-?\s*LinkedIn::/.test(l));
    if (li < 0) warnings.push('The contact has no LinkedIn:: line; link not added.');
    else if (/LinkedIn::\s*$/.test(lines[li])) lines[li] = lines[li].replace(/\s*$/, ' ') + plan.linkedin;
    else if (!lines[li].includes(plan.linkedin)) warnings.push('The contact already has a different LinkedIn link; left it as it was.');
  }

  const ti = lines.findIndex((l) => /^Tags::/.test(l));
  if (plan.tags.length) {
    if (ti >= 0) {
      const present = new Set([...lines[ti].matchAll(/\[\[([^\]|]+)/g)].map((m) => m[1].toLowerCase()));
      const add = plan.tags.filter((t) => !present.has(t.name.toLowerCase())).map((t) => `[[${t.name}]]`);
      if (add.length) lines[ti] = lines[ti].replace(/\s+$/, '') + (/\]\]\s*$/.test(lines[ti]) ? ', ' : ' ') + add.join(', ');
    } else warnings.push('The contact has no Tags:: line; tags not added.');
  }

  // Frontmatter "Last modified" is the one existing line we may change.
  const end = lines.indexOf('---', 1);
  const lm = lines.findIndex((l, i) => i < (end > 0 ? end : 12) && /^Last modified:/.test(l));
  if (lm >= 0) lines[lm] = `Last modified: ${today}`;
  return { text: lines.join('\n'), warnings };
}

// ---------- new contact ----------
export function renderNewContact(person, plan, { memoBase, today }) {
  const cadence = [[1, '24h'], [7, '7-day'], [30, '1-month']].map(([d, label]) => {
    const due = addDays(plan.meeting_date, d);
    return `- [ ] ${label} note [due:: ${due < today ? today : due}]`; // a date already past becomes today
  });
  const bullets = (a) => (a.length ? a.map((t) => `\t- ${t}`) : ['\t- ']);
  return [
    '---',
    `aliases: [${yamlScalar(person)}]`,
    `Creation date: ${today}`,
    `Last modified: ${today}`,
    'Type: "#contact"',
    'created_by: voice-contact-debrief',
    '---',
    `ConnectedBy:: ${plan.connected_by || ''}`.trimEnd() + (plan.connected_by ? '' : ' '),
    `Tags:: ${plan.tags.map((t) => `[[${t.name}]]`).join(', ')}`.trimEnd() + (plan.tags.length ? '' : ' '),
    '',
    'Related links::',
    '- ',
    '-----',
    '**Basic Information:**',
    `- LinkedIn:: ${plan.linkedin || ''}`,
    '- Email:: ',
    '',
    '**Background:**',
    '- *Private:*',
    ...bullets(plan.private),
    '- *Business:*',
    ...bullets(plan.business),
    '',
    '**Interactions (meetings, events, etc)**',
    interactionLine(plan, memoBase),
    '',
    '**Follow-up:**',
    ...plan.followups.map(fuTask),
    ...cadence,
    '',
  ].join('\n');
}

// ---------- log.md ----------
export function appendLog(text, { today, memoBase, person, isNew }) {
  const entry = `## [${today}] ingest | Voice Memos/${memoBase} → [[@ ${person}]]\n- ${isNew ? 'New' : 'Updated'}: [[@ ${person}]]\n`;
  return text.replace(/\s*$/, '\n') + '\n' + entry;
}

// ---------- preview ----------
const linkedInLine = (plan, isNew) =>
  plan.linkedin ? `LinkedIn: ${plan.linkedin}` : plan.linkedinKept ? `LinkedIn: already in the note (${plan.linkedinKept})` : 'LinkedIn: none yet. Use "Find on LinkedIn" below, or leave it empty.';

export function renderPreview(plan, { person, file, isNew, memoBase, today }) {
  const out = [];
  out.push(`Target: ${isNew ? 'new contact' : 'append to'} ${file}`, `Raw memo (already saved): ${memoBase}.md`, '');
  if (isNew && plan.meeting_date && plan.interaction) {
    // A new contact is shown exactly as it will be written: template layout, dates and all.
    out.push('The new note, exactly as it will be written:', '', renderNewContact(person, plan, { memoBase, today }).trim(), '');
    const tagsWhy = plan.tags.map((t) => `${t.name} (${t.existing ? 'existing' : 'new'}${t.why ? `: ${t.why}` : ''})`);
    if (tagsWhy.length) out.push('Why these tags:', ...tagsWhy.map((t) => `  ${t}`), '');
    if (plan.open_questions.length) out.push('Open questions:', ...plan.open_questions.map((q) => `  ⚠️ ${q}`), '');
    if (plan.left_out.length) out.push('Left out:', ...plan.left_out.map((q) => `  ${q}`), '');
    out.push(linkedInLine(plan, isNew));
    return out.join('\n').trim();
  }
  if (!plan.meeting_date) out.push('⚠️ Meeting date missing: tell me when you met, then I can build the lines.', '');
  const section = (title, items) => items.length && out.push(title, ...items.map((i) => `  ${i}`), '');
  if (plan.connected_by) out.push(`ConnectedBy: ${plan.connected_by}`, '');
  section('Private:', plan.private.map((t) => `- ${t}`));
  section('Business:', plan.business.map((t) => `- ${t}`));
  section('Follow-up (top of the list):', plan.followups.map(fuTask));
  if (isNew && plan.meeting_date) {
    out.push('Follow-up cadence (new contact):', ...[[1, '24h'], [7, '7-day'], [30, '1-month']].map(([d, l]) => {
      const due = addDays(plan.meeting_date, d);
      return `  - [ ] ${l} note [due:: ${due < today ? today : due}]`;
    }), '');
  }
  if (plan.meeting_date && plan.interaction) out.push('Interactions:', `  ${interactionLine(plan, memoBase)}`, '');
  section('Tags:', plan.tags.map((t) => `${t.name} (${t.existing ? 'existing' : 'new'}${t.why ? `: ${t.why}` : ''})`));
  section('Open questions:', plan.open_questions.map((q) => `⚠️ ${q}`));
  section('Left out:', plan.left_out);
  out.push(linkedInLine(plan, isNew));
  return out.join('\n').trim();
}

// ---------- memos ----------
export const unprocessedMemos = (memoBasenames, logText) => memoBasenames.filter((b) => !logText.includes(b)).sort().reverse();

export function parseMemo(text) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] || '';
  const get = (k) => (new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm)?.[1] || '').trim().replace(/^"|"$/g, '');
  const date = get('date');
  return { person: get('person'), date: ISO.test(date) ? date : null, body: text.replace(/^---\n[\s\S]*?\n---\n?/, '').trim() };
}
