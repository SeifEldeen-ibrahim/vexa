/**
 * agenda.ts — the checklist and the rule for marking it off. PURE: no network, no clock,
 * no redis, so the whole "did we cover it?" judgement is unit-testable offline.
 *
 * The product promise is narrow and worth stating exactly: the user writes down what the
 * meeting is FOR, we listen to the room, and each line gets marked when it was actually
 * discussed. Two properties make that trustworthy rather than merely clever:
 *
 *   1. MONOTONIC. A line only ever moves forward — open → touched → covered. The evaluator
 *      sees a sliding window of recent speech, so an item settled five minutes ago is absent
 *      from the current window; a model free to answer "open" for it would un-tick a box the
 *      user already saw ticked. Un-ticking is the one failure that makes the whole surface
 *      untrustworthy, so the merge forbids it structurally (`mergeMarks`) instead of asking
 *      the prompt nicely.
 *   2. EVIDENCE OR IT DIDN'T HAPPEN. Every mark carries the quote that earned it. A tick with
 *      no evidence is a claim the user cannot check, and the agenda text itself is NOT
 *      evidence — being on the list is not the same as having been talked about.
 */

/** How far along one checklist line is. The order here IS the ranking `mergeMarks` enforces. */
export type AgendaStatus = 'open' | 'touched' | 'covered';

const RANK: Record<AgendaStatus, number> = { open: 0, touched: 1, covered: 2 };

/** One line of the user's pre-call checklist, plus whatever the meeting has done to it. */
export interface AgendaItem {
  /** Stable, short, model-facing id (`a1`, `a2`, …). Assigned once, at session start. */
  id: string;
  /** What the user typed. Never rewritten — the user's words are the contract. */
  text: string;
  status: AgendaStatus;
  /** The quote that earned the current status. Absent while `open`. */
  evidence?: string;
  /** Ms into the call when this item FIRST left `open` — the "when did we get to it" column. */
  firstTouchedMs?: number;
  /** Ms into the call when it reached `covered`. */
  coveredMs?: number;
}

/** One model judgement about one item. The evaluator returns a list of these. */
export interface AgendaMark {
  id: string;
  status: AgendaStatus;
  evidence?: string;
}

/** The checklist as the extension renders it. */
export interface Agenda {
  items: AgendaItem[];
  /** Bumped on every change, so a poller can tell "nothing moved" from "I missed an update". */
  version: number;
}

export const MAX_ITEMS = 40;
export const MAX_ITEM_CHARS = 300;
export const MAX_EVIDENCE_CHARS = 180;

/** Collapse whitespace, drop a leading bullet or numbering, and clip. Checklist lines come from
 *  a textarea, so they arrive with stray indentation, bullet glyphs and the odd 4 KB paste.
 *  The numbering pattern is deliberately narrow — a bare digit run is NOT a bullet, or
 *  "2026 budget review" would lose its year. */
function tidy(raw: unknown, limit: number): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:[-*•·]|\d{1,2}[.)])\s+/, '')
    .trim()
    .slice(0, limit);
}

/**
 * Build a fresh agenda from the user's raw lines (a textarea's contents, or an array).
 * Blank lines vanish, duplicates collapse (same text twice is a typo, not two agenda items),
 * and ids are positional + stable for the life of the session.
 */
export function buildAgenda(lines: readonly string[] | string): Agenda {
  const raw = Array.isArray(lines) ? lines : String(lines).split(/\r?\n/);
  const seen = new Set<string>();
  const items: AgendaItem[] = [];
  for (const line of raw) {
    const text = tidy(line, MAX_ITEM_CHARS);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ id: `a${items.length + 1}`, text, status: 'open' });
    if (items.length >= MAX_ITEMS) break;
  }
  return { items, version: 0 };
}

/** Re-hydrate an agenda that came back from redis/postgres as untrusted JSON. */
export function parseAgenda(value: unknown): Agenda {
  const obj = (value ?? {}) as { items?: unknown; version?: unknown };
  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const items: AgendaItem[] = [];
  for (const entry of rawItems) {
    const it = (entry ?? {}) as Record<string, unknown>;
    const id = tidy(it.id, 16);
    const text = tidy(it.text, MAX_ITEM_CHARS);
    if (!id || !text) continue;
    const status: AgendaStatus = it.status === 'covered' || it.status === 'touched' ? it.status : 'open';
    const item: AgendaItem = { id, text, status };
    const evidence = tidy(it.evidence, MAX_EVIDENCE_CHARS);
    if (evidence) item.evidence = evidence;
    if (typeof it.firstTouchedMs === 'number') item.firstTouchedMs = it.firstTouchedMs;
    if (typeof it.coveredMs === 'number') item.coveredMs = it.coveredMs;
    items.push(item);
  }
  const version = typeof obj.version === 'number' && obj.version >= 0 ? Math.floor(obj.version) : 0;
  return { items, version };
}

/**
 * Apply the evaluator's marks to the agenda. Returns a NEW agenda (and whether anything
 * actually moved, so the caller can skip a publish).
 *
 * The rules, all of them:
 *   • an unknown id is dropped — the model may not invent checklist lines;
 *   • a mark that does not RAISE the rank is dropped (the monotonicity promise);
 *   • a raise with no evidence is dropped: an unverifiable tick is worse than no tick;
 *   • evidence is clipped, and `firstTouchedMs` is written once and never moved.
 */
