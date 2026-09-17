/**
 * Gemini, asked to reason about pricing — and constrained hard.
 *
 * The danger with a model here is not that it writes bad prose; it is
 * that it invents a market. Asked "what should this cost", a language
 * model will happily produce a confident comparable-listing rate for a
 * town it has never seen, and that number would then be written into a
 * live calendar. So:
 *
 *   · the prompt carries ONLY figures measured from this account, and
 *     says so;
 *   · the model is told explicitly that it has no market data and must
 *     not imply otherwise;
 *   · the response is a fixed JSON schema, so there is nowhere for an
 *     unsourced claim to hide in free text;
 *   · `confidence` and `missing` are required fields, which makes the
 *     model state what it could not see rather than paper over it.
 *
 * The suggestion is advice. It is recorded next to what the human
 * actually did, so that after a few months the question "is this advice
 * any good" has an answer instead of an opinion.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface PricingContext {
  name: string;
  windowFrom: string;
  windowTo: string;
  nightsOpen: number;
  nightsSold: number;
  nightsBlocked: number;
  occupancy: number | null;
  portfolioMedianOccupancy: number | null;
  adr: number | null;
  portfolioAdr: number | null;
  portfolioAskRatio: number | null;
  openAsk: number | null;
  basePrice: number | null;
  revpan: number | null;
  pickup7: number;
  leadTimeDays: number | null;
  lastBookedOn: string | null;
  weeklyDiscountPct: number | null;
  monthlyDiscountPct: number | null;
  cleaningCharged: number | null;
  cleaningCost: number | null;
  orphanNights: number;
  gaps: { from: string; to: string; nights: number; minStay: number | null; orphaned: boolean }[];
  unitType: string | null;
  bedrooms: number | null;
  capacity: number | null;
}

export interface Suggestion {
  action: 'hold' | 'lower_rate' | 'raise_rate' | 'lower_minimum_stay' | 'adjust_discounts';
  suggestedRate: number | null;
  suggestedWeeklyDiscountPct: number | null;
  suggestedMonthlyDiscountPct: number | null;
  suggestedMinimumStay: number | null;
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
  missing: string;
}

const SCHEMA = {
  type: 'OBJECT',
  required: ['action', 'confidence', 'reasoning', 'missing'],
  properties: {
    action: { type: 'STRING', enum: ['hold', 'lower_rate', 'raise_rate', 'lower_minimum_stay', 'adjust_discounts'] },
    suggestedRate: { type: 'NUMBER', nullable: true, description: 'Nightly rate in dollars, or null if the action is not a rate change' },
    suggestedWeeklyDiscountPct: { type: 'NUMBER', nullable: true, description: 'Percent off for 7+ night stays, 0-40' },
    suggestedMonthlyDiscountPct: { type: 'NUMBER', nullable: true, description: 'Percent off for 28+ night stays, 0-60' },
    suggestedMinimumStay: { type: 'INTEGER', nullable: true, description: 'Nights, only when the action is lower_minimum_stay' },
    confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
    reasoning: { type: 'STRING', description: 'Two or three sentences citing the specific figures given. No invented comparables.' },
    missing: { type: 'STRING', description: 'What information would most improve this recommendation.' }
  }
};

const SYSTEM = [
  'You are an experienced short-term-rental revenue manager reviewing ONE unit.',
  '',
  'Rules you must follow:',
  '1. You have NO market or competitor data. Do not state, estimate or imply what',
  '   similar listings nearby charge. If a comparable rate would change your advice,',
  '   say so in "missing" instead of inventing one.',
  '2. Reason only from the figures supplied. Cite them by value in your reasoning.',
  '3. Lead time decides whether emptiness is a problem. If a unit typically books a',
  '   few days out, open nights further ahead are normal and cutting rate is waste.',
  '4. Nights trapped in a gap shorter than the minimum stay cannot be booked at any',
  '   price. The lever there is the minimum stay, never a discount.',
  '5. Occupancy alone is not a verdict. Weigh pickup: a level with no movement is a',
  '   different problem from a low level that is filling.',
  '6. A rate change should be proportionate. Do not propose cuts beyond about 25% of',
  '   the current ask in a single step, and never below the point where the cleaning',
  '   cost would consume the night.',
  '7. "hold" is a legitimate and often correct answer. Say it when it is true.'
].join('\n');

export async function suggestPrice(
  apiKey: string, model: string, ctx: PricingContext
): Promise<Suggestion> {
  const res = await fetch(`${ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ parts: [{ text: 'Unit under review:\n' + JSON.stringify(ctx, null, 2) }] }],
      generationConfig: {
        // Pricing advice that changes between identical requests is not
        // advice, it is noise.
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: SCHEMA
      }
    })
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`Gemini returned ${res.status}: ${body}`);
  }
  const json = await res.json() as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    promptFeedback?: { blockReason?: string };
  };
  if (json.promptFeedback?.blockReason) {
    throw new Error(`Gemini declined to answer (${json.promptFeedback.blockReason}).`);
  }
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no content.');

  const parsed = JSON.parse(text) as Suggestion;

  // The schema constrains shape, not sanity. A rate outside these bounds
  // is a model error, and passing it through to a confirm dialog that
  // says "change the live price" is how a bad suggestion becomes a bad
  // booking.
  const ceiling = (ctx.openAsk ?? ctx.basePrice ?? 0) * 3;
  if (parsed.suggestedRate != null) {
    const r = Number(parsed.suggestedRate);
    if (!Number.isFinite(r) || r <= 0 || (ceiling > 0 && r > ceiling)) parsed.suggestedRate = null;
  }
  const clampPct = (v: number | null | undefined, max: number) =>
    v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(max, Math.round(Number(v))));
  parsed.suggestedWeeklyDiscountPct = clampPct(parsed.suggestedWeeklyDiscountPct, 40);
  parsed.suggestedMonthlyDiscountPct = clampPct(parsed.suggestedMonthlyDiscountPct, 60);
  if (parsed.suggestedMinimumStay != null) {
    const m = Math.round(Number(parsed.suggestedMinimumStay));
    parsed.suggestedMinimumStay = Number.isFinite(m) && m >= 1 && m <= 30 ? m : null;
  }
  return parsed;
}
