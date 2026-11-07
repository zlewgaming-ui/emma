// Pamięć aplikacji: postępy, fiszki, błędy, notatki. Klucz i token są osobno
// i nigdy nie trafiają do eksportu ani do synchronizacji.

import { STARTER, unitById, programShare } from './curriculum.js';
import { addDays, daysBetween, normalizeSentence, safeGet, safeRemove, safeSet, todayStr, uid } from './util.js';

const STATE_KEY = 'emma.state.v1';
const SETTINGS_KEY = 'emma.settings.v1';
const LESSON_KEY = 'emma.activeLesson.v1';
export const API_KEY_KEY = 'emma.geminiKey';
export const GH_TOKEN_KEY = 'emma.ghToken';
export const GIST_ID_KEY = 'emma.gistId';

// Odstępy powtórek w dniach, rosną z każdą poprawną odpowiedzią.
export const INTERVALS = [1, 2, 4, 7, 14, 30, 60, 120, 240];

// Dzień liczy się do serii od tylu minut nauki.
export const STREAK_MINUTES = 15;

const NOTE_LIMIT = 60;

function freshState() {
  return {
    v: 1,
    profile: { name: '', updatedAt: 0 },
    cards: {},
    lessons: [],
    mistakes: {},
    notes: [],
    progress: { unit: 1, mastery: 0, lessonsInUnit: 0, updatedAt: 0, reason: '' },
    teacherNote: { text: '', updatedAt: 0 },
  };
}

function freshSettings() {
  return {
    micMode: 'auto', // auto, webspeech, gemini
    autoListen: null, // null oznacza domyślne dla urządzenia
    enVoice: '',
    plVoice: '',
    enRate: null, // null oznacza tempo dobrane do działu
    muted: false,
    models: [],
  };
}

function cardId(en) {
  return `c_${normalizeSentence(en).replace(/\s+/g, '_').slice(0, 60)}`;
}

function mistakeKey(category, wrong) {
  return `${String(category || 'inne').toLowerCase()}|${normalizeSentence(wrong).slice(0, 60)}`;
}

class Store {
  constructor() {
    this.state = this.loadState();
    this.settings = this.loadSettings();
    this.listeners = new Set();
  }

  loadState() {
    const raw = safeGet(STATE_KEY);
    if (raw) {
      try {
        return { ...freshState(), ...JSON.parse(raw) };
      } catch { /* uszkodzony zapis, startujemy od nowa */ }
    }
    return freshState();
  }

  loadSettings() {
    const raw = safeGet(SETTINGS_KEY);
    if (raw) {
      try { return { ...freshSettings(), ...JSON.parse(raw) }; } catch { /* domyślne */ }
    }
    return freshSettings();
  }

  save() {
    safeSet(STATE_KEY, JSON.stringify(this.state));
    this.listeners.forEach((fn) => fn());
  }

