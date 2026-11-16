/**
 * Stripe.js, loaded only when a guest reaches a Stripe step (2026-11-16: payment and ID check inside the portal).
 * Stripe requires it from js.stripe.com — never bundled or self-hosted (PCI). One instance per publishable key.
 */
export type EmbeddedCheckout = { mount: (el: HTMLElement) => void; destroy: () => void };
export type StripeJs = {
  initEmbeddedCheckout: (o: { fetchClientSecret: () => Promise<string>; onComplete?: () => void }) => Promise<EmbeddedCheckout>;
  verifyIdentity: (clientSecret: string) => Promise<{ error?: { code?: string; message?: string } }>;
};
type StripeCtor = (pk: string) => StripeJs;

const cache = new Map<string, Promise<StripeJs>>();
export function loadStripe(pk: string): Promise<StripeJs> {
  let p = cache.get(pk);
  if (!p) {
    p = new Promise<StripeJs>((resolve, reject) => {
      const w = window as unknown as { Stripe?: StripeCtor };
      const ready = () => w.Stripe ? resolve(w.Stripe(pk)) : reject(new Error('Stripe could not load.'));
      if (w.Stripe) return ready();
      const s = document.createElement('script');
      s.src = 'https://js.stripe.com/v3/'; s.async = true;
      s.onload = ready; s.onerror = () => { cache.delete(pk); reject(new Error('Stripe could not load — check the connection.')); };
      document.head.appendChild(s);
    });
    cache.set(pk, p);
  }
  return p;
}
