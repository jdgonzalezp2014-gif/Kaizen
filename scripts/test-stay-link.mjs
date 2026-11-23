// A test guest link (owner, 2026-11-23): the real portal on a real house, a made-up guest and dates, nothing in Hostaway.
// node --env-file=.env.local scripts/test-stay-link.mjs <listingId> [direct|airbnb] [arrival YYYY-MM-DD = today] [nights = 2]
// The id format is testReservation() in src/lib/guest-stay.ts. Payments are real (live key): refund them in Stripe.
const [listing, channel = 'direct', arrival = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }), nights = '2'] = process.argv.slice(2);
if (!/^\d{1,7}$/.test(listing ?? '') || !/^(direct|airbnb)$/.test(channel) || !/^\d{4}-\d{2}-\d{2}$/.test(arrival) || !(Number(nights) >= 1 && Number(nights) <= 99)) {
  console.log('usage: test-stay-link.mjs <listingId> [direct|airbnb] [YYYY-MM-DD] [nights]'); process.exit(1);
}
const id = `77${channel === 'airbnb' ? 2 : 1}${arrival.replace(/-/g, '')}${String(nights).padStart(2, '0')}${listing.padStart(7, '0')}`;
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const raw = Buffer.from(process.env.ENCRYPTION_KEY.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sig = b64u(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`guest:${id}`))).slice(0, 16));
console.log(`https://stay.kaizenguestproperties.com/guest/${id}.${sig}`);
