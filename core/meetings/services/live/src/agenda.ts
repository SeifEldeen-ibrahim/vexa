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

/** The alphanumeric word trigrams of a quote. Enough to recognise the same remark clipped
 *  differently ("two big deals slipped, one pushed to next month" vs "big deals slipped, one
 *  pushed") while telling it apart from a different remark about the same topic. Punctuation,
 *  case, curly quotes and the transcriber's hyphens all normalise away, because the model
 *  re-types a quote as often as it copies one. A quote too short to have a trigram is compared
 *  whole — three words are not evidence of much anyway. */
function shingles(quote: string): Set<string> {
  const words = quote.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length < 3) return new Set(words.length ? [words.join(' ')] : []);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i++) out.add(words.slice(i, i + 3).join(' '));
  return out;
}

/** Is this the same piece of speech, rather than a different remark? Containment over the
 *  SHORTER quote, so a clip of a remark counts as that remark however much the other side
 *  carries with it. */
function sameRemark(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const g of small) if (big.has(g)) shared++;
  return shared / small.size >= 0.6;
}

/**
 * Apply the evaluator's marks to the agenda. Returns a NEW agenda (and whether anything
 * actually moved, so the caller can skip a publish).
 *
 * The rules, all of them:
 *   • an unknown id is dropped — the model may not invent checklist lines;
 *   • a mark that does not RAISE the rank is dropped (the monotonicity promise);
 *   • a raise with no evidence is dropped: an unverifiable tick is worse than no tick;
 *   • ONE REMARK COVERS ONE LINE: a "covered" whose quote is the same piece of speech that
 *     already earned another line is capped at "touched" (see below);
 *   • evidence is clipped, and `firstTouchedMs` is written once and never moved.
 *
 * THE ONE-REMARK RULE. "Two big deals slipped, one pushed to next month" was returned as the
 * evidence for four separate lines of a sales 1:1 — last week's misses, progress on deals, deals
 * closing this week, and blockers — which is how a call a minute and a half old reported 9 of its
 * 11 points covered. The prompt asks the model not to do this (`SEPARATION`) and that halves it,
 * but it cannot finish the job: each pass is judged alone, so two passes can spend the same
 * sentence on two lines without either answer being wrong in itself. This merge is the only place
 * that sees every quote the call has already spent, so the cap lives here.
 *
 * Capped, not dropped: the remark really does show the topic came up, so the line moves to
 * "touched" and keeps the quote. It can still reach "covered" later on a quote of its own — which
 * is exactly what happens when the meeting actually gets to it. First claim wins, because nothing
 * here can tell which line a remark was more about; what matters is that it only counts once.
 * Only "covered" is capped: a passing remark may honestly touch several lines at once.
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
  // What each line has already spent, so a second line cannot spend it again.
  const claimed = new Map<string, Set<string>>();
  for (const i of items) if (i.evidence) claimed.set(i.id, shingles(i.evidence));
  let changed = false;
  for (const mark of marks) {
    const item = byId.get(mark.id);
    if (!item) continue;
    const evidence = tidy(mark.evidence, MAX_EVIDENCE_CHARS);
    if (!evidence) continue;
    const quote = shingles(evidence);
    let status = mark.status;
    if (status === 'covered') {
      for (const [id, spent] of claimed) {
        if (id !== item.id && sameRemark(quote, spent)) { status = 'touched'; break; }
      }
    }
    if (RANK[status] <= RANK[item.status]) continue;
    item.status = status;
    item.evidence = evidence;
    claimed.set(item.id, quote);
    if (item.firstTouchedMs === undefined) item.firstTouchedMs = atMs;
    if (status === 'covered' && item.coveredMs === undefined) item.coveredMs = atMs;
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

const SCALE = (
  '  "covered" — the point was actually addressed, WITH the substance it asks for: the figures, ' +
  'the names, the reasons, the answer. A decision is NOT required — most agenda lines ask for an ' +
  'update, and an update that was given is covered.\n' +
  '  "touched" — the point came up but was not worked through: raised and left unanswered, asked ' +
  'and deflected, promised for later, or mentioned in passing. When you can tell the topic arose ' +
  'but not what the meeting said about it, this is the honest answer.\n' +
  // Makes the evidence do double duty: it stops being a citation the model attaches after
  // deciding, and becomes the thing the decision has to survive. A reader of the record applies
  // exactly this test — "does that quote show they dealt with it?" — so the judge should too.
  'Your quote has to be the speech that DOES the covering: the words carrying the figures, the ' +
  'facts, the answer or the decision. If the best quote you can find does not itself contain ' +
  'what the line asked for, the line is "touched", not "covered".\n'
  // A rule for the half-answered line ("key wins AND missed opportunities" where only the wins
  // were given) was tried here and measured: it changed nothing on the real fixture, so it is not
  // in the prompt. eval/README.md has the numbers and the harness to retry the idea.
);

/** The two mistakes that make this feature lie, stated to the model because neither is
 *  detectable in code: ticking a line because the AGENDA says so rather than because anyone
 *  said so, and ticking a line that was merely announced as what comes next. */
