/**
 * panel.ts — the side panel. A VIEW over the service worker's state, nothing more: it holds no
 * call state of its own, so closing and reopening it mid-meeting shows exactly what is happening.
 *
 * The side panel (rather than a popup) is the surface on purpose: a popup closes the instant you
 * click anything else, and this is a thing you glance at WHILE talking to people.
 */
import {
  audioHealth, clock, historyWhen, progressBars, progressLine, sortForDisplay, whenCovered,
} from './agenda-view.js';
import type {
  AgendaTemplate, ExtensionState, HistoryRow, Progress, SavedChecklist, SessionSnapshot,
} from './types.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  tabs: $('tabs'),
  account: $('account'),
  accountBtn: $<HTMLButtonElement>('account-btn'),
  views: {
    signin: $('view-signin'),
    new: $('view-new'),
    live: $('view-live'),
    done: $('view-done'),
    templates: $('view-templates'),
    history: $('view-history'),
  },
  signin: $<HTMLButtonElement>('signin'),
  signinError: $('signin-error'),
  title: $<HTMLInputElement>('title'),
  agenda: $<HTMLTextAreaElement>('agenda'),
  agendaCount: $('agenda-count'),
  savedWrap: $('saved-wrap'),
  saved: $('saved'),
  tplPickWrap: $('tpl-pick-wrap'),
  tplPick: $('tpl-pick'),
  tplList: $('tpl-list'),
  tplFormTitle: $('tpl-form-title'),
  tplName: $<HTMLInputElement>('tpl-name'),
  tplItems: $<HTMLTextAreaElement>('tpl-items'),
  tplCount: $('tpl-count'),
  tplSave: $<HTMLButtonElement>('tpl-save'),
  tplCancel: $<HTMLButtonElement>('tpl-cancel'),
  tplError: $('tpl-error'),
  start: $<HTMLButtonElement>('start'),
  startError: $('start-error'),
  micNote: $('mic-note'),
  grantMic: $<HTMLButtonElement>('grant-mic'),
  liveTitle: $('live-title'),
  clock: $('clock'),
  progress: $('progress'),
  audioDot: $('audio-dot'),
  audioState: $('audio-state'),
  checklist: $('checklist'),
  transcript: $('transcript'),
  stop: $<HTMLButtonElement>('stop'),
  liveError: $('live-error'),
  doneTitle: $('done-title'),
  doneProgress: $('done-progress'),
  doneChecklist: $('done-checklist'),
  newCall: $<HTMLButtonElement>('new-call'),
  historyList: $('history-list'),
  notice: $('notice'),
};

type Tab = 'call' | 'templates' | 'history';
let tab: Tab = 'call';

/** Switch tabs from anywhere — the tab bar, or "Use for a call" jumping to the filled checklist. */
function selectTab(next: Tab): void {
  tab = next;
  for (const button of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    button.classList.toggle('is-active', button.dataset.tab === next);
  }
  if (current) render(current);
}
let current: ExtensionState | null = null;
/** Shown after Stop until the user starts something else. */
let showingFinished = false;

/** Ask the worker something, and never throw. If the port closes mid-answer (Chrome restarted
 *  the service worker while it was busy), an unhandled rejection would abandon the click handler
 *  with the button still disabled and nothing on screen — which looks exactly like the extension
 *  ignoring the click. A visible failure is the minimum. */
const ask = async <T,>(message: unknown): Promise<T> => {
  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch (err) {
    const error = (err as Error)?.message || 'the Nexus background worker stopped responding';
    return { ok: false, error } as T;
  }
};

function show(view: keyof typeof el.views): void {
  for (const [name, node] of Object.entries(el.views)) node.hidden = name !== view;
}

function setError(node: HTMLElement, message: string | null): void {
  node.textContent = message ?? '';
  node.hidden = !message;
}

// ── the checklist ──────────────────────────────────────────────────────────────────────────
function renderChecklist(into: HTMLElement, snapshot: SessionSnapshot): void {
  into.replaceChildren();
  if (!snapshot.agenda.items.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No checklist for this call — Nexus is just recording.';
    into.append(empty);
    return;
  }
  for (const item of sortForDisplay(snapshot.agenda)) {
    const li = document.createElement('li');
    li.className = `item ${item.status}`;

    const box = document.createElement('span');
    box.className = 'box';
    if (item.status === 'covered') box.textContent = '✓';

    const text = document.createElement('span');
    text.className = 'text';
    text.append(document.createTextNode(item.text));
    // The quote is what makes a tick checkable rather than magic.
    if (item.evidence && item.status !== 'open') {
      const quote = document.createElement('em');
      quote.className = 'evidence';
      quote.textContent = `“${item.evidence}”`;
      text.append(quote);
    }

    li.append(box, text);
    const when = whenCovered(item);
    if (when) {
      const at = document.createElement('span');
      at.className = 'when';
      at.textContent = when;
      li.append(at);
    }
    into.append(li);
  }
}

