/**
 * The cost categories, one list for the Costs screen and Slack (§117), and
 * the guess from a few words. Category is bookkeeping: guessed, then shown
 * for a person to confirm.
 */
export const COST_CATEGORIES = ['Lease', 'Electricity', 'Gas', 'Water', 'Internet', 'Cleaning',
  'Restock', 'Handyman', 'Repairs', 'Software', 'Insurance', 'General'];

/** The category the words name, or `fallback` when they name none. */
export function guessCategory(label: string, fallback: string | null = 'General'): string | null {
  const l = label.toLowerCase();
  const hit = COST_CATEGORIES.find(c => l.includes(c.toLowerCase()));
  if (hit) return hit;
  if (/rent|mortgage|hoa/.test(l)) return 'Lease';
  if (/wifi|cable|phone/.test(l)) return 'Internet';
  if (/pool|lawn|yard|pest|garden/.test(l)) return 'Handyman';
  if (/power|electric/.test(l)) return 'Electricity';
  if (/towel|sheet|soap|paper|supplies|coffee|amazon|walmart|costco/.test(l)) return 'Restock';
  return fallback;
}

/** "$45.50 towels P2-4308" → 45.5; the first money-looking number, or null. */
export function amountIn(text: string): number | null {
  const m = text.replace(/,(?=\d{3}\b)/g, '').match(/\$\s?(\d+(?:\.\d{1,2})?)|(?:^|\s)(\d+(?:\.\d{1,2})?)(?=\s|$)/);
  const n = m ? Number(m[1] ?? m[2]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
