import { useEffect, useState } from 'react';

/**
 * Whether the screen is a phone's (§80) — for the few places where a phone
 * needs a different interaction, not just a narrower layout: a grid that
 * edits on tap becomes a list that opens on tap. Layout alone stays in CSS.
 */
export function usePhone(maxWidth = 720): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setPhone(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return phone;
}
