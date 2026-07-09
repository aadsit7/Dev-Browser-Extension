// Randy — computer-audio transcription worker (Manifest V3, fully local code).
//
// This is the in-browser Whisper transcriber for the two-way / "share computer
// audio" path, so Randy can hear the OTHER side of a call even on headphones.
//
// WHY THIS IS A REAL FILE (not a Blob, and not a CDN import):
//   The MV3 content-security-policy (script-src 'self') forbids a worker from
//   importing remote code, which is exactly why the previous CDN-based worker
//   silently fell back to mic-only. Everything this worker needs is now vendored
//   inside the extension:
//     - lib/transformers/transformers.min.js  (Transformers.js, self-contained ESM)
//     - lib/transformers/ort-wasm-simd-threaded.jsep.mjs  (ONNX Runtime glue)
//     - lib/transformers/ort-wasm-simd-threaded.jsep.wasm (ONNX Runtime, WASM+WebGPU)
//   import.meta.url is this file's chrome-extension:// URL, so the relative
//   import and wasmPaths below resolve to those bundled files. No code is ever
//   fetched from the network; only the model WEIGHTS download once from the
//   Hugging Face hub on first use (then the browser caches them). Audio never
//   leaves the machine.
//
// The message protocol is unchanged from the old worker, so panel.js's
// onWhisperMessage() handler needs no edits:
//   → { type:'init' }                              (host asks us to load)
//   ← { type:'ready', device }                     (model loaded; 'webgpu'|'wasm')
//   ← { type:'error', error }                      (couldn't load — host falls back to mic)
//   → { type:'transcribe', id, final, audio }      (Float32 16 kHz PCM to transcribe)
//   ← { type:'result', id, final, text }           (transcript, possibly '')

import { pipeline, env } from './lib/transformers/transformers.min.js';

// Weights come from the Hugging Face hub (allowRemoteModels stays on); we only
// forbid the LOCAL-model lookup, which would otherwise 404 against the
// extension. Serve the ONNX Runtime (JS glue + .wasm) from our bundled copy so
// nothing but the weights is ever fetched, and the CSP ('self' +
// 'wasm-unsafe-eval') is satisfied.
env.allowLocalModels = false;
try { env.backends.onnx.wasm.numThreads = 1; } catch (e) {}   // no cross-origin isolation needed
try { env.backends.onnx.wasm.wasmPaths = new URL('./lib/transformers/', import.meta.url).href; } catch (e) {}

const MODEL = 'onnx-community/whisper-base.en';
let asr = null;
let device = '';

async function build(dev) {
  return await pipeline('automatic-speech-recognition', MODEL, {
    device: dev,
    dtype: dev === 'webgpu' ? 'fp32' : 'q8'
  });
}

async function init() {
  // Prefer WebGPU (real-time on capable machines); fall back to WASM/CPU, which
  // works everywhere but slower. If both fail, the host tears the tap down and
  // stays on the microphone — exactly the old behaviour.
  try { asr = await build('webgpu'); device = 'webgpu'; }
  catch (e) {
    try { asr = await build('wasm'); device = 'wasm'; }
    catch (e2) { self.postMessage({ type: 'error', error: String((e2 && e2.message) || e2) }); return; }
  }
  self.postMessage({ type: 'ready', device: device });
}

self.onmessage = async (ev) => {
  const d = ev.data || {};
  if (d.type === 'init') { await init(); return; }
  if (d.type === 'transcribe') {
    if (!asr) { self.postMessage({ type: 'result', id: d.id, final: d.final, text: '' }); return; }
    try {
      // NB: MODEL is whisper-base.EN, an English-only model. Transformers.js
      // v3 THROWS if you pass `language`/`task` to an English-only model, so we
      // deliberately omit them (English transcription is implicit). Passing
      // them was a latent bug in the old CDN worker that never surfaced because
      // the MV3 CSP stopped that worker from ever running.
      //
      // no_repeat_ngram_size stops Whisper's classic failure mode on call
      // audio: looping a word or short clause ("patching patching patching…")
      // until the segment ends. Greedy decoding (num_beams 1) stays fast for
      // live use; the repetition guard is the cheap, high-value accuracy win.
      const out = await asr(d.audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: false, no_repeat_ngram_size: 3, num_beams: 1 });
      const text = ((out && out.text) || '').trim();
      self.postMessage({ type: 'result', id: d.id, final: d.final, text: text });
    } catch (err) {
      self.postMessage({ type: 'result', id: d.id, final: d.final, text: '', error: String((err && err.message) || err) });
    }
  }
};
