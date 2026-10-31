// The workflow steps without any UI, so tests can run the whole thing against fake services.
import { memoBaseName, renderMemo } from './memo.mjs';
import { callClaude } from './anthropic.js';
import { SYSTEM, buildUser } from './process-prompt.js';
import { addDays, appendLog, calendar, extractJson, normalizePlan, patchContact, renderNewContact, todayZurich, unprocessedMemos } from './lib.js';

const DICT = '.claude/skills/voice-contact-debrief/dictionary.md';
const base = (p) => p.split('/').pop().replace(/\.md$/, '');

export async function loadIndex(vault) {
  const paths = await vault.tree();
  const topDir = (re) => paths.filter((p) => p.includes('/')).map((p) => p.split('/')[0]).find((d) => re.test(d));
  const contactsDir = topDir(/^06_/), filesDir = topDir(/^02_/);
  if (!contactsDir || !filesDir) throw new Error('This does not look like the Brainforest vault (folders 02_ and 06_ missing)');
  const memoDir = `${filesDir}/Voice Memos`;
  const under = (dir) => paths.filter((p) => p.startsWith(dir + '/') && p.endsWith('.md'));
  const log = (await vault.read('log.md'))?.text ?? '';
  return {
    contactsDir, memoDir, log,
    contacts: under(contactsDir).map((p) => p.split('/').pop()).filter((f) => f.startsWith('@ ')),
    memos: under(memoDir).map(base),
    notes: paths.filter((p) => /^0[13]_/.test(p) && p.endsWith('.md')).map(base).filter((n) => !n.startsWith('@ ')).slice(0, 2500),
  };
}

export const unprocessed = (index) => unprocessedMemos(index.memos, index.log).slice(0, 10);

/** The raw transcript goes into the vault first, before any processing, so nothing said is ever lost. */
export async function saveMemo({ vault, index, person, meetingDate, turns, origin }) {
  const name = memoBaseName(person, meetingDate);
  const content = renderMemo({ person, meetingDate, turns, origin });
  for (let n = 1; n < 20; n++) {
    const b = `${name}${n === 1 ? '' : ` (${n})`}`;
    if (await vault.create(`${index.memoDir}/${b}.md`, content, `voice-debrief: ${person}`)) return b;
  }
  throw new Error('Too many memos with the same name');
}

export async function makePlan({ anthropicKey, vault, index, person, formDate, transcript, existingFile, previous, feedback, fetchFn }) {
  const existing = existingFile ? (await vault.read(`${index.contactsDir}/${existingFile}`))?.text : null;
  const dictionary = (await vault.read(DICT))?.text ?? '';
  const today = todayZurich();
  const start = addDays(formDate && formDate < today ? formDate : today, -30);
  const user = buildUser({ calendar: calendar(start, addDays(today, 120)), person, today, formDate, transcript, existing, dictionary, notes: index.notes, previous, feedback });
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const text = await callClaude({ apiKey: anthropicKey, system: SYSTEM, user: i ? user + '\n\nReturn ONLY the JSON object.' : user, fetchFn });
      return normalizePlan(extractJson(text));
    } catch (e) { lastErr = e; if (!/JSON/.test(e.message)) throw e; }
  }
  throw lastErr;
}

export async function applyPlan({ vault, index, person, plan, memoBase, target }) {
  if (!plan.meeting_date || !plan.interaction) throw new Error('Meeting date or interaction line missing');
  const today = todayZurich();
  const path = `${index.contactsDir}/${target.file}`;
  const message = `voice-debrief: ${person}`;
  if (target.isNew) {
    const ok = await vault.create(path, renderNewContact(person, plan, { memoBase, today }), message);
    if (!ok) throw new Error('A contact with this name exists now. Reload and pick the existing one.');
  } else {
    let warnings = [];
    const changed = await vault.modify(path, (t) => {
      if (t === null) throw new Error('The contact file disappeared');
      const r = patchContact(t, plan, { memoBase, today });
      warnings = r.warnings;
      return r.text;
    }, message);
    target.warnings = warnings;
    target.changed = changed;
  }
  // log.md last: it is what marks the memo as processed, so a half-finished run can be retried.
  await vault.modify('log.md', (t) => (t === null || t.includes(`Voice Memos/${memoBase}`) ? null : appendLog(t, { today, memoBase, person, isNew: target.isNew })), message);
}
