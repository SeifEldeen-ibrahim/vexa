/**
 * agenda-view.ts — how the checklist READS. Pure formatting, so the wording and the ordering
 * are testable without a browser.
 *
 * The ordering rule is the interesting one: the point of this surface is "what have we NOT dealt
 * with yet", so open items come first, then what was touched but not settled, then what is done.
 * Within a group the user's own order is preserved — it is their agenda.
 */
import type { Agenda, AgendaItem, Progress } from './types.js';

const RANK: Record<AgendaItem['status'], number> = { open: 0, touched: 1, covered: 2 };

export function sortForDisplay(agenda: Agenda): AgendaItem[] {
  return agenda.items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => RANK[a.item.status] - RANK[b.item.status] || a.index - b.index)
    .map(({ item }) => item);
}

export function statusLabel(status: AgendaItem['status']): string {
  if (status === 'covered') return 'covered';
  if (status === 'touched') return 'started';
  return 'not yet';
}

/** The header line: honest about the three states rather than a single percentage. */
export function progressLine(progress: Progress): string {
  if (!progress.total) return 'No checklist for this call';
  // All three buckets, always — zeros included. Hiding an empty one made "0 of 11 covered" the
  // whole story of a call where five points had been started, so the reader could not tell a
  // meeting that got half way from one that never began. The categories are the answer.
  return [
    `${progress.covered} of ${progress.total} covered`,
    `${progress.touched} started`,
    `${progress.open} not yet`,
  ].join(' · ');
}

/** The two widths of the progress bar: covered, then started, as percentages of the whole.
 *
 *  One bar fed only by `covered` is an EMPTY bar for a call where every point was raised and
 *  none concluded — visually identical to a call that never happened. The started share is drawn
 *  behind the covered one in a lighter tone, so the bar always shows how far the meeting got. */
export function progressBars(progress: Progress): { covered: number; touched: number } {
  if (!progress.total) return { covered: 0, touched: 0 };
  const pct = (n: number) => Math.round((n / progress.total) * 100);
  return { covered: pct(progress.covered), touched: pct(progress.touched) };
}

/** mm:ss — a meeting is minutes long, so hours are only shown when there are some. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = `${m}`.padStart(h ? 2 : 1, '0');
  return h ? `${h}:${mm}:${`${s}`.padStart(2, '0')}` : `${mm}:${`${s}`.padStart(2, '0')}`;
}

/** "we got to it at 4:12" — where an item was dealt with in the call. */
export function whenCovered(item: AgendaItem): string | null {
  const at = item.coveredMs ?? item.firstTouchedMs;
  return at === undefined ? null : clock(at);
}

/** What the capture indicator says. The user needs to know "is it hearing me?" without reading
 *  numbers, and a silent failure here is the worst outcome of the whole feature. */
export function audioHealth(
  snapshot: { audio: { frames: number; last_frame_ms_ago: number | null } } | null,
  phase: string,
): { tone: 'ok' | 'warn' | 'bad'; text: string } {
  if (phase !== 'live') return { tone: 'ok', text: 'Not recording' };
  if (!snapshot || snapshot.audio.frames === 0) {
    return { tone: 'warn', text: 'Waiting for the microphone…' };
  }
  const ago = snapshot.audio.last_frame_ms_ago;
  if (ago !== null && ago > 15000) {
    return { tone: 'bad', text: 'Not hearing anything — check the microphone' };
  }
  return { tone: 'ok', text: 'Listening' };
}

/** A date for the History list: time for today, otherwise a short date. */
export function historyWhen(iso: string | null, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
