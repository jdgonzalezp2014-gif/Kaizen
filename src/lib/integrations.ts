/**
 * Integrations (platform, 2026-11-15): every outside service an account connects, in one list at the top of
 * Settings. Kaizen OS is meant to be sold to other hosts (docs/product.md), so each company brings its own
 * accounts — Hostaway, Stripe, Slack… — set here, never in code or env files. Pure: states from the account flags.
 */
export type IntegrationState = 'on' | 'off' | 'later';
export interface Integration { key: string; name: string; does: string; state: IntegrationState; required: boolean }

export interface IntegrationFlags {
  hasHostawayKey: boolean; hasStripeKey: boolean; hasGeminiKey: boolean; hasClaudeKey: boolean; hasQuoKey: boolean;
  slack?: boolean | null; drive?: boolean | null;
  /** Guest Services → Inbox: the reply AI is on, or Kaizen really sends to guests (2026-11-16). */
  guestAi?: boolean | null;
}

export function integrations(a: IntegrationFlags): Integration[] {
  const on = (v: boolean | null | undefined): IntegrationState => (v ? 'on' : 'off');
  return [
    { key: 'hostaway', name: 'Hostaway', does: 'Listings, reservations, calendar, door codes, guest messages', state: on(a.hasHostawayKey), required: true },
    { key: 'stripe', name: 'Stripe', does: 'Guest payments (damage waiver, deposits, extras) and vendor payouts', state: on(a.hasStripeKey), required: false },
    { key: 'slack', name: 'Slack', does: 'Team alerts, daily messages, approvals', state: on(a.slack), required: false },
    { key: 'drive', name: 'Google Drive', does: 'Repository files and check-in photos', state: on(a.drive), required: false },
    { key: 'ai', name: 'AI — Gemini & Claude', does: 'Price suggestions, market reading, drafts; guest replies next', state: on(a.hasGeminiKey || a.hasClaudeKey), required: false },
    { key: 'quo', name: 'Quo', does: 'SMS alerts to the team, and texts with guests in the Inbox', state: on(a.hasQuoKey), required: false },
    { key: 'guestai', name: 'Guest messages & AI', does: 'Inbox: sending to guests (staged until turned on), the reply AI and its model, the portal address', state: on(a.guestAi), required: false },
    { key: 'identity', name: 'Identity verification', does: 'Guest ID + selfie at check-in (Truvi or Stripe Identity — not chosen yet)', state: 'later', required: false },
  ];
}
