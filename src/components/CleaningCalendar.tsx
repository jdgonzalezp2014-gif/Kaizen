/**
 * A month of cleans, laid out as a calendar.
 *
 * This exists for one job: reconciling an invoice. A cleaner sends a
 * total for September, and the question is which days that covers and
 * whether the count matches. A list sorted by date can be counted by
 * hand; a calendar can be checked at a glance, and a missing Tuesday is
 * visible as a hole rather than as an absence you have to notice.
 *
 * The month total is the number to compare against the invoice, so it is
 * the largest thing on the screen.
 */
import type { Cleaning } from '../api.ts';
import { money2 } from '../lib/format.ts';

const MONTH = ['January', 'February', 'March', 'April', 'May', 'June',
               'July', 'August', 'September', 'October', 'November', 'December'];

export function CleaningCalendar({ month, cleanings, onMonth }: {
  /** yyyy-MM */
  month: string;
  cleanings: Cleaning[];
  onMonth: (m: string) => void;
}) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y!, m! - 1, 1));
  const days = new Date(Date.UTC(y!, m!, 0)).getUTCDate();

  const byDay = new Map<number, Cleaning[]>();
  for (const c of cleanings) {
    const d = Number(c.checkout_on.slice(8, 10));
    byDay.set(d, [...(byDay.get(d) ?? []), c]);
  }

  // "Not needed" is excluded everywhere it would be counted as work: it
  // is not on the invoice, so it must not be in the total being checked
  // against one.
  const billable = cleanings.filter(c => c.assignment !== 'not_needed');
  const priced = billable.filter(c => c.price != null);
  const total = priced.reduce((a, c) => a + Number(c.price), 0);

  const shift = (by: number) => {
    const d = new Date(Date.UTC(y!, m! - 1 + by, 1));
    onMonth(d.toISOString().slice(0, 7));
  };

  return (
    <div className="cal">
      <div className="cal-head">
        <button className="ghost small" onClick={() => shift(-1)}>←</button>
        <strong>{MONTH[m! - 1]} {y}</strong>
        <button className="ghost small" onClick={() => shift(1)}>→</button>
        <span className="cal-total">
          <b>{money2(total)}</b>
          <span className="note">
            {billable.length} clean{billable.length === 1 ? '' : 's'}
            {priced.length < billable.length &&
              ` · ${billable.length - priced.length} not priced`}
          </span>
        </span>
      </div>

      <div className="cal-dow">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <span key={d}>{d}</span>)}
      </div>
      <div className="cal-grid">
        {/* Monday-first: a cleaning week is a working week, and Sunday in
            the first column splits it across two rows. */}
        {Array.from({ length: (first.getUTCDay() + 6) % 7 }).map((_, i) => (
          <span key={`pad${i}`} className="cal-day empty" />
        ))}
        {Array.from({ length: days }).map((_, i) => {
          const day = i + 1;
          const list = byDay.get(day) ?? [];
          const work = list.filter(c => c.assignment !== 'not_needed');
          const paid = work.reduce((a, c) => a + Number(c.price ?? 0), 0);
          return (
            <div key={day} className={work.length ? 'cal-day has' : 'cal-day'}>
              <span className="cal-num">{day}</span>
              {work.length > 0 && (
                <>
                  <span className="cal-amt">{paid > 0 ? money2(paid) : '—'}</span>
                  <span className="cal-list">
                    {work.map(c => (
                      <span key={c.key} className={c.price == null ? 'cal-item note' : 'cal-item'}>
                        {c.unit_name}
                        {c.cleaner && <i> {c.cleaner.split(' ')[0]}</i>}
                      </span>
                    ))}
                  </span>
                </>
              )}
              {/* Shown but never counted: it explains a gap in the
                  invoice instead of leaving one unexplained. */}
              {list.length > work.length && (
                <span className="cal-none">{list.length - work.length} no clean</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
