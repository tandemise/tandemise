/**
 * Tracker item references (spec §Data model, "item_ref"): `<tracker>:<key>`,
 * for example `youtrack:ACME-123` or `github:acme/app#7`. The daemon and the
 * relay both normalise through here, so they always agree on what "the same
 * item" is. #52 adds the other trackers.
 */

/** A GitHub issue: `github:<owner/repo lowercased>#<number>`. */
export function githubItemRef(repo: string, number: number): string {
  return `github:${repo.trim().toLowerCase()}#${number}`;
}

/**
 * Trims, lowercases the tracker, and keeps the key's case, except for GitHub,
 * whose `owner/repo` is case-insensitive and so is lowercased too.
 */
export function normalizeItemRef(raw: string): string {
  const s = raw.trim();
  const at = s.indexOf(':');
  if (at <= 0 || at === s.length - 1) throw new Error(`Not a tracker item: ${raw}`);
  const tracker = s.slice(0, at).trim().toLowerCase();
  let key = s.slice(at + 1).trim();
  if (!key) throw new Error(`Not a tracker item: ${raw}`);
  if (tracker === 'github') {
    const hash = key.lastIndexOf('#');
    if (hash > 0) key = `${key.slice(0, hash).toLowerCase()}${key.slice(hash)}`;
    else key = key.toLowerCase();
  }
  return `${tracker}:${key}`;
}

/** The display form: `ACME-123`, `acme/app#7`. */
export function itemKey(ref: string): string {
  const at = ref.indexOf(':');
  return at < 0 ? ref : ref.slice(at + 1);
}