export function mergeMarks(
  agenda: Agenda,
  marks: readonly AgendaMark[],
  atMs: number,
): { agenda: Agenda; changed: boolean } {
  // Work on COPIES from the first line: the caller still holds the agenda it passed in (the
  // runner compares versions, the HTTP layer may be serving it), and mutating that in place
  // would move boxes under a reader that never asked for an update.
  const items = agenda.items.map((i) => ({ ...i }));
  const byId = new Map(items.map((i) => [i.id, i]));
  let changed = false;
  for (const mark of marks) {
    const item = byId.get(mark.id);
    if (!item) continue;
    if (RANK[mark.status] <= RANK[item.status]) continue;
    const evidence = tidy(mark.evidence, MAX_EVIDENCE_CHARS);
    if (!evidence) continue;
    item.status = mark.status;
    item.evidence = evidence;
    if (item.firstTouchedMs === undefined) item.firstTouchedMs = atMs;
    if (mark.status === 'covered' && item.coveredMs === undefined) item.coveredMs = atMs;
    changed = true;
  }
  if (!changed) return { agenda, changed: false };
  return { agenda: { items, version: agenda.version + 1 }, changed: true };
}

/** How the checklist reads at a glance — the extension's header line. */
export function agendaProgress(agenda: Agenda): { covered: number; touched: number; open: number; total: number } {
  let covered = 0;
  let touched = 0;
  for (const i of agenda.items) {
    if (i.status === 'covered') covered++;
    else if (i.status === 'touched') touched++;
  }
  return { covered, touched, open: agenda.items.length - covered - touched, total: agenda.items.length };
}

// ── the prompt ───────────────────────────────────────────────────────────────────────────────
// Mechanism here in code; the judgement is the model's. The frame is deliberately strict about
// the two ways this feature can lie to a user: ticking a box because the agenda SAYS so (rather
// than because anyone said so), and inventing an id.

const COVERAGE_FRAME = (
  'You are tracking whether a live meeting has covered its agenda. The meeting is happening in a ' +
  'room right now; the transcript below is what the microphone has heard most recently, so it is ' +
  'rough, unpunctuated in places, and has no speaker names.\n\n' +
  'AGENDA — these are the only ids that exist:\n{items}\n\n' +
  'RECENT TRANSCRIPT:\n"""\n{transcript}\n"""\n\n' +
  'For each agenda line, judge ONLY from the transcript above whether this excerpt moved it:\n' +
  '  "covered" — it was genuinely discussed and reached a conclusion, decision or clear answer.\n' +
  '  "touched" — it came up, or was started, but nothing was settled.\n' +
  'Leave an item OUT of your answer entirely when this excerpt says nothing about it. Never mark ' +
  'an item because the agenda wording resembles the topic — somebody must actually have talked ' +
  'about it. Never mark an item because it was announced as the next topic; being introduced is ' +
  'not being discussed.\n\n' +
  'Respond with ONLY this JSON object, no prose and no markdown fence:\n' +
  '{"marks":[{"id":"<an id above>","status":"covered|touched",' +
  '"evidence":"<up to 140 characters quoted from the transcript>"}]}\n' +
  'Use an empty marks array if this excerpt moved nothing.'
);

/** Render the open part of the checklist for the prompt. Covered lines are omitted: they can
 *  never move again (monotonicity), so spending prompt on them only invites re-marking noise. */
export function promptItems(agenda: Agenda): string {
  return agenda.items
    .filter((i) => i.status !== 'covered')
    .map((i) => `[${i.id}] (${i.status}) ${i.text}`)
    .join('\n');
}

/** The full coverage prompt, or null when there is nothing to ask about (everything covered,
 *  or no speech since the last pass). Returning null is how the runner skips an LLM call. */
export function buildCoveragePrompt(agenda: Agenda, transcript: string): string | null {
  const items = promptItems(agenda);
  const text = transcript.trim();
  if (!items || !text) return null;
  return COVERAGE_FRAME.replace('{items}', items).replace('{transcript}', text);
}

/**
 * Pull the marks out of a model reply. Tolerant by design — a model that wraps JSON in a fence
 * or a sentence is answering correctly enough, and a reply we cannot parse must mean "nothing
 * moved", never a crash in a live meeting.
 */
export function parseCoverageReply(reply: string | null | undefined): AgendaMark[] {
  const raw = String(reply ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const arr = (parsed as { marks?: unknown })?.marks;
  if (!Array.isArray(arr)) return [];
  const marks: AgendaMark[] = [];
  for (const entry of arr) {
    const m = (entry ?? {}) as Record<string, unknown>;
    const id = tidy(m.id, 16);
    const status = m.status === 'covered' || m.status === 'touched' ? m.status : null;
    if (!id || !status) continue;
    const mark: AgendaMark = { id, status };
    const evidence = tidy(m.evidence, MAX_EVIDENCE_CHARS);
    if (evidence) mark.evidence = evidence;
    marks.push(mark);
  }
  return marks;
}
