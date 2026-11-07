// Darmowa synchronizacja przez ukryty plik (secret gist) na GitHubie użytkownika.
// Token i klucz Gemini nigdy nie trafiają do pliku.

import { GH_TOKEN_KEY, GIST_ID_KEY, store } from './store.js';
import { safeGet, safeRemove, safeSet } from './util.js';

const API = 'https://api.github.com';
const FILE = 'emma-postepy.json';
const DESCRIPTION = 'Emma: postępy w nauce angielskiego';
const LAST_SYNC_KEY = 'emma.lastSync';

let running = null;
let lastAttempt = 0;

export function syncConfigured() {
  return Boolean(safeGet(GH_TOKEN_KEY));
}

export function lastSyncTime() {
  return Number(safeGet(LAST_SYNC_KEY) || 0);
}

async function gh(path, token, options = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch {
    throw new Error('Brak połączenia z GitHubem. Sprawdź internet.');
  }
  if (res.status === 401) throw new Error('GitHub nie przyjął tokena. Utwórz nowy i wklej go ponownie.');
  if (res.status === 403 || res.status === 404) throw new Error('Token nie ma dostępu do gistów. Utwórz go z zaznaczonym polem gist.');
  if (!res.ok) throw new Error(`GitHub zwrócił błąd ${res.status}.`);
  return res.json();
}

async function readGistContent(gist) {
  const file = gist.files && gist.files[FILE];
  if (!file) return null;
  if (!file.truncated) return file.content;
  const res = await fetch(file.raw_url);
  return res.ok ? res.text() : null;
}

function payload() {
  return JSON.stringify(store.exportPayload());
}

// Podłączenie tokena: szuka istniejącego pliku albo zakłada nowy.
export async function connectSync(token) {
  const clean = String(token || '').trim();
  if (!clean) throw new Error('Wklej token.');
  const list = await gh('/gists?per_page=100', clean);
  const found = list.find((g) => g.files && g.files[FILE]);
  let gistId;
  if (found) {
    gistId = found.id;
  } else {
    const made = await gh('/gists', clean, {
      method: 'POST',
      body: JSON.stringify({ description: DESCRIPTION, public: false, files: { [FILE]: { content: payload() } } }),
    });
    gistId = made.id;
  }
  safeSet(GH_TOKEN_KEY, clean);
  safeSet(GIST_ID_KEY, gistId);
  await syncNow({ force: true });
  return { gistId, existed: Boolean(found) };
}

export function disconnectSync() {
  safeRemove(GH_TOKEN_KEY);
  safeRemove(GIST_ID_KEY);
  safeRemove(LAST_SYNC_KEY);
}

// Pobiera, łączy i wysyła z powrotem, tylko gdy coś się zmieniło.
export function syncNow({ force = false } = {}) {
  const token = safeGet(GH_TOKEN_KEY);
  const gistId = safeGet(GIST_ID_KEY);
  if (!token || !gistId) return Promise.resolve({ skipped: true });
  if (running) return running;
  if (!force && Date.now() - lastAttempt < 30000) return Promise.resolve({ skipped: true });
  lastAttempt = Date.now();
  running = (async () => {
    const gist = await gh(`/gists/${gistId}`, token);
    const remoteText = await readGistContent(gist);
    if (remoteText) {
      let remote = null;
      try { remote = JSON.parse(remoteText); } catch { /* uszkodzony plik zostanie nadpisany */ }
      if (remote) store.mergeIn(remote);
    }
    const merged = payload();
    if (merged !== remoteText) {
      await gh(`/gists/${gistId}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ files: { [FILE]: { content: merged } } }),
      });
    }
    safeSet(LAST_SYNC_KEY, String(Date.now()));
    return { ok: true };
  })().finally(() => { running = null; });
  return running;
}

// Plik z postępami, bez klucza i tokena.
export function exportFileName() {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `emma-postepy-${stamp}.json`;
}

export async function exportProgress() {
  const name = exportFileName();
  const blob = new Blob([JSON.stringify(store.exportPayload(), null, 1)], { type: 'application/json' });
  const file = typeof File === 'function' ? new File([blob], name, { type: 'application/json' }) : null;
  // Na iPhonie zapis idzie przez arkusz udostępniania.
  if (file && navigator.canShare && navigator.canShare({ files: [file] }) && /iP(hone|ad|od)/.test(navigator.userAgent)) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function importProgress(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('To nie jest plik z postępami Emmy.');
  }
  if (!data || typeof data !== 'object' || !data.cards || !data.progress) {
    throw new Error('To nie jest plik z postępami Emmy.');
  }
  store.mergeIn(data);
}
