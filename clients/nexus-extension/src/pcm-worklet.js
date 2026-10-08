/**
 * nexus-pcm-worklet.js — the audio-thread half of microphone capture.
 *
 * Runs in the AudioWorklet (audio thread), batches the 128-sample render quanta into ~0.25 s
 * chunks, and posts them to the document. A ScriptProcessor would do this on the main thread and
 * duplicate buffers under load — the stutter that makes a transcript repeat itself.
 *
 * No resampling: the AudioContext is created AT 16 kHz, so what arrives here is already the rate
 * the transcriber wants.
 */
const CHUNK = 4096; // ~0.26 s at 16 kHz

class NexusPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(CHUNK);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(CHUNK - this.filled, channel.length - offset);
      this.buffer.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === CHUNK) {
        // Copy: the buffer is reused immediately, and a transferred view would be detached.
        this.port.postMessage(this.buffer.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('nexus-pcm', NexusPcmProcessor);
