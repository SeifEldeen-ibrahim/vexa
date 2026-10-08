#!/usr/bin/env node
/**
 * live-smoke.mjs — prove the in-person lane on a RUNNING stack.
 *
 * What it exercises, in order, against the real services:
 *   1. /live/health reports the lane's capabilities;
 *   2. the lane is CLOSED without a token, and open with one;
 *   3. starting a call creates a real `in_person` meeting row (checked through meeting-api's
 *      internal tier, not inferred);
 *   4. the capture WebSocket authenticates over the subprotocol and accepts capture.v1 frames —
 *      the snapshot's frame counter is the proof the audio actually arrived;
 *   5. the configured coverage model answers the REAL agenda prompt with parseable marks;
 *   6. stopping finalizes: the row is `completed`, and a `session_end` rides the transcript spine.
 *
 * It does NOT prove that spoken words come out as text — that needs a human talking into a
 * microphone (or a speech fixture this repo does not carry), and it is the one step left to do by
 * hand. Everything on either side of Whisper is covered here.
 *
 * Credentials are read from deploy/compose/.env and NEVER printed.
 *
 *   node deploy/compose/tests/live-smoke.mjs
 *   LIVE_BASE=http://127.0.0.1:18120 node deploy/compose/tests/live-smoke.mjs
 */
// Node 22's built-in WebSocket (WHATWG API) — no dependency, so this script runs from anywhere.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(here, '..', '.env');

const LIVE = (process.env.LIVE_BASE || 'http://127.0.0.1:18120').replace(/\/+$/, '');
const ADMIN = (process.env.ADMIN_BASE || 'http://127.0.0.1:18057').replace(/\/+$/, '');
const MEETINGS = (process.env.MEETING_BASE || 'http://127.0.0.1:18080').replace(/\/+$/, '');
const REDIS = process.env.REDIS_BASE || 'redis://127.0.0.1:5479/0';
const EMAIL = process.env.SMOKE_EMAIL || 'live-smoke@biami.io';

let failures = 0;
const ok = (name, detail = '') => console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
const bad = (name, detail = '') => { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); };
const check = (cond, name, detail = '') => (cond ? ok(name, detail) : bad(name, detail));

async function env() {
  const text = await readFile(ENV_PATH, 'utf8');
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const json = async (res) => {
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
};

async function mintToken(adminToken) {
  const headers = { 'Content-Type': 'application/json', 'X-Admin-API-Key': adminToken };
  let user = await json(await fetch(`${ADMIN}/admin/users/email/${encodeURIComponent(EMAIL)}`, { headers }));
  if (!user?.id) {
    user = await json(await fetch(`${ADMIN}/admin/users`, {
      method: 'POST', headers, body: JSON.stringify({ email: EMAIL }),
    }));
  }
  if (!user?.id) throw new Error('could not resolve the smoke user');
  const minted = await json(await fetch(`${ADMIN}/admin/users/${user.id}/tokens?scopes=bot,tx&name=live-smoke`, {
    method: 'POST', headers,
  }));
  if (!minted?.token) throw new Error('could not mint a token');
  return { token: minted.token, userId: user.id };
}

/** The capture.v1 audio frame — mirrors @vexa/capture-codec (and the extension's encoder). */
function encodeAudioFrame(speakerIndex, ts, pcm) {
  const buf = new ArrayBuffer(12 + pcm.length * 4);
  const view = new DataView(buf);
  view.setInt32(0, speakerIndex, true);
  view.setFloat64(4, ts, true);
  new Float32Array(buf, 12).set(pcm);
  return buf;
}

/** A second of plausible room noise. Whisper will (correctly) find no words in it — the point
 *  here is that the frames are decoded and counted, not what they say. */
function noise(samples) {
  const pcm = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    pcm[i] = (Math.sin(i / 7) * 0.08 + (Math.random() - 0.5) * 0.05);
  }
  return pcm;
}

const AGENDA = ['Confirm the Q3 budget', 'Agree the launch timeline', 'Pick an owner for the migration'];

