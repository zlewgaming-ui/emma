// Głos Emmy (syntezator przeglądarki) i mikrofon (Web Speech albo nagranie dla Gemini).

import { store } from './store.js';
import { arrayBufferToBase64, sleep } from './util.js';

const UA = navigator.userAgent;
export const isIOS = /iP(hone|ad|od)/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/.test(UA);

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

export function hasWebSpeech() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function hasRecorder() {
  return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

export function hasTTS() {
  return 'speechSynthesis' in window;
}

// Na iPhonie Web Speech nie działa w aplikacji z ekranu głównego, więc nagranie słyszy Gemini.
export function micEngine(forced) {
  const mode = forced || store.settings.micMode;
  if (mode === 'webspeech' && hasWebSpeech()) return 'webspeech';
  if (mode === 'gemini' && hasRecorder()) return 'gemini';
  if (isIOS && hasRecorder()) return 'gemini';
  if (hasWebSpeech()) return 'webspeech';
  if (hasRecorder()) return 'gemini';
  return 'none';
}

export function autoListenEnabled() {
  const v = store.settings.autoListen;
  return v === null || v === undefined ? !isIOS : v;
}

// ---------- Syntezator ----------
const EN_PREF = [/aria.*natural/i, /jenny.*natural/i, /ava.*natural/i, /natural/i, /google us english/i, /\bava\b/i, /samantha/i, /allison/i, /nicky/i, /zira/i, /google uk english female/i, /serena/i, /\bkate\b/i, /karen/i, /moira/i];
const PL_PREF = [/zofia.*natural/i, /natural/i, /google polski/i, /zosia/i, /\bewa\b/i, /paulina/i];
const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|rocko|shelley|sandy|grandma|grandpa|eddy|flo|reed)\b/i;

let allVoices = [];

function refreshVoices() {
  if (hasTTS()) allVoices = window.speechSynthesis.getVoices() || [];
}

if (hasTTS()) {
  refreshVoices();
  window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
}

export function voicesFor(lang) {
  refreshVoices();
  return allVoices.filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith(lang) && !NOVELTY.test(v.name));
}

function pickVoice(lang) {
  const chosen = lang === 'pl' ? store.settings.plVoice : store.settings.enVoice;
  const list = voicesFor(lang);
  if (chosen) {
    const found = list.find((v) => v.name === chosen);
    if (found) return found;
  }
  const prefs = lang === 'pl' ? PL_PREF : EN_PREF;
  for (const re of prefs) {
    const hit = list.find((v) => re.test(v.name));
    if (hit) return hit;
  }
  return list[0] || null;
}

function chunks(text) {
  const parts = String(text).match(/[^.!?…]+[.!?…]*\s*/g) || [text];
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > 180 && cur) {
      out.push(cur.trim());
      cur = p;
    } else {
      cur += p;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

let speakToken = 0;

function speakOne(text, lang, rate, token) {
  return new Promise((resolve) => {
    if (token !== speakToken) { resolve(); return; }
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(lang);
    if (voice) u.voice = voice;
    u.lang = voice ? voice.lang : (lang === 'pl' ? 'pl-PL' : 'en-US');
    u.rate = rate;
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve();
    };
    // Niektóre przeglądarki nie zgłaszają końca mowy. Bezpiecznik, żeby lekcja nie stanęła.
    const guard = setTimeout(end, 4000 + (text.length * 160) / rate);
    u.onend = end;
    u.onerror = end;
    window.speechSynthesis.speak(u);
  });
}

export const tts = {
  get speaking() { return hasTTS() && window.speechSynthesis.speaking; },

  // Na iPhonie mowa musi zacząć się od dotknięcia, potem już działa sama.
  unlock() {
    if (!hasTTS()) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
  },

  cancel() {
    speakToken += 1;
    if (hasTTS()) window.speechSynthesis.cancel();
  },

  hasVoice(lang) {
    return voicesFor(lang).length > 0;
  },

  voiceName(lang) {
    const v = pickVoice(lang);
    return v ? v.name : '';
  },

  async speak(segments, { enRate = 0.85, plRate = 1.02, ignoreMute = false } = {}) {
    if (!hasTTS() || (store.settings.muted && !ignoreMute)) return;
    this.cancel();
    const token = speakToken;
    await sleep(40);
    for (const seg of segments) {
      for (const piece of chunks(seg.text)) {
        if (token !== speakToken) return;
        await speakOne(piece, seg.lang, seg.lang === 'en' ? enRate : plRate, token);
      }
    }
  },
};

// ---------- Nagranie zamieniane na mały plik WAV 16 kHz ----------
export function encodeWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const text = (o, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i)); };
  text(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    o += 2;
  }
  return buffer;
}

export async function blobToWav(blob) {
  const raw = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let audio;
  try {
    audio = await ctx.decodeAudioData(raw);
  } finally {
    if (ctx.close) ctx.close();
  }
  const target = 16000;
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const off = new Off(1, Math.ceil(audio.duration * target), target);
  const src = off.createBufferSource();
  src.buffer = audio;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return encodeWav(rendered.getChannelData(0), target);
}

// ---------- Mikrofon ----------
export class Mic {
  // handlers: onState(stan), onInterim(tekst), onFinal(wynik), onLevel(0..1), onError(powód)
  constructor(handlers) {
    this.h = handlers;
    this.state = 'idle'; // idle, starting, listening, processing
    this.forced = null;
    this.rec = null;
    this.recorder = null;
    this.stream = null;
    this.timers = [];
    this.cancelled = false;
    this.raf = 0;
    this.audioCtx = null;
  }

