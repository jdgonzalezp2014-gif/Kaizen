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
}

export function integrations(a: IntegrationFlags): Integration[] {
  const on = (v: boolean | null | undefined): IntegrationState => (v ? 'on' : 'off');
  return [
    { key: 'hostaway', name: 'Hostaway', does: 'Listings, reservations, calendar, door codes, guest messages', state: on(a.hasHostawayKey), required: true },
    { key: 'stripe', name: 'Stripe', does: 'Guest payments (damage waiver, deposits, extras) and vendor payouts', state: on(a.hasStripeKey), required: false },
    { key: 'slack', name: 'Slack', does: 'Team alerts, daily messages, approvals', state: on(a.slack), required: false },
    { key: 'drive', name: 'Google Drive', does: 'Repository files and check-in photos', state: on(a.drive), required: false },
    { key: 'claude', name: 'Claude', does: 'AI drafts and @Kaizen; guest replies next', state: on(a.hasClaudeKey), required: false },
    { key: 'gemini', name: 'Gemini', does: 'Price suggestions and market reading', state: on(a.hasGeminiKey), required: false },
    { key: 'quo', name: 'Quo', does: 'SMS alerts', state: on(a.hasQuoKey), required: false },
    { key: 'identity', name: 'Identity verification', does: 'Guest ID + selfie at check-in (Truvi or Stripe Identity — not chosen yet)', state: 'later', required: false },
  ];
}
