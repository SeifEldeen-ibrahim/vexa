/**
 * checklists.ts — "start from a list you've used before".
 *
 * There is no separate templates store, on purpose: the lists a user actually reuses are the
 * ones they have already run meetings with, and those are already on their meeting rows. So the
 * extension's "New call" screen offers the DISTINCT checklists from the user's recent in-person
 * calls, newest first — which means a list becomes reusable by being used, with nothing to
 * manage, and no second place where a user's agendas live and drift.
 *
 * Distinctness is by the SET of item texts (normalized), not by title: the same five lines under
 * two different meeting titles is one list used twice, which is exactly what "uses" should count.
 * PURE — it takes rows and returns rows.
 */
import { MAX_ITEMS, parseAgenda, type Agenda } from './agenda.js';
import type { MeetingRow } from './meetings-client.js';

export interface SavedChecklist {
  /** A stable id for the list itself (its content signature) — what the extension sends back. */
  key: string;
  /** The title of the most recent meeting that used it, for recognition. */
  title: string;
  items: string[];
  /** When it was last used (ISO), and how many of the user's recent calls used it. */
  lastUsedAt: string | null;
  uses: number;
  /** How much of it got covered the LAST time it was used — the useful signal when reusing. */
  lastCovered: number;
}

const signature = (items: readonly string[]): string =>
  items.map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).filter(Boolean).sort().join('|');

/** Hash the signature down to a short, stable key (FNV-1a — an id, not a security primitive). */
function keyOf(sig: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < sig.length; i++) {
    h ^= sig.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `cl_${h.toString(36)}`;
}

/** The agenda carried on a meeting row (or an empty one). */
export function agendaOf(row: MeetingRow): Agenda {
  return parseAgenda((row.data as { agenda?: unknown } | undefined)?.agenda);
}

export function titleOf(row: MeetingRow): string {
  const title = (row.data as { title?: unknown } | undefined)?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : 'Untitled call';
}

/**
 * Derive the reusable checklists from the user's recent in-person rows (newest first, as
 * meeting-api returns them).
 */
export function checklistsFromRows(rows: readonly MeetingRow[], limit = 12): SavedChecklist[] {
  const out = new Map<string, SavedChecklist>();
  for (const row of rows) {
    const agenda = agendaOf(row);
    const items = agenda.items.map((i) => i.text).slice(0, MAX_ITEMS);
    if (!items.length) continue;
    const sig = signature(items);
    if (!sig) continue;
    const key = keyOf(sig);
    const existing = out.get(key);
    if (existing) {
      existing.uses++;
      continue;
    }
    out.set(key, {
      key,
      title: titleOf(row),
      items,
      lastUsedAt: row.created_at ?? row.start_time ?? null,
      uses: 1,
      lastCovered: agenda.items.filter((i) => i.status === 'covered').length,
    });
    if (out.size >= limit) break;
  }
  return [...out.values()];
}
