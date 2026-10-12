/**
 * live-speech.mjs — the end-to-end test the frame-counting smoke test cannot be.
 *
 * live-smoke.mjs proves the socket accepts audio and that the judge answers a prompt. It sends
 * noise, so it never proves the thing an operator actually cares about: that REAL SPEECH, spoken
 * into a room, comes back as text and moves the right checklist lines. Swapping either provider
 * (the transcriber or the judge) can pass every smoke check and still produce a meeting that
 * transcribes to nothing.
 *
 * So this one synthesises speech, streams it through the production ingest socket at real time,
 * and scores the result against a KNOWN answer: the dialogue is eval/fixtures/sales-1to1-scripted,
 * written to a designed outcome of 7 covered / 3 started / 1 not yet.
 *
 *   cd deploy/compose && node tests/live-speech.mjs
 *
 * It costs a TTS call, a few minutes of transcription and a handful of judge passes.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(here, '..', '.env');
const FIXTURE = join(here, '..', '..', '..', 'core', 'meetings', 'services', 'live', 'eval', 'fixtures', 'sales-1to1-scripted.json');

const LIVE = (process.env.LIVE_BASE || 'http://127.0.0.1:18120').replace(/\/+$/, '');
const ADMIN = (process.env.ADMIN_BASE || 'http://127.0.0.1:18057').replace(/\/+$/, '');
const EMAIL = process.env.SMOKE_EMAIL || 'live-smoke@biami.io';
const RATE = 16000;

let failures = 0;
const ok = (n, d = '') => console.log(`  ✓ ${n}${d ? ` — ${d}` : ''}`);
const bad = (n, d = '') => { failures++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); };
const check = (c, n, d = '') => (c ? ok(n, d) : bad(n, d));
const json = async (r) => { const t = await r.text(); try { return t ? JSON.parse(t) : null; } catch { return t; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function env() {
  const out = {};
  for (const line of (await readFile(ENV_PATH, 'utf8')).split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function mintToken(adminToken) {
  const headers = { 'Content-Type': 'application/json', 'X-Admin-API-Key': adminToken };
  let user = await json(await fetch(`${ADMIN}/admin/users/email/${encodeURIComponent(EMAIL)}`, { headers }));
  if (!user?.id) user = await json(await fetch(`${ADMIN}/admin/users`, { method: 'POST', headers, body: JSON.stringify({ email: EMAIL }) }));
  const minted = await json(await fetch(`${ADMIN}/admin/users/${user.id}/tokens?scopes=bot,tx&name=live-speech`, { method: 'POST', headers }));
  if (!minted?.token) throw new Error('could not mint a token');
  return minted.token;
}

function encodeAudioFrame(speakerIndex, ts, pcm) {
  const buf = new ArrayBuffer(12 + pcm.length * 4);
  const view = new DataView(buf);
  view.setInt32(0, speakerIndex, true);
  view.setFloat64(4, ts, true);
  new Float32Array(buf, 12).set(pcm);
  return buf;
}

/** OpenAI TTS → 24 kHz signed 16-bit mono PCM → the 16 kHz float frames capture.v1 carries.
 *  Linear interpolation is ample: this is speech for a speech recogniser, not mastering. */
async function speak(text, key, voice) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'pcm' }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const raw = Buffer.from(await res.arrayBuffer());
  const src = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  const outLen = Math.floor(src.length * (RATE / 24000));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * (24000 / RATE);
    const a = src[Math.floor(x)] ?? 0;
    const b = src[Math.min(Math.ceil(x), src.length - 1)] ?? 0;
    out[i] = ((a + (b - a) * (x - Math.floor(x))) / 32768);
  }
  return out;
}

