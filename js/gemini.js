// Połączenie z darmowym Gemini. Klucz idzie w nagłówku i tylko do Google.

import { store } from './store.js';
import { safeGet, safeSet, sleep } from './util.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Lista zapasowa, gdy nie uda się pobrać listy modeli. Stan z listopada 2026.
const FALLBACK_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-3.6-flash'];
// Większy model, który nie odpowiedział na czas, odpoczywa, bo potrafi wisieć minutami.
// Flash-Lite nie odpoczywa: jego milczenie to zwykle chwilowa przerwa w sieci.
const SLOW_REST_BIG = 10 * 60 * 1000;
const COOLDOWN_KEY = 'emma.modelRest';
const NO_THINKING_KEY = 'emma.modelNoThinking';

export class GeminiError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind; // auth, quota, network, blocked, bad
    Object.assign(this, extra);
  }
}

function readJsonMap(key) {
  try { return JSON.parse(safeGet(key) || '{}'); } catch { return {}; }
}

// why: slow (nie odpowiedział), error (chwilowy błąd), minute (limit na minutę),
// day (limit na dziś), gone (model niedostępny na tym kluczu).
function setCooldown(model, ms, why) {
  const map = readJsonMap(COOLDOWN_KEY);
  map[model] = { until: Date.now() + ms, why };
  safeSet(COOLDOWN_KEY, JSON.stringify(map));
}

function restOf(model) {
  const rest = readJsonMap(COOLDOWN_KEY)[model];
  if (!rest || rest.until <= Date.now()) return null;
  return { left: rest.until - Date.now(), why: rest.why };
}

export function clearCooldowns() {
  safeSet(COOLDOWN_KEY, '{}');
}

// Wszystkie modele odpoczywają po chwilowych kłopotach, a uczeń czeka: próbujemy od nowa.
function forgiveTemporaryRests(chain) {
  if (chain.some((model) => !restOf(model))) return;
  const map = readJsonMap(COOLDOWN_KEY);
  for (const model of chain) {
    const rest = map[model];
    if (rest && (rest.why === 'slow' || rest.why === 'error')) delete map[model];
  }
  safeSet(COOLDOWN_KEY, JSON.stringify(map));
}

// W rozmowie liczy się szybkość. Najpierw Flash-Lite, który odpowiada w około sekundę,
// a większe modele Flash są zapasem, bo w godzinach szczytu potrafią wisieć minutami.
export function rankModels(names) {
  const parsed = [];
  for (const raw of names) {
    const name = raw.replace(/^models\//, '');
    const m = name.match(/^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/);
    if (m) parsed.push({ name, version: parseFloat(m[1]), lite: Boolean(m[2]) });
  }
  parsed.sort((a, b) => (Number(a.lite) - Number(b.lite)) || (b.version - a.version));
  const flash = parsed.filter((p) => !p.lite).slice(0, 2);
  const lite = parsed.filter((p) => p.lite).slice(0, 2);
  return [...lite, ...flash].map((p) => p.name);
}

function describeNetworkError() {
  return new GeminiError('network', 'Brak połączenia z Google. Sprawdź internet i spróbuj ponownie.');
}

// Sprawdza klucz i zapamiętuje najlepsze dostępne modele.
export async function checkKey(key) {
  let res;
  try {
    res = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  } catch {
    throw describeNetworkError();
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new GeminiError('auth', 'Google nie przyjął tego klucza. Skopiuj go jeszcze raz w całości.');
  }
  if (!res.ok) throw new GeminiError('bad', `Google zwrócił błąd ${res.status}. Spróbuj ponownie za chwilę.`);
  const data = await res.json();
  const usable = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name);
  const ranked = rankModels(usable);
  store.settings.models = ranked.length ? ranked : FALLBACK_MODELS;
  store.saveSettings();
  clearCooldowns();
  return store.settings.models;
}

function modelChain() {
  const saved = store.settings.models && store.settings.models.length ? rankModels(store.settings.models) : [];
  return saved.length ? saved : FALLBACK_MODELS;
}

function parseQuota(body) {
  const details = (body.error && body.error.details) || [];
  let retryMs = 30000;
  let perDay = false;
  let noFreeTier = false;
  for (const d of details) {
    if (d.retryDelay) retryMs = (parseFloat(d.retryDelay) || 30) * 1000;
    for (const v of d.violations || []) {
      if (/perday/i.test(v.quotaId || '')) perDay = true;
      if (String(v.quotaValue) === '0') noFreeTier = true;
    }
  }
  const text = (body.error && body.error.message) || '';
  if (/limit:\s*0\b/.test(text)) noFreeTier = true;
  return { retryMs, perDay, noFreeTier };
}

function extractText(data) {
  const cand = data.candidates && data.candidates[0];
  if (!cand) {
    if (data.promptFeedback && data.promptFeedback.blockReason) {
      throw new GeminiError('blocked', 'Google zablokował tę wiadomość. Powiedz to inaczej.');
    }
    throw new GeminiError('bad', 'Pusta odpowiedź modelu.');
  }
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  if (!text) {
    if (cand.finishReason === 'SAFETY') throw new GeminiError('blocked', 'Google zablokował tę wiadomość. Powiedz to inaczej.');
    throw new GeminiError('bad', 'Pusta odpowiedź modelu.');
  }
  return { text, finishReason: cand.finishReason };
}

function buildBody({ system, contents, schema, temperature, maxTokens, model }) {
  const generationConfig = { temperature, maxOutputTokens: maxTokens };
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = schema;
  }
  const noThinking = readJsonMap(NO_THINKING_KEY);
  const version = parseFloat((model.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
  if (version >= 3 && !noThinking[model]) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  const body = { contents, generationConfig };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  return body;
}

async function callModel(model, key, params, timeoutMs, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const relay = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', relay);
  try {
    const res = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(buildBody({ ...params, model })),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relay);
  }
}

