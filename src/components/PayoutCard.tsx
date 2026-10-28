/**
 * Paying an invoice (owner, 2026-10-25) — under a cleaner's page in
 * Operations → Cleaners and a handyman's in Operations → Handymen. One card:
 * where the invoice stands (open, due, paid, changed since paid), the payee's
 * bank on file in Wise (their bank link, sent by the team), and the two ways
 * to pay: a Wise transfer (owner, 2026-10-28), or "Mark paid" for cash / Zelle / check.
 * The server rebuilds the invoice before paying — the amount here is only shown.
 */
import { useEffect, useState } from 'react';
import { getPayouts, payoutAction, type PayeeBank, type WiseStatus } from '../api.ts';
import { payBlockers, payState, wiseStatusLabel, type Payout } from '../lib/payouts.ts';
import type { Period } from '../lib/crew.ts';
import { money2 } from '../lib/format.ts';
import { Hint } from './Hint.tsx';
import { Icon, ic } from './Icon.tsx';

export interface PayInvoice { number: string; period: Period; open: boolean; total: number; unpriced: number; pending: number }

export function PayoutCard({ kind, payee, invoice, payout, today, canPay, onChanged }: {
  kind: 'cleaner' | 'vendor'; payee: string; invoice: PayInvoice; payout: Payout | null; today: string;
  canPay: boolean; onChanged: () => void;
}) {
  const [wise, setWise] = useState<WiseStatus | null>(null);
  const [bank, setBank] = useState<PayeeBank | null>(null);
  const [link, setLink] = useState<{ url: string; phone: string | null } | null>(null);
  const [marking, setMarking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const load = () => {
    if (!canPay) return;
    void getPayouts(kind, payee).then(r => { if (r.ok) { setWise(r.wise); setBank(r.payee?.bank ?? null); } else setMsg(r.message ?? 'Could not load.'); })
      .catch(e => setMsg(String(e)));
  };
  useEffect(() => { setLink(null); setMarking(false); setConfirming(false); setMsg(''); load(); }, [kind, payee, invoice.number]);

  const state = payState(invoice, payout);
  const stop = payBlockers(invoice, today, invoice.period.to);
  const ready = !!wise?.configured && !!bank?.current;
  const sandbox = wise?.env === 'sandbox';
  const moving = payout?.method === 'wise' ? wiseStatusLabel(payout.status) : null;
  const run = async (body: Record<string, unknown>, after?: (r: { link?: string; phone?: string | null }) => void) => {
    setBusy(true); setMsg('');
    const r = await payoutAction(body).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? 'Not done.'); return; }
    after?.(r);
    setMarking(false); setConfirming(false); setNote('');
    onChanged(); load();
  };
  const message = link && `Hi ${payee}, this is Kaizen. Enter the bank account where you want your pay (secure): ${link.url}\n` +
    `Hola ${payee}, es Kaizen. Pon la cuenta de banco donde quieres recibir tu pago (seguro): ${link.url}`;
  const phone = link?.phone?.replace(/[^\d+]/g, '');

  return (
    <div className="card no-print">
      <h2>Payment <Hint label="How paying works">Each invoice is paid once, after its period ends, with nothing waiting for a decision and every job priced.
        Two ways: <b>Pay with Wise</b> sends the total from Kaizen's Wise USD balance to the payee's bank (Wise's fee, about $1.13 per $1,000, comes
        from the balance too), or <b> Mark paid</b> records cash, Zelle or a check. The first time, get their bank link and send it by WhatsApp or SMS:
        they type their routing and account number, which go to Wise — Kaizen keeps only the last 4 digits. The link lasts 30 days and also changes a bank
        on file. A payment marked by hand can be undone here; a Wise transfer is cancelled in Wise, only if it has not gone out. In the sandbox no real
        money moves.</Hint></h2>
      <p>
        {state === 'open' && <span className="note"><Icon n="clock" /> Open — the period ends {ic(invoice.period.to)}; it is paid after that.</span>}
        {state === 'nothing' && <span className="note">Nothing to pay in this period.</span>}
        {state === 'due' && <span><Icon n="dollar" /> <b>Due: {ic(money2(invoice.total))}</b></span>}
        {(state === 'paid' || state === 'changed') && payout && <span><Icon n="done" /> <b>Paid {ic(money2(payout.amount))}</b>
          {ic(payout.method === 'wise' ? ` by Wise${payout.env === 'sandbox' ? ' (sandbox)' : ''}` : ` by hand — ${payout.note ?? ''}`)}
          <span className="sub-n"> {ic(payout.at)} · {ic(payout.by)}{payout.fee != null ? ` · fee ${money2(payout.fee)}` : ''}{payout.transferId ? ` · #${payout.transferId}` : ''}</span></span>}
      </p>
      {moving && <p className={moving.bad ? 'breach' : 'note'}><Icon n={moving.bad ? 'warning' : 'clock'} /> {ic(moving.text)}</p>}
      {state === 'changed' && payout && <p className="breach"><Icon n="warning" /> The invoice is now {ic(money2(invoice.total))} — it changed after it was paid.
        Settle the {ic(money2(Math.abs(invoice.total - payout.amount)))} difference by hand.</p>}
      {(state === 'due' || state === 'open') && stop.filter(s => !s.startsWith('The period')).map(s => <p key={s} className="note"><Icon n="alert" /> {ic(s)}</p>)}

      {canPay && wise && (
        <div className="sub-n">
          {!wise.configured ? <>Wise is not set up — Settings → Payments.</> : <>
            Wise {sandbox && <span className="chan-tag">SANDBOX</span>}
            {wise.balance != null && <> · balance {ic(money2(wise.balance))}</>}
            {wise.problem && <span className="breach"> · {ic(wise.problem)}</span>}
            {' · '}{bank?.current ? <><Icon n="done" /> {ic(payee)}'s bank ends {ic(bank.last4 ?? '')}</>
              : <>{ic(payee)} has no bank on file{sandbox ? ' in the sandbox' : ''} yet</>}
          </>}
        </div>
      )}

      {canPay && (
        <div className="row-controls">
          {wise?.configured && !link &&
            <button className={bank?.current ? 'link tiny' : 'chip'} disabled={busy}
                    onClick={() => void run({ action: 'link', kind, payee }, r => r.link && setLink({ url: r.link, phone: r.phone ?? null }))}>
              <Icon n="link" /> {bank?.current ? 'Bank link (to change it)' : 'Get their bank link'}</button>}
          {state === 'due' && !stop.length && ready && !confirming &&
            <button className="small" disabled={busy} onClick={() => setConfirming(true)}><Icon n="dollar" /> Pay {ic(money2(invoice.total))} with Wise</button>}
          {confirming && <>
            <button className="small" disabled={busy} onClick={() => void run({ action: 'pay', kind, payee, period: invoice.period.from, method: 'wise' })}>
              {busy ? 'Sending…' : `Confirm — send ${money2(invoice.total)} to ${payee}'s bank${sandbox ? ' (sandbox)' : ''}`}</button>
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