async function main() {
  console.log(`live-smoke → ${LIVE}`);
  const cfg = await env();
  if (!cfg.ADMIN_TOKEN) throw new Error('ADMIN_TOKEN is not set in deploy/compose/.env');
  if (!cfg.INTERNAL_API_SECRET) throw new Error('INTERNAL_API_SECRET is not set in deploy/compose/.env');

  // ── 1. health ──
  const health = await json(await fetch(`${LIVE}/health`));
  check(health?.ok === true, 'health is ok', `stt:${health?.capabilities?.stt} coverage:${health?.capabilities?.coverage}`);
  const coverageConfigured = health?.capabilities?.coverage === true;

  // ── 2. the lane is closed without a credential ──
  const anon = await fetch(`${LIVE}/me`);
  check(anon.status === 401, 'anonymous /me is refused', `got ${anon.status}`);
  const badKey = await fetch(`${LIVE}/me`, { headers: { 'X-API-Key': 'vxa_definitely-not-a-token' } });
  check(badKey.status === 401, 'an invalid key is refused', `got ${badKey.status}`);

  const { token, userId } = await mintToken(cfg.ADMIN_TOKEN);
  const auth = { 'X-API-Key': token, 'Content-Type': 'application/json' };
  const me = await json(await fetch(`${LIVE}/me`, { headers: auth }));
  check(me?.email === EMAIL, 'a valid key resolves to its user', me?.email);

  // ── 3. start a call ──
  const started = await json(await fetch(`${LIVE}/sessions`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ title: 'Live smoke', agenda: AGENDA }),
  }));
  if (!started?.session_uid) {
    bad('a call starts', JSON.stringify(started).slice(0, 200));
    return;
  }
  ok('a call starts', `${started.session_uid} → meeting ${started.meeting_id}`);
  check(started.agenda?.items?.length === AGENDA.length, 'the checklist is on the session');
  check(started.progress?.open === AGENDA.length, 'every item starts as "not yet"');

  // the row, as the meetings domain sees it
  const row = await json(await fetch(
    `${MEETINGS}/internal/live/sessions/${started.meeting_id}?user_id=${userId}`,
    { headers: { Authorization: `Bearer ${cfg.INTERNAL_API_SECRET}` } },
  ));
  check(row?.platform === 'in_person', 'the meeting row is on the in_person platform', row?.platform);
  check(row?.status === 'active', 'the row is live', row?.status);
  check(row?.data?.agenda?.items?.length === AGENDA.length, 'the agenda is persisted on the row');

  // ── 4. the capture socket ──
  const wsUrl = `${LIVE.replace(/^http/, 'ws')}/ingest?session=${encodeURIComponent(started.session_uid)}`;
  const refused = await new Promise((resolve) => {
    const sock = new WebSocket(wsUrl, ['capture.v1']);   // no token subprotocol
    sock.addEventListener('open', () => { sock.close(); resolve('opened'); });
    sock.addEventListener('error', () => resolve('refused'));
  });
  check(refused === 'refused', 'the capture socket refuses an unauthenticated client', refused);

  const sent = await new Promise((resolve, reject) => {
    const sock = new WebSocket(wsUrl, ['capture.v1', `nexus-token.${token}`]);
    sock.binaryType = 'arraybuffer';
    const timer = setTimeout(() => reject(new Error('the capture socket never opened')), 10000);
    sock.addEventListener('open', () => {
      clearTimeout(timer);
      check(sock.protocol === 'capture.v1', 'the server negotiates capture.v1 (never echoing the token)', sock.protocol);
      let frames = 0;
      const base = Date.now();
      // ~6 seconds of audio in 0.25 s frames, paced so the pipeline's turn logic sees real time.
      const tick = setInterval(() => {
        sock.send(encodeAudioFrame(1000, base + frames * 250, noise(4000)));
        frames++;
        if (frames >= 24) {
          clearInterval(tick);
          setTimeout(() => { sock.close(); resolve(frames); }, 500);
        }
      }, 60);
    });
    sock.addEventListener('error', (err) => { clearTimeout(timer); reject(new Error(err?.message || 'socket error')); });
  });
  ok('audio frames are accepted', `${sent} frames sent`);

  // the snapshot is the proof the service decoded and fed them
  await new Promise((r) => setTimeout(r, 1500));
  const snap = await json(await fetch(`${LIVE}/sessions/${started.session_uid}`, { headers: auth }));
  check(snap?.audio?.frames >= sent, 'the service counted the frames it received', `${snap?.audio?.frames} frames, ${snap?.audio?.seconds}s`);
  check(snap?.status === 'live', 'the call is still live');

  // ── 5. the coverage model, against the REAL prompt ──
  if (!coverageConfigured) {
    console.log('  – coverage model not configured on this deployment; skipping the model check');
  } else {
    const { buildCoveragePrompt, parseCoverageReply } = await import(
      join(here, '..', '..', '..', 'core/meetings/services/live/dist/agenda.js')
    ).catch(() => ({}));   // built by `pnpm --filter @vexa/live build`
    const transcript =
      'right, so on the budget — we went through the numbers line by line and we are all agreed on '
      + 'forty thousand for the quarter. I will send the sheet round after this. The timeline we did not '
      + 'get to yet.';
    const prompt = buildCoveragePrompt
      ? buildCoveragePrompt({ items: AGENDA.map((text, i) => ({ id: `a${i + 1}`, text, status: 'open' })), version: 0 }, transcript)
      : null;
    if (!prompt) {
      console.log('  – dist/agenda.js is not built (pnpm --filter @vexa/live build); skipping the model check');
    } else {
      const base = (cfg.NEXUS_LIVE_LLM_URL || cfg.TRANSCRIPTION_SERVICE_URL || '').replace(/\/+$/, '');
      const key = cfg.NEXUS_LIVE_LLM_TOKEN || cfg.TRANSCRIPTION_SERVICE_TOKEN;
      const model = cfg.NEXUS_LIVE_LLM_MODEL || 'openai/gpt-oss-120b';
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 512 }),
      });
      const body = await json(res);
      const reply = body?.choices?.[0]?.message?.content ?? null;
      if (!res.ok) {
        bad('the coverage model answers', `${res.status} ${JSON.stringify(body).slice(0, 160)}`);
      } else {
        const marks = parseCoverageReply(reply);
        const budget = marks.find((m) => m.id === 'a1');
        check(!!budget, 'the model marks the item the transcript actually settled', JSON.stringify(marks));
        check(!marks.some((m) => m.id === 'a2'), 'and does NOT mark the item nobody discussed');
        if (budget) check(!!budget.evidence, 'the mark carries its evidence', budget.evidence);
      }
    }
  }

  // ── 6. stop ──
  const stopped = await json(await fetch(`${LIVE}/sessions/${started.session_uid}/end`, { method: 'POST', headers: auth }));
  check(stopped?.status === 'ended', 'stopping ends the call', stopped?.status);

  const after = await json(await fetch(
    `${MEETINGS}/internal/live/sessions/${started.meeting_id}?user_id=${userId}`,
    { headers: { Authorization: `Bearer ${cfg.INTERNAL_API_SECRET}` } },
  ));
  check(after?.status === 'completed', 'the meeting row is completed', after?.status);
  check(!!after?.end_time, 'and has an end time');
  check(!!after?.data?.live_session, 'with the call summary recorded', JSON.stringify(after?.data?.live_session ?? {}).slice(0, 120));

  // the session_end marker on the spine. Redis is not published on the host (deliberately), so
  // the stream is read inside the container.
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run('docker', [
      'compose', '-p', 'vexa-v012', '-f', join(here, '..', 'docker-compose.yml'),
      'exec', '-T', 'redis',
      'valkey-cli', 'XREVRANGE', 'transcription_segments', '+', '-', 'COUNT', '40',
    ], { maxBuffer: 8 * 1024 * 1024 });
    const marker = `"type":"session_end","meeting_id":${started.meeting_id}`;
    check(stdout.includes(marker), 'a session_end rides the transcript spine');
  } catch (err) {
    console.log(`  – could not read the stream (${err.message.split('\n')[0]}); skipping the session_end check`);
  }

  // history + reusable checklists
  const history = await json(await fetch(`${LIVE}/history`, { headers: auth }));
  check(
    history?.sessions?.some((s) => s.session_uid === started.session_uid),
    'the finished call is in history',
  );
  const lists = await json(await fetch(`${LIVE}/checklists`, { headers: auth }));
  check(lists?.checklists?.some((c) => c.items.length === AGENDA.length), 'its checklist is offered for reuse');

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nsmoke run failed: ${err.message}`);
  process.exit(1);
});