async function main() {
  const cfg = await env();
  const key = cfg.NEXUS_LIVE_LLM_TOKEN || cfg.OPENAI_JUDGE_KEY;
  if (!key) throw new Error('no OpenAI key in .env for text-to-speech');
  const fx = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const script = fx.segments.map((s) => s.text).join(' ');

  console.log('nexus live — SPEECH end to end');
  console.log(`  transcriber ${cfg.TRANSCRIPTION_SERVICE_URL}  (${cfg.TRANSCRIPTION_MODEL})`);
  console.log(`  judge       ${cfg.NEXUS_LIVE_LLM_URL}  (${cfg.NEXUS_LIVE_LLM_MODEL})`);
  console.log(`  script      ${fx.name}, ${script.length} chars, designed answer 7 covered / 3 started / 1 not yet\n`);

  const pcm = await speak(script, key, 'alloy');
  const seconds = pcm.length / RATE;
  check(seconds > 30, 'speech synthesised', `${seconds.toFixed(1)}s of audio`);

  const token = await mintToken(cfg.ADMIN_TOKEN);
  const auth = { 'X-API-Key': token, 'Content-Type': 'application/json' };
  const started = await json(await fetch(`${LIVE}/sessions`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ title: 'Live speech test', agenda: fx.agenda }),
  }));
  check(started?.session_uid, 'call started', `meeting ${started?.meeting_id}`);

  const wsUrl = `${LIVE.replace(/^http/, 'ws')}/ingest?session=${encodeURIComponent(started.session_uid)}`;
  const sock = new WebSocket(wsUrl, ['capture.v1', `nexus-token.${token}`]);
  await new Promise((res, rej) => {
    sock.addEventListener('open', res, { once: true });
    sock.addEventListener('error', () => rej(new Error('socket refused')), { once: true });
  });
  ok('capture socket attached');

  // Real time, in quarter-second frames, exactly as the extension does it — so the coverage
  // runner's 20s cadence is exercised rather than bypassed.
  const FRAME = RATE / 4;
  const base = Date.now();
  let sent = 0;
  for (let off = 0; off + FRAME <= pcm.length; off += FRAME) {
    sock.send(encodeAudioFrame(1000, base + sent * 250, pcm.subarray(off, off + FRAME)));
    sent++;
    if (sent % 4 === 0) {
      await sleep(1000);
      if (sent % 40 === 0) {
        const s = await json(await fetch(`${LIVE}/sessions/${started.session_uid}`, { headers: auth }));
        console.log(`    ${String(Math.round(sent / 4)).padStart(3)}s  ${s?.transcript_lines ?? 0} lines  `
          + `${s?.progress?.covered ?? 0} covered · ${s?.progress?.touched ?? 0} started  `
          + `(passes ${s?.coverage?.passes ?? 0}, failures ${s?.coverage?.failures ?? 0})`);
      }
    }
  }
  console.log(`    sent ${sent} frames (${(sent / 4).toFixed(0)}s)`);

  await sleep(6000);
  const live = await json(await fetch(`${LIVE}/sessions/${started.session_uid}`, { headers: auth }));
  check((live?.transcript_lines ?? 0) > 5, 'the transcriber turned speech into text', `${live?.transcript_lines} lines`);
  check((live?.coverage?.failures ?? 1) === 0, 'every judge pass was answered',
    `passes ${live?.coverage?.passes}, failures ${live?.coverage?.failures}`);

  const transcript = await json(await fetch(`${LIVE}/sessions/${started.session_uid}/transcript`, { headers: auth }));
  const text = (transcript?.lines ?? []).map((l) => l.text).join(' ');
  // Words a recogniser can only produce from this script — proof it heard THIS meeting.
  const anchors = ['Harlow', 'Kemble', 'Ashgrove', 'Peterson', 'proposal', 'pipeline'];
  const heard = anchors.filter((w) => new RegExp(w, 'i').test(text));
  check(heard.length >= 3, 'it heard THIS meeting, not a plausible one', `${heard.length}/${anchors.length}: ${heard.join(', ')}`);

  sock.close();
  const stopped = await json(await fetch(`${LIVE}/sessions/${started.session_uid}/end`, { method: 'POST', headers: auth }));
  check(stopped?.status === 'ended', 'call ended');
  await sleep(4000);

  const hist = await json(await fetch(`${LIVE}/history`, { headers: auth }));
  const row = (hist?.sessions ?? []).find((s) => s.meeting_id === started.meeting_id);
  const items = row?.agenda?.items ?? [];
  const got = { covered: 0, touched: 0, open: 0 };
  for (const i of items) got[i.status === 'covered' ? 'covered' : i.status === 'touched' ? 'touched' : 'open']++;
  console.log(`\n  FINAL  ${got.covered} covered · ${got.touched} started · ${got.open} not yet`
    + `   (designed: 7 covered · 3 started · 1 not yet)\n`);
  let exact = 0;
  for (const i of items) {
    const want = fx.expected[i.id] ?? 'open';
    if (want === i.status) exact++;
    console.log(`  ${want === i.status ? ' ' : '✗'} ${i.id.padEnd(4)} want ${want.padEnd(8)} got ${i.status.padEnd(8)} `
      + `${i.text.slice(0, 38).padEnd(40)}${(i.evidence ?? '').slice(0, 46)}`);
  }
  console.log();
  check(got.covered > 0, 'the checklist actually moved from real speech', `${exact}/${items.length} lines match the designed answer`);
  check(exact >= 7, 'the judge broadly agrees with the designed answer', `${exact}/${items.length}`);

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(`\nFAILED: ${err?.message ?? err}`); process.exit(1); });
