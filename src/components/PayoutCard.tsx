/**
 * Paying an invoice (owner, 2026-10-25) — under a cleaner's page in
 * Operations → Cleaners and a handyman's in Operations → Handymen. One card:
 * where the invoice stands (open, due, paid, changed since paid), the payee's
 * Stripe account (their setup link, sent by the team), and the two ways to
 * pay: a Stripe transfer, or "Mark paid" for cash / Zelle / check.
 * The server rebuilds the invoice before paying — the amount here is only shown.
 */
import { useEffect, useState } from 'react';
import { getPayouts, payoutAction, type PayeeAccount, type StripeStatus } from '../api.ts';
import { payBlockers, payState, type Payout } from '../lib/payouts.ts';
import type { Period } from '../lib/crew.ts';
import { money2 } from '../lib/format.ts';
import { Hint } from './Hint.tsx';
import { Icon, ic } from './Icon.tsx';

export interface PayInvoice { number: string; period: Period; open: boolean; total: number; unpriced: number; pending: number }

export function PayoutCard({ kind, payee, invoice, payout, today, canPay, onChanged }: {
  kind: 'cleaner' | 'vendor'; payee: string; invoice: PayInvoice; payout: Payout | null; today: string;
  canPay: boolean; onChanged: () => void;
}) {
  const [stripe, setStripe] = useState<StripeStatus | null>(null);
  const [account, setAccount] = useState<PayeeAccount | null>(null);
  const [link, setLink] = useState<{ url: string; phone: string | null } | null>(null);
  const [marking, setMarking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const load = () => {
    if (!canPay) return;
    void getPayouts(kind, payee).then(r => { if (r.ok) { setStripe(r.stripe); setAccount(r.payee?.account ?? null); } else setMsg(r.message ?? 'Could not load.'); })
      .catch(e => setMsg(String(e)));
  };
  useEffect(() => { setLink(null); setMarking(false); setConfirming(false); setMsg(''); load(); }, [kind, payee, invoice.number]);

  const state = payState(invoice, payout);
  const stop = payBlockers(invoice, today, invoice.period.to);
  const ready = !!stripe?.configured && !!account?.ready && account.mode === stripe.mode;
  const run = async (body: Record<string, unknown>, after?: (r: { link?: string; phone?: string | null }) => void) => {
    setBusy(true); setMsg('');
    const r = await payoutAction(body).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? 'Not done.'); return; }
    after?.(r);
    setMarking(false); setConfirming(false); setNote('');
    onChanged(); load();
  };
  const message = link && `Hi ${payee}, this is Kaizen. To get paid by bank transfer, set up your payout account here (Stripe, secure): ${link.url}`;
  const phone = link?.phone?.replace(/[^\d+]/g, '');

  return (
    <div className="card no-print">
      <h2>Payment <Hint label="How paying works">Each invoice is paid once, after its period ends, with nothing waiting for a decision and every job priced.
        Two ways: <b>Pay with Stripe</b> sends the total to the payee's bank through their Stripe account (Kaizen's Stripe balance pays it), or
        <b> Mark paid</b> records cash, Zelle or a check. The payee's Stripe account is made the first time you get their setup link; send it by
        WhatsApp or SMS — they enter their own bank details with Stripe, Kaizen never sees them. The link lasts 30 days. A payment marked by hand can be
        undone here; a Stripe transfer is reversed in Stripe's dashboard. In test mode no real money moves: add test funds to the balance in Stripe's
        dashboard (Balance → Add to balance) before paying.</Hint></h2>
      <p>
        {state === 'open' && <span className="note"><Icon n="clock" /> Open — the period ends {ic(invoice.period.to)}; it is paid after that.</span>}
        {state === 'nothing' && <span className="note">Nothing to pay in this period.</span>}
        {state === 'due' && <span><Icon n="dollar" /> <b>Due: {ic(money2(invoice.total))}</b></span>}
        {(state === 'paid' || state === 'changed') && payout && <span><Icon n="done" /> <b>Paid {ic(money2(payout.amount))}</b>
          {ic(payout.method === 'stripe' ? ` by Stripe${payout.stripeMode === 'test' ? ' (test)' : ''}` : ` by hand — ${payout.note ?? ''}`)}
          <span className="sub-n"> {ic(payout.at)} · {ic(payout.by)}{payout.transferId ? ` · ${payout.transferId}` : ''}</span></span>}
      </p>
      {state === 'changed' && payout && <p className="breach"><Icon n="warning" /> The invoice is now {ic(money2(invoice.total))} — it changed after it was paid.
        Settle the {ic(money2(Math.abs(invoice.total - payout.amount)))} difference by hand.</p>}
      {(state === 'due' || state === 'open') && stop.filter(s => !s.startsWith('The period')).map(s => <p key={s} className="note"><Icon n="alert" /> {ic(s)}</p>)}

      {canPay && stripe && (
        <div className="sub-n">
          {!stripe.configured ? <>Stripe is not set up — add the key in Settings → Payments.</> : <>
            Stripe {stripe.mode === 'test' && <span className="chan-tag">TEST</span>}
            {stripe.balance && <> · balance {ic(money2(stripe.balance.available))} available{stripe.balance.pending ? `, ${money2(stripe.balance.pending)} pending` : ''}</>}
            {stripe.problem && <span className="breach"> · {ic(stripe.problem)}</span>}
            {' · '}{!account ? <>{ic(payee)} has no Stripe account yet</>
              : account.problem ? <span className="breach">{ic(account.problem)}</span>
              : account.ready ? <><Icon n="done" /> {ic(payee)}'s account is ready</>
              : <><Icon n="clock" /> {ic(payee)}'s setup is not finished{account.due?.length ? ` (missing ${account.due.slice(0, 3).join(', ')})` : ''}</>}
          </>}
        </div>
      )}

      {canPay && (
        <div className="row-controls">
          {stripe?.configured && !account?.ready && !link &&
            <button className="chip" disabled={busy} onClick={() => void run({ action: 'link', kind, payee }, r => r.link && setLink({ url: r.link, phone: r.phone ?? null }))}>
              <Icon n="link" /> {account ? 'Setup link again' : 'Get their Stripe setup link'}</button>}
          {state === 'due' && !stop.length && ready && !confirming &&
            <button className="small" disabled={busy} onClick={() => setConfirming(true)}><Icon n="dollar" /> Pay {ic(money2(invoice.total))} with Stripe</button>}
          {confirming && <>
            <button className="small" disabled={busy} onClick={() => void run({ action: 'pay', kind, payee, period: invoice.period.from, method: 'stripe' })}>
              {busy ? 'Sending…' : `Confirm — send ${money2(invoice.total)} to ${payee}${stripe?.mode === 'test' ? ' (test)' : ''}`}</button>
            <button className="small secondary" onClick={() => setConfirming(false)}>Cancel</button>
          </>}
          {state === 'due' && !stop.length && !marking && !confirming &&
            <button className="chip" onClick={() => setMarking(true)}><Icon n="cash" /> Mark paid…</button>}
          {payout?.method === 'manual' &&
            <button className="link tiny" disabled={busy} onClick={() => void run({ action: 'undo', id: payout.id })}><Icon n="undo" /> Undo "paid"</button>}
        </div>
      )}
      {marking && (
        <div className="crew-decide">
          <input value={note} maxLength={300} placeholder="How it was paid — cash, Zelle, check #…" onChange={e => setNote(e.target.value)} />
          <button className="small" disabled={busy || !note.trim()}
                  onClick={() => void run({ action: 'pay', kind, payee, period: invoice.period.from, method: 'manual', note })}>Mark {ic(money2(invoice.total))} paid</button>
          <button className="small secondary" onClick={() => setMarking(false)}>Cancel</button>
        </div>
      )}
      {link && message && (
        <div className="crew-decide">
          <input readOnly value={link.url} onFocus={e => e.target.select()} />
          <button className="small secondary" onClick={() => void navigator.clipboard?.writeText(message)}><Icon n="clipboard" /> Copy message</button>
          {phone && <a className="chip" href={`https://wa.me/${phone.replace(/^\+/, '')}?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">WhatsApp</a>}
          {phone && <a className="chip" href={`sms:${phone}?&body=${encodeURIComponent(message)}`}>SMS</a>}
          <span className="note">Good for 30 days. Nothing is sent until you send it.</span>
        </div>
      )}
      {msg && <p className="breach">{ic(msg)}</p>}
    </div>
  );
}
