/**
 * Live work (§166): two people editing the same to-do.
 *
 * A save carries only the fields this person changed, and the version they
 * started from. When the row moved meanwhile, the server refuses and hands
 * back the row as it is now; this decides, field by field, what can be kept
 * without asking: what only I changed goes in, what only they changed stays
 * theirs, and only a field we both changed — to different values — is a
 * question for a person.
 */

/** Same value for the form's purposes: a list, a number, a date string or empty all compare by what they say. */
export const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The fields of `mine` that differ from `base` — what a save sends. */
export function changedKeys<T extends object>(base: T, mine: T): (keyof T)[] {
  return (Object.keys(mine) as (keyof T)[]).filter(k => !same(base[k], mine[k]));
}

export interface Clash<T> { key: keyof T; base: T[keyof T]; mine: T[keyof T]; theirs: T[keyof T] }

export interface Merge<T> {
  /** My changes that collide with nothing — safe to send again on top of their version. */
  keep: Partial<T>;
  /** Fields we both changed, to different values: the person picks. */
  clashes: Clash<T>[];
  /** Fields only they changed — the form takes these, so it shows the row as it is now. */
  theirs: (keyof T)[];
}

/** Three-way: what I started from, what I have, what is saved now. */
export function merge3<T extends object>(base: T, mine: T, theirs: T): Merge<T> {
  const keep: Partial<T> = {};
  const clashes: Clash<T>[] = [];
  const took: (keyof T)[] = [];
  const keys = new Set<keyof T>([...Object.keys(base), ...Object.keys(mine)] as (keyof T)[]);
  for (const k of keys) {
    const iChanged = !same(base[k], mine[k]);
    const theyChanged = !same(base[k], theirs[k]);
    if (iChanged && !theyChanged) keep[k] = mine[k];
    else if (theyChanged && !iChanged) took.push(k);
    // Both changed it the same way: nothing to send, nothing to ask.
    else if (iChanged && theyChanged && !same(mine[k], theirs[k])) clashes.push({ key: k, base: base[k], mine: mine[k], theirs: theirs[k] });
  }
  return { keep, clashes, theirs: took };
}

/** The form after a merge: their row, my kept changes on top, and each clash as the person chose (default: mine). */
export function resolve<T extends object>(theirs: T, m: Merge<T>, pick: Partial<Record<keyof T, 'mine' | 'theirs'>> = {}): T {
  const out = { ...theirs, ...m.keep };
  for (const c of m.clashes) out[c.key] = (pick[c.key] ?? 'mine') === 'mine' ? c.mine : c.theirs;
  return out;
}
