// Today's meetings from Google Calendar, so "who did you just meet?" is one tap.
// Google sign-in (Google Identity Services) gives the page a read-only token for one hour. The token
// stays in this tab's session storage; nothing is stored on any server. Client ID is not a secret.
const SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const TOKEN_KEY = 'debrief.gcal.token';
let gisLoaded = null;

function loadGis() {
  gisLoaded ??= new Promise((res, rej) => {
    const s = Object.assign(document.createElement('script'), { src: 'https://accounts.google.com/gsi/client', async: true });
    s.onload = res; s.onerror = () => rej(new Error('Could not load Google sign-in.'));
    document.head.append(s);
  });
  return gisLoaded;
}

export function cachedToken() {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY));
    return t && t.exp > Date.now() + 60e3 ? t.token : null;
  } catch { return null; }
}

/** Needs a tap (Safari only opens the Google window after a user gesture). */
export async function signIn(clientId, { first } = {}) {
  await loadGis();
  return new Promise((res, rej) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) return rej(new Error(`Google: ${r.error_description || r.error}`));
        sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 }));
        res(r.access_token);
      },
      error_callback: (e) => rej(new Error(e?.type === 'popup_closed' ? 'Google sign-in closed.' : 'Google sign-in failed.')),
    });
    client.requestAccessToken({ prompt: first ? 'consent' : '' });
  });
}

export const forgetToken = () => sessionStorage.removeItem(TOKEN_KEY);

/** Meetings from yesterday morning until an hour from now, with the other attendees' names. */
export async function recentMeetings(token, { fetchFn = (...a) => fetch(...a), now = new Date() } = {}) {
  const start = new Date(now); start.setDate(start.getDate() - 1); start.setHours(0, 0, 0, 0);
  const end = new Date(now.getTime() + 3600e3);
  const q = new URLSearchParams({ timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50' });
  const res = await fetchFn(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) { forgetToken(); throw Object.assign(new Error('Google sign-in expired.'), { status: 401 }); }
  if (!res.ok) throw new Error(`Google Calendar ${res.status}`);
  const body = await res.json();
  return (body.items || [])
    .filter((e) => e.status !== 'cancelled' && e.start?.dateTime)               // all-day blocks are not meetings
    .map((e) => ({
      title: e.summary || '(no title)',
      start: e.start.dateTime,
      date: e.start.dateTime.slice(0, 10),
      people: (e.attendees || [])
        .filter((a) => !a.self && !a.resource && a.responseStatus !== 'declined')
        .map((a) => a.displayName || nameFromEmail(a.email))
        .filter(Boolean),
    }))
    .reverse(); // most recent first
}

/** "ada.testerin@x.org" -> "Ada Testerin". A guess, shown for you to correct in the name field. */
export function nameFromEmail(email) {
  const local = String(email || '').split('@')[0];
  if (!/[._-]/.test(local)) return '';
  return local.split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}