const HONESTY = (
  'Judge only from the transcript. Leave a line out of your answer entirely when the transcript ' +
  'says nothing about it. Never mark a line because its wording resembles the topic — somebody ' +
  'must actually have talked about it — and never mark one because it was announced as the next ' +
  'thing to discuss: being introduced is not being discussed. A line the transcript says was ' +
  'SKIPPED, deferred, or not reached ("we did not get to the timeline") stays out of your answer ' +
  'too: saying a thing was not discussed is not discussing it.\n' +
  // This clause used to sit in SCALE, on the "touched" side, as a reason TO mark — and it
  // contradicted the sentence above it. On a written 1:1 where nobody asked for help, "support
  // needed from the manager" was marked on "I will chase the pricing note with marketing", a
  // remark made while agreeing next steps. The manager was indeed offering support; nobody had
  // raised the agenda line. Implication has to mean leave it out, or "never mark on resemblance"
  // means nothing.
  'A line that is only IMPLIED — something a remark made for another purpose would let you infer, ' +
  'rather than something the meeting raised — stays out of your answer as well. Somebody has to ' +
  'have put the subject on the table.\n'
);

/** The over-marking guard, and the mirror image of HONESTY's under-marking one. Measured, not
 *  guessed: on a sales 1:1 that had barely started, ONE remark — "two big deals slipped, one
 *  pushed to next month" — was returned as the evidence for four separate lines (last week's
 *  misses, progress on deals, deals closing this week, blockers), and a pipeline figure covered
 *  three more, so a dozen sentences scored 9 of 11 covered. Nothing in code can tell a quote that
 *  earned its line from the same quote spread across four, because both are real speech; the
 *  model is the only thing that sees all the lines at once, so the rule belongs here. */
const SEPARATION = (
  'Each line is judged on its own words, and ONE remark cannot cover several lines. If the quote ' +
  'you would give for a line is the same remark you already used for a different line, that ' +
  'remark belongs to the other line and this one is at most "touched". When a line sits between ' +
  'the two, choose "touched": calling a line covered tells the people in the room they can move ' +
  'on, and that is the one mistake they cannot catch by reading their own agenda.\n'
);

const JSON_SHAPE = (
  'Respond with ONLY this JSON object, no prose and no markdown fence:\n' +
  '{"marks":[{"id":"<an id above>","status":"covered|touched",' +
  '"evidence":"<up to 140 characters quoted from the transcript>"}]}\n' +
  'Use an empty marks array when the transcript speaks to none of these lines.'
);

const COVERAGE_FRAME = (
  'You are tracking whether a live meeting has covered its agenda. The meeting is happening in a ' +
  'room right now; the transcript below is what the microphone has heard most recently, so it is ' +
  'rough, unpunctuated in places, and has no speaker names.\n\n' +
  'AGENDA — these are the only ids that exist:\n{items}\n\n' +
  'RECENT TRANSCRIPT:\n"""\n{transcript}\n"""\n\n' +
  'For every agenda line this transcript speaks to, say where it now STANDS:\n' + SCALE + HONESTY + SEPARATION +
  // The unlock. The frame used to ask what this excerpt had MOVED, which the model read as "report
  // only what is new" — and since each pass sees a window that overlaps the last one heavily, the
  // honest answer to that question is almost always "nothing". A real 11-point sales 1:1 came out
  // 0 covered / 5 started / 6 untouched across 14 passes that each saw the whole conversation.
  // Asking for STANDING instead costs nothing, because `mergeMarks` already forbids a regression:
  // a repeated judgement is a no-op, a withheld one is lost for good.
  'Report a line\'s standing even if an earlier pass already reported it. Marks only ever move ' +
  'forward, so repeating one costs nothing while withholding one loses it.\n\n' + JSON_SHAPE
);

/** The end-of-call review. Same scale, same honesty, but ONE pass over the whole meeting rather
 *  than a sliding window — which is the only pass that can see a point raised at minute two and
 *  answered at minute forty. The live passes exist for the live panel; this one is what the
 *  stored record is judged on. */
const REVIEW_FRAME = (
  'A meeting has just ended. Below is what was said in it and the agenda the people in the room ' +
  'set beforehand. Decide, line by line, what the meeting actually did with each one. This is the ' +
  'record they will read afterwards, so it must match what a careful person would conclude from ' +
  'reading the transcript themselves.\n\n' +
  'AGENDA — these are the only ids that exist:\n{items}\n\n' +
  'TRANSCRIPT:\n"""\n{transcript}\n"""\n\n' +
  'For each line:\n' + SCALE + HONESTY + SEPARATION + '\n' + JSON_SHAPE
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
  return fill(COVERAGE_FRAME, agenda, transcript);
}

/** The whole-meeting review prompt, or null when there is nothing left to judge. */
export function buildReviewPrompt(agenda: Agenda, transcript: string): string | null {
  return fill(REVIEW_FRAME, agenda, transcript);
}

function fill(frame: string, agenda: Agenda, transcript: string): string | null {
  const items = promptItems(agenda);
  const text = transcript.trim();
  if (!items || !text) return null;
  return frame.replace('{items}', items).replace('{transcript}', text);
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