  setState(st) {
    this.state = st;
    if (this.h.onState) this.h.onState(st);
  }

  get engine() { return micEngine(this.forced); }

  get active() { return this.state !== 'idle'; }

  start(lang) {
    if (this.active) return;
    this.cancelled = false;
    const engine = this.engine;
    if (engine === 'webspeech') this.startWeb(lang);
    else if (engine === 'gemini') this.startRec(lang);
    else if (this.h.onError) this.h.onError('unsupported');
  }

  stop() {
    if (this.rec) {
      try { this.rec.stop(); } catch { /* już zatrzymany */ }
    } else if (this.recorder && this.recorder.state === 'recording') {
      this.recorder.stop();
    }
  }

  cancel() {
    this.cancelled = true;
    this.stop();
    if (this.state === 'starting') this.setState('idle');
  }

  clearTimers() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  later(fn, ms) {
    const t = setTimeout(fn, ms);
    this.timers.push(t);
    return t;
  }

  startWeb(lang) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = new SR();
    this.rec = r;
    r.lang = lang === 'pl' ? 'pl-PL' : 'en-US';
    r.interimResults = true;
    r.continuous = !isAndroid;
    r.maxAlternatives = 1;
    let finalText = '';
    let interim = '';
    let failure = null;
    this.setState('starting');

    const armSilence = (ms) => {
      this.clearTimers();
      this.later(() => this.stop(), ms);
    };

    r.onstart = () => {
      this.setState('listening');
      armSilence(12000);
    };
    r.onresult = (e) => {
      finalText = '';
      interim = '';
      for (let i = 0; i < e.results.length; i += 1) {
        const res = e.results[i];
        if (res.isFinal) finalText += `${res[0].transcript} `;
        else interim += res[0].transcript;
      }
      if (this.h.onInterim) this.h.onInterim(`${finalText}${interim}`.trim());
      armSilence(2400);
    };
    r.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') failure = e.error;
    };
    r.onend = () => {
      this.clearTimers();
      this.rec = null;
      this.setState('idle');
      if (this.cancelled) return;
      if (failure === 'network' || failure === 'service-not-allowed' || failure === 'language-not-supported') {
        if (hasRecorder()) this.forced = 'gemini';
        if (this.h.onError) this.h.onError('switched');
        return;
      }
      if (failure === 'not-allowed') {
        if (this.h.onError) this.h.onError('denied');
        return;
      }
      const text = `${finalText}${interim}`.trim();
      if (text) this.h.onFinal({ kind: 'text', text, lang });
      else if (this.h.onError) this.h.onError('nothing');
    };
    try {
      r.start();
    } catch {
      this.rec = null;
      this.setState('idle');
      if (this.h.onError) this.h.onError('switched');
    }
  }

  async startRec(lang) {
    this.setState('starting');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      this.setState('idle');
      if (this.h.onError) this.h.onError('denied');
      return;
    }
    if (this.cancelled) {
      stream.getTracks().forEach((t) => t.stop());
      this.setState('idle');
      return;
    }
    this.stream = stream;
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => window.MediaRecorder.isTypeSupported(m));
    const recorder = new window.MediaRecorder(stream, type ? { mimeType: type } : undefined);
    this.recorder = recorder;
    const parts = [];
    const startedAt = performance.now();
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
    recorder.onstop = async () => {
      this.releaseStream();
      this.recorder = null;
      this.clearTimers();
      if (this.cancelled) {
        this.setState('idle');
        return;
      }
      if (performance.now() - startedAt < 500 || !parts.length) {
        this.setState('idle');
        if (this.h.onError) this.h.onError('nothing');
        return;
      }
      this.setState('processing');
      const blob = new Blob(parts, { type: recorder.mimeType || type || 'audio/mp4' });
      let base64;
      let mimeType;
      try {
        base64 = arrayBufferToBase64(await blobToWav(blob));
        mimeType = 'audio/wav';
      } catch {
        base64 = arrayBufferToBase64(await blob.arrayBuffer());
        mimeType = (blob.type || 'audio/mp4').split(';')[0];
      }
      this.setState('idle');
      this.h.onFinal({ kind: 'audio', base64, mimeType, lang });
    };
    recorder.start();
    this.setState('listening');
    this.later(() => this.stop(), 60000);
    this.watchLevel(stream);
  }

  // Poziom głosu do wskaźnika i samoczynne zakończenie po ciszy.
  watchLevel(stream) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      this.audioCtx = ctx;
      if (ctx.state === 'suspended') ctx.resume();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      let spoke = false;
      let lastLoud = performance.now();
      const loop = () => {
        if (!this.recorder || this.recorder.state !== 'recording') return;
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        if (this.h.onLevel) this.h.onLevel(Math.min(1, rms * 8));
        const now = performance.now();
        if (rms > 0.018) {
          spoke = true;
          lastLoud = now;
        }
        if (spoke && now - lastLoud > 2800) {
          this.stop();
          return;
        }
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    } catch { /* bez wskaźnika też da się nagrywać */ }
  }

  // Mikrofon trzeba zwolnić, inaczej iPhone ścisza głos Emmy.
  releaseStream() {
    cancelAnimationFrame(this.raf);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.audioCtx && this.audioCtx.close) this.audioCtx.close().catch(() => {});
    this.audioCtx = null;
  }
}
