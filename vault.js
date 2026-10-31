// The vault is a GitHub repo. This is the only code that talks to it.
// Rules it enforces: create never overwrites; update needs the sha we read (GitHub refuses a stale one);
// errors never contain the token.
const API = 'https://api.github.com';

const toBase64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
const enc = (path) => path.split('/').map(encodeURIComponent).join('/');

export class Vault {
  constructor({ token, repo, branch = 'main', fetchFn = (...a) => fetch(...a) }) {
    Object.assign(this, { token, repo, branch, fetchFn });
  }

  async api(path, init = {}) {
    const res = await this.fetchFn(API + path, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', ...(init.body && { 'content-type': 'application/json' }) },
    });
    if (res.status === 404) return null;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`GitHub ${res.status}: ${body.message || 'error'}`), { status: res.status });
    return body;
  }

  /** All file paths on the branch in one call. */
  async tree() {
    const t = await this.api(`/repos/${this.repo}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`);
    if (!t) throw new Error('Repo or branch not found (check the repo name and the token)');
    if (t.truncated) throw new Error('Vault tree too large for one call');
    return t.tree.filter((e) => e.type === 'blob').map((e) => e.path);
  }

  async read(path) {
    const f = await this.api(`/repos/${this.repo}/contents/${enc(path)}?ref=${encodeURIComponent(this.branch)}`);
    if (!f) return null;
    let content = f.content;
    if (!content && f.size > 0) content = (await this.api(`/repos/${this.repo}/git/blobs/${f.sha}`)).content; // files over 1 MB
    return { text: fromBase64(content || ''), sha: f.sha };
  }

  /** New file only. Returns false if the path already exists. */
  async create(path, text, message) {
    try {
      await this.api(`/repos/${this.repo}/contents/${enc(path)}`, { method: 'PUT', body: JSON.stringify({ message, content: toBase64(text), branch: this.branch }) });
      return true;
    } catch (e) {
      if (e.status === 422 || e.status === 409) return false;
      throw e;
    }
  }

  /** Read, transform, write back. If someone else (Obsidian Git) pushed in between, GitHub rejects the stale sha and we re-read. */
  async modify(path, fn, message) {
    for (let i = 0; i < 4; i++) {
      const cur = await this.read(path);
      const next = fn(cur?.text ?? null);
      if (next === null || next === (cur?.text ?? null)) return false;
      try {
        await this.api(`/repos/${this.repo}/contents/${enc(path)}`, {
          method: 'PUT',
          body: JSON.stringify({ message, content: toBase64(next), branch: this.branch, ...(cur && { sha: cur.sha }) }),
        });
        return true;
      } catch (e) {
        if (e.status !== 409 && e.status !== 422) throw e;
      }
    }
    throw new Error(`Could not update ${path}: it keeps changing (Obsidian sync?). Try again in a minute.`);
  }
}
