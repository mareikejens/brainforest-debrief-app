// Memo helpers for the debrief app (app/), kept here so Node tests and the browser share them,
// so both produce byte-identical memos. No Node-only imports: this file also runs in the browser.

export const httpError = (status, message) => Object.assign(new Error(message), { status });

export const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' }); // YYYY-MM-DD

/** Filename rules from the vault's CLAUDE.md: | / : become a dash, the other forbidden chars are dropped. */
export function safeName(s) {
  return s.replace(/[|/:]/g, '-').replace(/[\\*?"<>#^[\]]/g, '').replace(/\s+/g, ' ').trim();
}

export function cleanPerson(raw) {
  const p = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!p || p.length > 80) throw httpError(400, 'Name missing or longer than 80 characters');
  return p;
}

export function cleanDate(raw) {
  if (!raw) return null; // not given: the interviewer asks, the memo records "unknown"
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw)) || Number.isNaN(Date.parse(raw))) throw httpError(400, 'Meeting date must be YYYY-MM-DD');
  return raw;
}

/** Plain scalar when safe (matches existing memos), double-quoted when a name would break YAML. */
export const yamlScalar = (s) => (/^[\p{L}\p{N}][\p{L}\p{N} .'’-]*$/u.test(s) && !/:\s|\s#/.test(s) ? s : JSON.stringify(s));

export const memoBaseName = (person, meetingDate) => `${meetingDate ?? today()} ${safeName(person)} debrief`;

export function renderMemo({ person, meetingDate, turns, origin }) {
  const body = turns.map((t) => `**${t.role === 'user' ? 'Mareike' : 'Interviewer'}:** ${t.text.trim()}`).join('\n\n');
  return `---
type: voice-debrief
date: ${meetingDate ?? 'unknown'}
debrief_date: ${today()}
person: ${yamlScalar(person)}
source: voice session (live interview)
transcript_origin: ${origin}
---

> Live voice session: the dictation and the interview are one transcript. Speech-to-text is uncorrected. Turns starting with "(typed)" are spellings Mareike typed and are authoritative. Not yet processed: run voice-contact-debrief, it picks this memo up.

## Transcript

${body}
`;
}
