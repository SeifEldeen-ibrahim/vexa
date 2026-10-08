/**
 * capture-codec.ts — the capture.v1 audio frame, encoder side.
 *
 * MIRRORS `@vexa/capture-codec` (core/meetings/modules/capture-codec), which is the SSOT for this
 * wire format and holds the decoder the service uses. It is reimplemented here, in ten lines,
 * rather than depended on, because this extension is a standalone npm package (like
 * clients/extension) and must build without the pnpm workspace.
 *
 * The format is frozen:
 *   int32  LE  speakerIndex      (1000 = the local microphone)
 *   float64 LE ts                (ms; the capture clock — the receiver uses it as-is)
 *   float32[] LE PCM             (mono, 16 kHz, -1..1)
 */

export const AUDIO_HEADER_BYTES = 12;

/** The channel the local microphone speaks on. In this lane it IS the room. */
export const MIC_CHANNEL = 1000;

export function encodeAudioFrame(speakerIndex: number, ts: number, pcm: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(AUDIO_HEADER_BYTES + pcm.length * 4);
  const view = new DataView(buf);
  view.setInt32(0, speakerIndex, true);
  view.setFloat64(4, ts, true);
  new Float32Array(buf, AUDIO_HEADER_BYTES).set(pcm);
  return buf;
}

/** Decoder — used by the tests (and handy for debugging a tape). */
export function decodeAudioFrame(buf: ArrayBuffer):
  { speakerIndex: number; ts: number; samples: Float32Array } | null {
  if (buf.byteLength < AUDIO_HEADER_BYTES || (buf.byteLength - AUDIO_HEADER_BYTES) % 4 !== 0) return null;
  const view = new DataView(buf);
  return {
    speakerIndex: view.getInt32(0, true),
    ts: view.getFloat64(4, true),
    samples: new Float32Array(buf.slice(AUDIO_HEADER_BYTES)),
  };
}
