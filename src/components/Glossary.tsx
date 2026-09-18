/**
 * What the numbers mean, in the words a host would use.
 *
 * Written for someone who runs the properties, not for someone who
 * already knows revenue-management vocabulary — every entry says what
 * the number is, and then the decision it should change, because a
 * definition nobody acts on is trivia.
 */
interface Entry { term: string; short: string; body: string; example?: string }

const ENTRIES: Entry[] = [
  {
    term: 'ADR',
    short: 'Average Daily Rate — what your booked nights actually sold for.',
    body: 'Total room revenue divided by the number of nights that sold. It ignores empty ' +
          'nights entirely, so it tells you what guests were willing to pay, not how much ' +
          'you earned.',
    example: 'Four nights sold for $600 total → ADR $150. The other 26 nights of the month ' +
             'do not affect it.'
  },
  {
    term: 'RevPAN',
    short: 'Revenue Per Available Night — rate and occupancy in one number.',
    body: 'Total revenue divided by every night the unit was available to sell, empty ones ' +
          'included. This is the number that cannot be gamed: you can raise ADR by pricing ' +
          'high and selling almost nothing, and RevPAN will fall. It is occupancy expressed ' +
          'in dollars, which is why it survives a conversation with someone who only reads money.',
    example: '$600 earned across 30 available nights → RevPAN $20, even though ADR was $150.'
  },
  {
    term: 'Occupancy',
    short: 'The share of SELLABLE nights that are booked.',
    body: 'Blocked nights — an owner stay, a renovation, an iCal hold — are left out of the ' +
          'denominator entirely. A unit blocked solid is not zero per cent occupied; it is ' +
          'out of service, and counting it as vacant would invent a discount opportunity ' +
          'that does not exist.'
  },
  {
    term: 'Booked 7d (pickup)',
    short: 'Nights booked in the last week for stays inside this window.',
    body: 'Occupancy is a level; pickup is the direction. A unit at 40% with strong pickup ' +
          'is filling and needs nothing. The same unit at 40% with zero pickup for two weeks ' +
          'is stuck — same occupancy, completely different decision.'
  },
  {
    term: 'Books (lead time)',
    short: 'The typical number of days between a booking and the arrival.',
    body: 'This decides whether an empty night is a problem YET. A unit that habitually books ' +
          'two days out is not in trouble because week four is empty — that is simply its ' +
          'pattern, and discounting gives away rate for nothing. A unit that books sixty days ' +
          'out with week four empty genuinely is behind.',
    example: 'P2-4304 books about 1.5 days out. Its 33% occupancy a month ahead is normal.'
  },
  {
    term: 'Gaps too short to book',
    short: 'Open nights trapped in a stretch shorter than the minimum stay.',
    body: 'Two open nights between two bookings, under a three-night minimum, cannot be ' +
          'booked at any price. The lever is the minimum stay, not the rate — and no ' +
          'occupancy figure will ever show you this. It is usually the cheapest night to ' +
          'recover in the whole calendar.'
  },
  {
    term: 'Pace',
    short: 'How this unit compares with the rest of your portfolio.',
    body: 'Shown in percentage points against the portfolio median. 45% occupancy means ' +
          'nothing on its own — it is healthy in one market and a crisis in another — so ' +
          'until real comparable-listing data is connected, your own portfolio is the only ' +
          'honest benchmark available.'
  },
  {
    term: 'Money still winnable',
    short: 'Open nights × what you are asking for them.',
    body: 'The real size of a problem. Eighteen open nights on a $300 house is a far bigger ' +
          'number than four on a $150 studio, and occupancy percentages hide that completely — ' +
          'which is why the list is ordered by this rather than by percentage.'
  },
  {
    term: 'Cleaning in / out',
    short: 'What the guest is charged, then what the cleaner is paid.',
    body: 'Two different numbers. The first comes from Hostaway and is revenue; the second ' +
          'comes from your cleanings sheet and is a cost. When they are close, the turnover ' +
          'earns nothing.'
  }
];

/**
 * Rendered in place, never as a dialog.
 *
 * A modal covers the very table whose column you are trying to
 * understand, which means reading the definition and applying it become
 * two separate trips.
 */
export function Glossary({ onClose }: { onClose: () => void }) {
  return (
    <section className="glossary-panel">
      <div className="glossary">
        <div className="gp-head">
          <h3>What these numbers mean</h3>
          <button className="link" onClick={onClose}>close</button>
        </div>
        <dl>
          {ENTRIES.map(e => (
            <div key={e.term}>
              <dt>{e.term}</dt>
              <dd>
                <p className="lead">{e.short}</p>
                <p>{e.body}</p>
                {e.example && <p className="eg">{e.example}</p>}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