// ── render ─────────────────────────────────────────────────────────────────────────────────
function render(state: ExtensionState): void {
  current = state;
  el.tabs.hidden = !state.connected;
  el.accountBtn.hidden = !state.connected;
  el.account.textContent = state.connected ? (state.email ?? 'signed in') : 'live meetings agenda';
  el.notice.textContent = state.notices.join(' ');
  el.notice.hidden = !state.notices.length;

  if (!state.connected) {
    show('signin');
    setError(el.signinError, state.error);
    return;
  }

  if (tab === 'templates') {
    show('templates');
    void loadTemplates();
    return;
  }

  if (tab === 'history') {
    show('history');
    void loadHistory();
    return;
  }

  if (state.phase === 'live' || state.phase === 'stopping') {
    showingFinished = false;
    show('live');
    const s = state.session;
    el.stop.disabled = state.phase === 'stopping';
    el.stop.textContent = state.phase === 'stopping' ? 'Finishing…' : 'Stop the call';
    setError(el.liveError, state.error);
    if (!s) return;
    el.liveTitle.textContent = s.title;
    el.clock.textContent = clock(s.elapsed_ms);
    el.progress.textContent = progressLine(s.progress);
    const health = audioHealth(s, 'live');
    el.audioDot.className = `dot ${health.tone}`;
    el.audioDot.title = health.text;
    el.audioState.textContent = health.text;
    renderChecklist(el.checklist, s);
    return;
  }

  if (showingFinished && state.session) {
    show('done');
    el.doneTitle.textContent = `${state.session.title} — finished`;
    el.doneProgress.textContent = progressLine(state.session.progress);
    renderChecklist(el.doneChecklist, state.session);
    return;
  }

  show('new');
  el.start.disabled = false;
  el.start.textContent = 'Start the call';
  setError(el.startError, state.error);
  el.micNote.hidden = state.micPermission !== 'denied';
  void loadChecklists();
  void loadTemplates();
}

function countItems(): number {
  return el.agenda.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length;
}

// ── data the panel fetches for itself (through the worker, which holds the credential) ──────
let checklistsLoaded = false;
async function loadChecklists(): Promise<void> {
  if (checklistsLoaded) return;
  checklistsLoaded = true;
  const res = await ask<{ ok: boolean; value?: SavedChecklist[] }>({ type: 'checklists' });
  const lists = (res?.ok && res.value) || [];
  if (!lists.length) {
    el.savedWrap.hidden = true;
    return;
  }
  el.saved.replaceChildren();
  for (const list of lists.slice(0, 6)) {
    const button = document.createElement('button');
    button.className = 'saved-item';
    button.type = 'button';
    const name = document.createElement('b');
    name.textContent = list.title;
    const sub = document.createElement('span');
    const bits = [`${list.items.length} item${list.items.length === 1 ? '' : 's'}`];
    if (list.uses > 1) bits.push(`used ${list.uses}×`);
    if (list.lastUsedAt) bits.push(historyWhen(list.lastUsedAt));
    sub.textContent = bits.filter(Boolean).join(' · ');
    button.append(name, sub);
    button.addEventListener('click', () => {
      // Fill the textarea rather than committing to it: the user's next move is usually to edit
      // one line of a list they ran last week.
      el.agenda.value = list.items.join('\n');
      if (!el.title.value.trim()) el.title.value = list.title;
      el.agendaCount.textContent = `${countItems()} items`;
      el.agenda.focus();
    });
    el.saved.append(button);
  }
  el.savedWrap.hidden = false;
}

// ── templates: the user's own named agendas ─────────────────────────────────────────────────
// Held in memory only as a render cache. Every mutation answers with the full list, so the panel
// never has to reason about what the store holds after an edit.
let templates: AgendaTemplate[] = [];
let templatesLoaded = false;
/** Set while editing an existing template, so Save replaces it instead of adding a near-copy. */
let editingId: string | null = null;

function countTemplateItems(): number {
  return el.tplItems.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length;
}

function resetTemplateForm(): void {
  editingId = null;
  el.tplName.value = '';
  el.tplItems.value = '';
  el.tplCount.textContent = '0 points';
  el.tplFormTitle.textContent = 'New template';
  el.tplCancel.hidden = true;
  setError(el.tplError, null);
}

/** Put a template into the New call checklist and go there. Deliberately NOT a one-click start:
 *  filling the box is what makes "template plus a line or two for today" the normal case. */
