/**
 * offscreen.ts — microphone capture, in an offscreen document.
 *
 * MV3 service workers have no DOM and are killed when idle, so `getUserMedia` and the
 * AudioContext cannot live there: the capture would stop mid-meeting the moment the worker went
 * to sleep. An offscreen document outlives that, and outlives the side panel too — so closing
 * the panel does not stop the recording.
 *
 * Chain: getUserMedia → AudioContext(16 kHz) → AudioWorklet → 'pcm' messages to the worker,
 * which frames and sends them. The worklet module is loaded from a web-accessible extension URL,
 * NOT a blob: — MV3's extension-page CSP forbids blob: in worker-src, and the symptom is a
 * silently dead microphone ("Unable to load a worklet's module").
 */
const TARGET_SAMPLE_RATE = 16000;

let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let node: AudioWorkletNode | null = null;

async function start(): Promise<{ ok: boolean; error?: string }> {
  if (stream) return { ok: true };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // A room, not a headset: keep the processing that helps a far-field microphone and leave
        // the rest to the transcriber.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (err) {
    const e = err as Error;
    return { ok: false, error: e.name === 'NotAllowedError' ? 'microphone-permission' : (e.name || String(e)) };
  }

  ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  try {
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('nexus-pcm-worklet.js'));
  } catch (err) {
    await stop();
    return { ok: false, error: `worklet: ${(err as Error)?.message ?? err}` };
  }
  const source = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, 'nexus-pcm');
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const pcm = event.data;
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i]);
      if (a > peak) peak = a;
    }
    // Structured-clone a plain array: chrome.runtime messages are JSON, so a Float32Array would
    // arrive as an object with numeric keys.
    chrome.runtime.sendMessage({
      type: 'pcm',
      pcm: Array.from(pcm),
      peak,
      ts: Date.now(),
    }).catch(() => { /* the worker is asleep or the call ended */ });
  };
  source.connect(node);
  // Not connected to the destination: this is capture, and routing the room's own microphone
  // back out of the speakers would be feedback.
  return { ok: true };
}

async function stop(): Promise<{ ok: true }> {
  try {
    node?.port.close();
    node?.disconnect();
  } catch { /* already gone */ }
  node = null;
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
  try {
    await ctx?.close();
  } catch { /* already closed */ }
  ctx = null;
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'start-capture') {
    start().then(respond);
    return true;
  }
  if (msg.type === 'stop-capture') {
    stop().then(respond);
    return true;
  }
  return false;
});