// Wysyła zapytanie, a gdy model ma limit, przechodzi na kolejny.
export async function generate({
  system, contents, schema, temperature = 0.7, maxTokens = 2048, timeoutMs = 10000, signal, onWait,
}) {
  const key = store.apiKey;
  if (!key) throw new GeminiError('auth', 'Brak klucza Gemini. Wklej go w ustawieniach.');
  const params = { system, contents, schema, temperature, maxTokens };
  const chain = modelChain();
  let lastError = null;
  forgiveTemporaryRests(chain);

  for (let round = 0; round < 2; round += 1) {
    let minuteWait = Infinity;
    let timeouts = 0;
    for (const model of chain) {
      const rest = restOf(model);
      if (rest) {
        if (rest.why === 'minute') minuteWait = Math.min(minuteWait, rest.left);
        continue;
      }
      let result;
      try {
        result = await callModel(model, key, params, timeoutMs, signal);
      } catch (err) {
        if (signal && signal.aborted) throw err;
        if (err && err.name === 'AbortError') {
          if (!/-lite$/.test(model)) setCooldown(model, SLOW_REST_BIG, 'slow');
          lastError = new GeminiError('bad', 'Google nie odpowiedział na czas. Spróbuj ponownie.');
          // Dwa modele z rzędu milczą: to raczej sieć, więc nie każemy czekać na kolejne.
          timeouts += 1;
          if (timeouts >= 2) break;
          continue;
        }
        // Brak internetu nie zależy od modelu, więc nie ma na co czekać.
        throw describeNetworkError();
      }
      const { status, body } = result;
      const message = (body.error && body.error.message) || '';

      if (status === 200) {
        const out = extractText(body);
        return { ...out, model };
      }
      if (status === 400 && /thinking/i.test(message)) {
        const map = readJsonMap(NO_THINKING_KEY);
        map[model] = true;
        safeSet(NO_THINKING_KEY, JSON.stringify(map));
        const retry = await callModel(model, key, params, timeoutMs, signal);
        if (retry.status === 200) return { ...extractText(retry.body), model };
        lastError = new GeminiError('bad', `Model ${model} odrzucił zapytanie.`);
        continue;
      }
      if (status === 400 && /api key|api_key/i.test(message)) {
        throw new GeminiError('auth', 'Google nie przyjął klucza. Wklej go ponownie w ustawieniach.');
      }
      if (status === 400 && /location|region/i.test(message)) {
        throw new GeminiError('auth', 'Google nie obsługuje darmowego dostępu z tej lokalizacji.');
      }
      if (status === 401 || status === 403) {
        throw new GeminiError('auth', 'Google odmówił dostępu dla tego klucza. Sprawdź go w ustawieniach.');
      }
      if (status === 429) {
        const q = parseQuota(body);
        if (q.noFreeTier) setCooldown(model, 7 * 86400000, 'gone');
        else if (q.perDay) setCooldown(model, 6 * 3600000, 'day');
        else {
          setCooldown(model, q.retryMs, 'minute');
          minuteWait = Math.min(minuteWait, q.retryMs);
        }
        lastError = new GeminiError('quota', 'Limit darmowych zapytań.');
        continue;
      }
      if (status === 404) {
        setCooldown(model, 7 * 86400000, 'gone');
        lastError = new GeminiError('bad', `Model ${model} nie jest dostępny.`);
        continue;
      }
      // Przeciążenie albo inny błąd modelu: próbujemy następnego.
      setCooldown(model, status === 400 ? 3600000 : 20000, 'error');
      lastError = new GeminiError('bad', `Google zwrócił błąd ${status}. ${message}`.trim());
    }

    // Żaden model nie odpowiedział. Jeśli limit na minutę zaraz minie, czekamy.
    if (round === 0 && minuteWait <= 70000) {
      if (onWait) onWait(Math.ceil(minuteWait / 1000));
      await sleep(minuteWait + 300);
      if (signal && signal.aborted) throw new GeminiError('network', 'Przerwano.');
      continue;
    }
    if (minuteWait !== Infinity) {
      throw new GeminiError('quota', 'Limit zapytań na minutę jeszcze trwa. Spróbuj ponownie za chwilę.', { daily: false });
    }
    // O końcu dziennego limitu mówimy tylko wtedy, gdy naprawdę nie ma już żadnego modelu.
    const exhausted = chain.every((model) => {
      const rest = restOf(model);
      return rest && (rest.why === 'day' || rest.why === 'gone');
    });
    if (exhausted) {
      throw new GeminiError('quota', 'Darmowy limit Gemini na dziś się skończył. Odnawia się około 9:00 rano polskiego czasu. Powtórki bez Emmy działają nadal.', { daily: true });
    }
    break;
  }
  throw lastError || new GeminiError('bad', 'Nie udało się połączyć z modelem.');
}

// Samo przepisanie nagrania na tekst, używane przy powtórkach bez Emmy.
export async function transcribe({ base64, mimeType, lang }) {
  const language = lang === 'pl' ? 'polskim' : 'angielskim';
  const out = await generate({
    contents: [{
      role: 'user',
      parts: [
        { text: `Przepisz dokładnie to nagranie w języku ${language}, razem z błędami mówiącego. Zwróć tylko przepisany tekst, bez komentarzy. Jeśli nic nie słychać, zwróć pusty tekst.` },
        { inlineData: { mimeType, data: base64 } },
      ],
    }],
    temperature: 0,
    maxTokens: 400,
    timeoutMs: 25000,
  });
  return out.text.trim();
}