function useTemplate(template: AgendaTemplate): void {
  el.agenda.value = template.items.join('\n');
  if (!el.title.value.trim()) el.title.value = template.name;
  el.agendaCount.textContent = `${countItems()} items`;
  selectTab('call');
  el.agenda.focus();
}

function renderTemplates(): void {
  // The picker on the New call screen.
  el.tplPick.replaceChildren();
  for (const template of templates.slice(0, 8)) {
    const button = document.createElement('button');
    button.className = 'saved-item';
    button.type = 'button';
    const name = document.createElement('b');
    name.textContent = template.name;
    const sub = document.createElement('span');
    sub.textContent = `${template.items.length} point${template.items.length === 1 ? '' : 's'}`;
    button.append(name, sub);
    button.addEventListener('click', () => useTemplate(template));
    el.tplPick.append(button);
  }
  el.tplPickWrap.hidden = !templates.length;

  // The Templates tab.
  el.tplList.replaceChildren();
  if (!templates.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No templates yet. Name one below and list what it has to cover.';
    el.tplList.append(empty);
    return;
  }
  for (const template of templates) {
    const wrap = document.createElement('div');
    wrap.className = 'tpl-item';

    const top = document.createElement('div');
    top.className = 'tpl-top';
    const name = document.createElement('span');
    name.className = 'tpl-name';
    name.textContent = template.name;
    const count = document.createElement('span');
    count.className = 'tpl-count';
    count.textContent = `${template.items.length} point${template.items.length === 1 ? '' : 's'}`;
    top.append(name, count);

    const points = document.createElement('div');
    points.className = 'tpl-points';
    points.textContent = template.items.join(' · ');

    const actions = document.createElement('div');
    actions.className = 'tpl-actions';
    const use = document.createElement('button');
    use.className = 'primary';
    use.type = 'button';
    use.textContent = 'Use for a call';
    use.addEventListener('click', () => useTemplate(template));
    const edit = document.createElement('button');
    edit.className = 'ghost';
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => {
      editingId = template.id;
      el.tplName.value = template.name;
      el.tplItems.value = template.items.join('\n');
      el.tplCount.textContent = `${countTemplateItems()} points`;
      el.tplFormTitle.textContent = `Editing “${template.name}”`;
      el.tplCancel.hidden = false;
      el.tplName.focus();
    });
    const remove = document.createElement('button');
    remove.className = 'ghost';
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      const res = await ask<{ ok: boolean; value?: AgendaTemplate[]; error?: string }>(
        { type: 'delete-template', id: template.id },
      );
      remove.disabled = false;
      if (!res?.ok) { setError(el.tplError, res?.error ?? 'Could not delete that template'); return; }
      templates = res.value ?? [];
      if (editingId === template.id) resetTemplateForm();
      renderTemplates();
    });
    actions.append(use, edit, remove);

    wrap.append(top, points, actions);
    el.tplList.append(wrap);
  }
}

async function loadTemplates(force = false): Promise<void> {
  if (templatesLoaded && !force) {
    renderTemplates();
    return;
  }
  templatesLoaded = true;
  const res = await ask<{ ok: boolean; value?: AgendaTemplate[]; error?: string }>({ type: 'templates' });
  if (!res?.ok) {
    templatesLoaded = false; // so opening the tab again retries rather than showing nothing
    setError(el.tplError, res?.error ?? 'Could not load your templates');
    return;
  }
  templates = res.value ?? [];
  renderTemplates();
}

/** The two-tone bar: how much was covered, and how much was at least started. */
function progressBar(progress: Progress): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'bar';
  const widths = progressBars(progress);
  const started = document.createElement('i');
  started.className = 'started';
  started.style.width = `${widths.covered + widths.touched}%`;
  const covered = document.createElement('i');
  covered.className = 'covered';
  covered.style.width = `${widths.covered}%`;
  bar.append(started, covered);
  return bar;
}

async function loadHistory(): Promise<void> {
  const res = await ask<{ ok: boolean; value?: HistoryRow[]; error?: string }>({ type: 'history' });
  el.historyList.replaceChildren();
  if (!res?.ok) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = res?.error ?? 'Could not load your calls';
    el.historyList.append(p);
    return;
  }
  const rows = res.value ?? [];
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No in-person calls yet. Start one from the New call tab.';
    el.historyList.append(p);
    return;
  }
  for (const row of rows) {
    const wrap = document.createElement('div');
    wrap.className = 'history-item';

    const top = document.createElement('div');
    top.className = 'history-top';
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = row.title;
    const when = document.createElement('span');
    when.className = 'history-when';
    when.textContent = row.status === 'active' ? 'live now' : historyWhen(row.started_at);
    top.append(title, when);

    const progress = document.createElement('div');
    progress.className = 'history-progress';
    progress.textContent = progressLine(row.progress);

    wrap.append(top, progress);

    if (row.progress.total) wrap.append(progressBar(row.progress));
    el.historyList.append(wrap);
  }
}

