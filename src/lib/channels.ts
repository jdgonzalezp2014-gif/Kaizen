/**
 * What state a channel is actually in.
 *
 * Four different things were sharing one blank space and one long
 * paragraph, and they call for different reactions:
 *
 *   unpublished  we never put the unit there. Nothing is wrong.
 *   ok           published and we have a current reading.
 *   stale        published, we had readings, they stopped. Could be the
 *                platform, could be our own feed — either way the number
 *                on screen is old, not absent.
 *   blocked      published, and we have never managed to read it. That
 *                is our integration, not their outage, and it will not
 *                fix itself.
 *
 * The distinction that matters: `stale` is usually temporary and needs
 * nothing today; `blocked` needs someone to change something. Showing
 * both as a warning triangle teaches people to ignore the triangle.
 */
export type ChannelState = 'ok' | 'stale' | 'blocked' | 'unpublished';

export interface ChannelView {
  state: ChannelState;
  mark: string;
  /** Two or three words, next to the channel name. */
  label: string;
  /** The full sentence, for a tooltip. */
  detail: string;
  ageDays: number | null;
}

const DAY = 86_400_000;

export function channelState(input: {
  published: boolean;
  /** A reading we just took, if the live read worked. */
  liveOk: boolean;
  /** When the most recent stored reading was taken, if any. */
  observedAt: string | null;
  /** Why the live read failed, when it did. */
  problem: string | null;
  now?: number;
  staleAfterDays?: number;
}): ChannelView {
  const staleAfter = input.staleAfterDays ?? 3;
  const now = input.now ?? Date.now();
  const ageDays = input.observedAt
    ? Math.floor((now - Date.parse(input.observedAt)) / DAY) : null;

  if (!input.published) {
    return { state: 'unpublished', mark: '○', label: 'not published',
      detail: 'This unit is not published to this channel, so it has no page, rating or public price there.',
      ageDays: null };
  }
  if (input.liveOk) {
    return { state: 'ok', mark: '●', label: '', detail: 'Read just now.', ageDays: 0 };
  }
  if (ageDays != null && ageDays <= staleAfter) {
    // Recent enough to be the current answer. Nothing is wrong today.
    return { state: 'ok', mark: '●', label: '',
      detail: `Last read ${ageDays === 0 ? 'today' : `${ageDays} day(s) ago`}.`, ageDays };
  }
  if (ageDays != null) {
    return { state: 'stale', mark: '◐', label: `${ageDays}d old`,
      detail: `The figures shown were read ${ageDays} days ago and have not refreshed since. ` +
              'That is usually the feed pausing rather than anything being wrong with the listing.',
      ageDays };
  }
  return { state: 'blocked', mark: '⚠', label: 'not readable',
    detail: (input.problem ?? 'The listing page could not be read.') +
            ' Nothing has ever been read for this channel, so this is the integration rather ' +
            'than an outage — it will not clear on its own.',
    ageDays: null };
}