  saveSettings() {
    safeSet(SETTINGS_KEY, JSON.stringify(this.settings));
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------- Klucz i token: tylko w tej przeglądarce ----------
  get apiKey() { return safeGet(API_KEY_KEY) || ''; }

  set apiKey(v) {
    if (v) safeSet(API_KEY_KEY, v);
    else safeRemove(API_KEY_KEY);
  }

  // ---------- Profil ----------
  get name() { return this.state.profile.name; }

  setName(name) {
    this.state.profile = { name: String(name || '').trim().slice(0, 40), updatedAt: Date.now() };
    this.save();
  }

  // ---------- Fiszki ----------
  ensureStarterCards() {
    if (Object.keys(this.state.cards).length) return;
    const today = todayStr();
    for (const [en, pl] of STARTER) this.addCard(en, pl, { unit: 0, source: 'start', due: today, silent: true });
    this.save();
  }

  addCard(en, pl, { unit = this.state.progress.unit, source = 'lesson', due, silent = false } = {}) {
    const cleanEn = String(en || '').trim();
    const cleanPl = String(pl || '').trim();
    if (!cleanEn || !cleanPl) return null;
    const id = cardId(cleanEn);
    const existing = this.state.cards[id];
    if (existing && !existing.deleted) return null;
    const now = Date.now();
    const today = todayStr();
    const card = {
      id, en: cleanEn, pl: cleanPl, unit, source, box: 0, due: due || addDays(today, 1), reps: 0, lapses: 0,
      addedAt: now, updatedAt: now, lastReviewed: '',
    };
    this.state.cards[id] = card;
    if (!silent) this.save();
    return card;
  }

  allCards() {
    return Object.values(this.state.cards).filter((c) => !c.deleted);
  }

  dueCards(today = todayStr()) {
    return this.allCards()
      .filter((c) => c.due <= today)
      .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.box - b.box));
  }

  // Poprawnie: następny, dłuższy odstęp. Błędnie: wraca na początek, czyli na jutro.
  gradeCard(id, correct, today = todayStr()) {
    const card = this.state.cards[id];
    if (!card || card.deleted) return null;
    if (card.lastReviewed === today && correct) return card;
    if (correct) {
      const step = Math.min(card.box, INTERVALS.length - 1);
      card.due = addDays(today, INTERVALS[step]);
      card.box = Math.min(card.box + 1, INTERVALS.length - 1);
    } else {
      card.box = 0;
      card.lapses += 1;
      card.due = addDays(today, 1);
    }
    card.reps += 1;
    card.lastReviewed = today;
    card.updatedAt = Date.now();
    return card;
  }

  // ---------- Błędy ----------
  recordMistake({ wrong, right, why, category }) {
    if (!wrong || !right) return;
    const key = mistakeKey(category, wrong);
    const prev = this.state.mistakes[key];
    this.state.mistakes[key] = {
      key,
      category: category || 'inne',
      wrong,
      right,
      why: why || '',
      count: (prev ? prev.count : 0) + 1,
      lastSeen: todayStr(),
      updatedAt: Date.now(),
    };
  }

  topMistakes(limit = 8) {
    const today = todayStr();
    return Object.values(this.state.mistakes)
      .filter((m) => !m.deleted)
      .sort((a, b) => {
        const score = (m) => m.count * 2 - Math.min(daysBetween(m.lastSeen, today), 30) / 5;
        return score(b) - score(a);
      })
      .slice(0, limit);
  }

  deleteMistake(key) {
    const m = this.state.mistakes[key];
    if (m) {
      m.deleted = true;
      m.updatedAt = Date.now();
      this.save();
    }
  }

  // ---------- Notatki o uczniu ----------
  addNote(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    const key = normalizeSentence(clean);
    if (this.state.notes.some((n) => !n.deleted && normalizeSentence(n.text) === key)) return;
    this.state.notes.push({ id: uid(), text: clean.slice(0, 200), createdAt: Date.now() });
    const live = this.state.notes.filter((n) => !n.deleted);
    if (live.length > NOTE_LIMIT) live[0].deleted = true;
  }

  liveNotes() {
    return this.state.notes.filter((n) => !n.deleted);
  }

  deleteNote(id) {
    const n = this.state.notes.find((x) => x.id === id);
    if (n) {
      n.deleted = true;
      this.save();
    }
  }

  // ---------- Postęp w programie ----------
  get unit() { return unitById(this.state.progress.unit); }

  applyLessonDecision({ mastery, advance, reason }) {
    const p = this.state.progress;
    p.lessonsInUnit += 1;
    if (typeof mastery === 'number') p.mastery = Math.max(0, Math.min(100, Math.round(mastery)));
    p.reason = reason || '';
    let advanced = false;
    if (advance && p.unit < 40) {
      p.unit += 1;
      p.mastery = 0;
      p.lessonsInUnit = 0;
      advanced = true;
    }
    p.updatedAt = Date.now();
    return advanced;
  }

  setTeacherNote(text) {
    if (!text) return;
    this.state.teacherNote = { text: String(text).trim().slice(0, 240), updatedAt: Date.now() };
  }

  addLessonRecord(rec) {
    this.state.lessons.push({ id: uid(), date: todayStr(), type: 'lesson', seconds: 0, completed: false, ...rec });
  }

  lastLesson() {
    const list = this.state.lessons.filter((l) => l.type === 'lesson');
    return list[list.length - 1] || null;
  }

  // ---------- Liczby na ekran główny ----------
  stats(today = todayStr()) {
    const lessons = this.state.lessons;
    const perDay = new Map();
    let seconds = 0;
    for (const l of lessons) {
      seconds += l.seconds || 0;
      perDay.set(l.date, (perDay.get(l.date) || 0) + (l.seconds || 0));
    }
    const counted = (d) => (perDay.get(d) || 0) >= STREAK_MINUTES * 60;
    let streak = 0;
    let cursor = counted(today) ? today : addDays(today, -1);
    while (counted(cursor)) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }
    return {
      streak,
      lessons: lessons.filter((l) => l.type === 'lesson' && l.completed).length,
      minutes: Math.floor(seconds / 60),
      cards: this.allCards().length,
      due: this.dueCards(today).length,
      todayMinutes: Math.floor((perDay.get(today) || 0) / 60),
      share: programShare(this.state.progress.unit, this.state.progress.mastery),
    };
  }

  // ---------- Trwająca lekcja, żeby przetrwała zamknięcie aplikacji ----------
  saveActiveLesson(data) { safeSet(LESSON_KEY, JSON.stringify(data)); }

  loadActiveLesson() {
    const raw = safeGet(LESSON_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  clearActiveLesson() { safeRemove(LESSON_KEY); }

  // ---------- Eksport, import, synchronizacja ----------
  exportPayload() {
    return JSON.parse(JSON.stringify(this.state));
  }

  mergeIn(remote) {
    this.state = mergeStates(this.state, remote);
    this.save();
  }

  resetEverything() {
    safeRemove(STATE_KEY);
    safeRemove(LESSON_KEY);
    this.state = freshState();
    this.save();
  }
}

function pickNewer(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a;
}

// Łączenie dwóch stanów: z każdego urządzenia zostaje to, co nowsze, nic nie ginie.
export function mergeStates(local, remote) {
  if (!remote || typeof remote !== 'object' || !remote.cards) return local;
  const out = { ...freshState(), ...local };

  out.profile = pickNewer(local.profile, remote.profile) || out.profile;
  out.teacherNote = pickNewer(local.teacherNote, remote.teacherNote) || out.teacherNote;

  out.cards = { ...local.cards };
  for (const [id, card] of Object.entries(remote.cards || {})) out.cards[id] = pickNewer(out.cards[id], card);

  const lessons = new Map();
  for (const l of [...(local.lessons || []), ...(remote.lessons || [])]) lessons.set(l.id, l);
  out.lessons = [...lessons.values()].sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));

  out.mistakes = { ...local.mistakes };
  for (const [k, m] of Object.entries(remote.mistakes || {})) out.mistakes[k] = pickNewer(out.mistakes[k], m);

  const notes = new Map();
  for (const n of [...(local.notes || []), ...(remote.notes || [])]) {
    const prev = notes.get(n.id);
    notes.set(n.id, prev ? { ...prev, ...n, deleted: prev.deleted || n.deleted } : n);
  }
  out.notes = [...notes.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  const a = local.progress || out.progress;
  const b = remote.progress || out.progress;
  if (b.unit > a.unit) out.progress = b;
  else if (a.unit > b.unit) out.progress = a;
  else out.progress = pickNewer(a, b);

  return out;
}

export const store = new Store();