async function loadTranscript(): Promise<void> {
  if (!current || current.phase !== 'live') return;
  const res = await ask<{ ok: boolean; value?: { lines: Array<{ text: string }> } }>({ type: 'transcript' });
  const lines = (res?.ok && res.value?.lines) || [];
  el.transcript.textContent = lines.length
    ? lines.map((l) => l.text).join('\n')
    : 'Nothing confirmed yet.';
}

// ── intents ────────────────────────────────────────────────────────────────────────────────
el.signin.addEventListener('click', async () => {
  el.signin.disabled = true;
  el.signin.textContent = 'Opening Google…';
  setError(el.signinError, null);
  try {
    const res = await ask<{ ok: boolean; error?: string }>({ type: 'connect' });
    if (!res?.ok) setError(el.signinError, res?.error ?? 'Sign-in did not finish');
  } finally {
    // Restore the button whatever happened, so a failed attempt is retryable.
    el.signin.disabled = false;
    el.signin.textContent = 'Sign in with Google';
    await refresh();
  }
});

el.accountBtn.addEventListener('click', async () => {
  await ask({ type: 'disconnect' });
  checklistsLoaded = false;
  templatesLoaded = false;
  templates = [];
  await refresh();
});

el.agenda.addEventListener('input', () => {
  const n = countItems();
  el.agendaCount.textContent = `${n} item${n === 1 ? '' : 's'}`;
});

el.start.addEventListener('click', async () => {
  const agenda = el.agenda.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  el.start.disabled = true;
  el.start.textContent = 'Starting…';
  setError(el.startError, null);
  const res = await ask<{ ok: boolean; error?: string }>({
    type: 'start',
    title: el.title.value.trim(),
    agenda,
  });
  if (!res?.ok) {
    el.start.disabled = false;
    el.start.textContent = 'Start the call';
    setError(el.startError, res?.error ?? 'Could not start the call');
  }
  await refresh();
});

el.stop.addEventListener('click', async () => {
  el.stop.disabled = true;
  el.stop.textContent = 'Finishing…';
  showingFinished = true;
  await ask({ type: 'stop' });
  await refresh();
});

el.newCall.addEventListener('click', async () => {
  showingFinished = false;
  el.title.value = '';
  el.agenda.value = '';
  el.agendaCount.textContent = '0 items';
  checklistsLoaded = false;
  templatesLoaded = false;
  templates = [];
  await refresh();
});

el.grantMic.addEventListener('click', () => void ask({ type: 'grant-mic' }));

for (const button of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  button.addEventListener('click', () => selectTab((button.dataset.tab as Tab) ?? 'call'));
}

// ── template form ──────────────────────────────────────────────────────────────────────────
el.tplItems.addEventListener('input', () => {
  el.tplCount.textContent = `${countTemplateItems()} points`;
});

el.tplCancel.addEventListener('click', () => resetTemplateForm());

el.tplSave.addEventListener('click', async () => {
  const name = el.tplName.value.trim();
  const items = el.tplItems.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!name) { setError(el.tplError, 'Give the template a name, so you can recognise it later'); return; }
  if (!items.length) { setError(el.tplError, 'List at least one thing it has to cover'); return; }
  setError(el.tplError, null);
  el.tplSave.disabled = true;
  el.tplSave.textContent = 'Saving…';
  try {
    const res = await ask<{ ok: boolean; value?: AgendaTemplate[]; error?: string }>(
      { type: 'save-template', id: editingId ?? undefined, name, items },
    );
    if (!res?.ok) { setError(el.tplError, res?.error ?? 'Could not save that template'); return; }
    templates = res.value ?? [];
    resetTemplateForm();
    renderTemplates();
  } finally {
    el.tplSave.disabled = false;
    el.tplSave.textContent = 'Save template';
  }
});

// ── the loop ───────────────────────────────────────────────────────────────────────────────
async function refresh(): Promise<void> {
  const state = await ask<ExtensionState>({ type: 'state' });
  if (state) render(state);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'state-changed' && msg.state) render(msg.state as ExtensionState);
});

// The worker announces changes, but a live call's clock has to tick on its own, and the worker
// may be asleep between polls.
setInterval(() => {
  if (current?.phase === 'live') void refresh();
}, 1000);
setInterval(() => void loadTranscript(), 5000);

void refresh();
