// Przebieg lekcji: zegar, etapy, wymiana wiadomości z Emmą, zapis w pamięci.

import { BadReply, FINAL_SCHEMA, LESSON_SECONDS, TURN_SCHEMA, buildFinalPrompt, buildSystemPrompt, parseFinal, parseTurn, phaseAt } from './emma.js';
import { generate } from './gemini.js';
import { store } from './store.js';
import { todayStr, uid } from './util.js';

const REVIEW_LIMIT = 15;
const HISTORY_LIMIT = 40;
const NEW_PHRASE_LIMIT = 12;
const COMPLETED_FROM = 1680;

const PHASE_NOTES = {
  new: 'Zaczyna się etap nowego materiału. Przejdź do niego jednym zdaniem.',
  talk: 'Zaczyna się rozmowa po angielsku. Przejdź do niej jednym zdaniem.',
  wrap: 'Zaczyna się podsumowanie lekcji.',
};

const MIC_TAG = {
  mic: '[mikrofon]',
  keyboard: '[klawiatura]',
  choice: '[wybór z listy]',
};

export class Lesson {
  constructor(saved) {
    this.listener = () => {};
    this.paused = true;
    this.busy = false;
    this.busySince = 0;
    this.hold = false;
    this.finished = false;
    this.failed = null;
    this.wrapPending = false;
    this.pendingAudio = null;
    this.currentMe = null;
    this.ctrl = null;
    this.timer = null;
    this.lastTick = 0;
    this.lastPersist = 0;
    this.s = saved || Lesson.fresh();
  }

  static fresh() {
    return {
      id: uid(),
      date: todayStr(),
      startedAt: Date.now(),
      elapsed: 0,
      unit: store.state.progress.unit,
      phaseId: 'review',
      dueIds: store.dueCards().slice(0, REVIEW_LIMIT).map((c) => c.id),
      doneIds: [],
      newPhrases: [],
      correct: 0,
      errors: 0,
      taskLog: [],
      turns: [],
      history: [],
      task: null,
      phaseNote: '',
      started: false,
    };
  }

  // Lekcja z poprzedniego dnia nie wraca. Zapisujemy czas i zamykamy ją.
  static closeStale() {
    const saved = store.loadActiveLesson();
    if (!saved || saved.date === todayStr()) return;
    if (saved.elapsed >= 60) {
      store.addLessonRecord({
        type: 'lesson', date: saved.date, seconds: Math.round(saved.elapsed), completed: saved.elapsed >= COMPLETED_FROM,
        unit: saved.unit, newPhrases: saved.newPhrases.length, correct: saved.correct, errors: saved.errors,
        summary: '', nextFocus: '', endedAt: Date.now(),
      });
      store.save();
    }
    store.clearActiveLesson();
  }

  on(fn) { this.listener = fn; }

  emit(type, payload) { this.listener(type, payload); }

  get left() { return Math.max(0, LESSON_SECONDS - this.s.elapsed); }

  get phase() { return phaseAt(this.s.elapsed); }

  persist() { store.saveActiveLesson(this.s); }

  // ---------- Zegar ----------
  run() {
    if (this.finished) return;
    this.paused = false;
    this.lastTick = performance.now();
    if (!this.timer) this.timer = setInterval(() => this.tick(), 250);
    this.emit('paused', false);
    if (!this.s.started) {
      this.s.started = true;
      this.ask('[aplikacja] Lekcja się zaczyna. Przywitaj ucznia i daj pierwsze zadanie.');
    } else if (!this.busy) {
      this.recoverPending();
    }
  }

  // Aplikacja zamknęła się albo zapytanie padło, zanim Emma odpowiedziała: ponawiamy je.
  recoverPending() {
    const s = this.s;
    const last = s.history[s.history.length - 1];
    if (!last || last.role !== 'user') return;
    const lastMe = [...s.turns].reverse().find((t) => t.k === 'me');
    if (lastMe && lastMe.verdict === null) {
      if (lastMe.source === 'audio' && !this.pendingAudio) {
        // Nagranie nie przetrwało zamknięcia aplikacji, więc uczeń mówi jeszcze raz.
        s.turns.splice(s.turns.lastIndexOf(lastMe), 1);
        s.history.pop();
        this.persist();
        return;
      }
      this.currentMe = lastMe;
    }
    this.hold = false;
    this.request();
  }

  pause() {
    if (this.finished || this.paused) return;
    this.paused = true;
    this.persist();
    this.emit('paused', true);
  }

  tick() {
    const now = performance.now();
    const dt = Math.min((now - this.lastTick) / 1000, 2);
    this.lastTick = now;
    if (this.paused || this.hold || this.finished) return;
    // Dłuższe czekanie na odpowiedź Google nie zabiera czasu lekcji.
    if (this.busy && now - this.busySince > 3000) return;
    this.s.elapsed += dt;
    const phase = phaseAt(this.s.elapsed);
    if (phase.id !== this.s.phaseId) this.enterPhase(phase);
    if (this.s.elapsed >= LESSON_SECONDS) {
      this.s.elapsed = LESSON_SECONDS;
      this.finish();
      return;
    }
    if (now - this.lastPersist > 5000) {
      this.lastPersist = now;
      this.persist();
    }
    this.emit('tick');
  }

  enterPhase(phase) {
    this.s.phaseId = phase.id;
    this.s.turns.push({ k: 'phase', name: phase.name });
    this.s.phaseNote = PHASE_NOTES[phase.id] || '';
    this.emit('phase', phase);
    if (phase.id === 'wrap') {
      if (this.busy) this.wrapPending = true;
      else this.ask('[aplikacja] Czas na podsumowanie lekcji.');
    }
  }

  // Do testów i ręcznego przeskoku w czasie.
  jumpTo(seconds) {
    this.s.elapsed = seconds;
    this.lastTick = performance.now();
    this.tick();
  }

  // ---------- Wiadomości ----------
  sendText(text, source) {
    const clean = String(text || '').trim();
    if (!clean || this.busy || this.finished) return;
    const me = { k: 'me', text: clean, source, verdict: null, correction: null };
    this.s.turns.push(me);
    this.currentMe = me;
    this.ask(`${MIC_TAG[source] || ''} ${clean}`.trim());
  }

  sendAudio({ base64, mimeType, lang }) {
    if (this.busy || this.finished) return;
    const me = { k: 'me', text: '', source: 'audio', verdict: null, correction: null };
    this.s.turns.push(me);
    this.currentMe = me;
    this.pendingAudio = { base64, mimeType };
    const langName = lang === 'pl' ? 'polski' : 'angielski';
    this.ask(`[nagranie głosu, oczekiwany język: ${langName}] Odpowiedź ucznia jest w załączonym nagraniu. Przepisz ją w polu heard.`);
  }

  ask(text) {
    let full = text;
    if (this.s.phaseNote) {
      full = `[aplikacja: ${this.s.phaseNote}]\n${text}`;
      this.s.phaseNote = '';
    }
    this.s.history.push({ role: 'user', text: full });
    this.persist();
    this.emit('sent');
    return this.request();
  }

  contents() {
    let list = this.s.history.slice(-HISTORY_LIMIT);
    while (list.length && list[0].role !== 'user') list = list.slice(1);
    return list.map((m, i) => {
      const parts = [{ text: m.text }];
      if (i === list.length - 1 && this.pendingAudio) {
        parts.push({ inlineData: { mimeType: this.pendingAudio.mimeType, data: this.pendingAudio.base64 } });
      }
      return { role: m.role, parts };
    });
  }

  async request() {
    this.busy = true;
    this.busySince = performance.now();
    this.failed = null;
    this.emit('busy', true);
    this.ctrl = new AbortController();
    const signal = this.ctrl.signal;
    try {
      let reply = null;
      let raw = '';
      for (let attempt = 0; attempt < 2 && !reply; attempt += 1) {
        const out = await generate({
          system: buildSystemPrompt(store, this.s),
          contents: this.contents(),
          schema: TURN_SCHEMA,
          signal,
          timeoutMs: this.pendingAudio ? 25000 : 10000,
          onWait: (sec) => {
            this.hold = true;
            this.emit('wait', sec);
          },
        });
        raw = out.text;
        this.s.model = out.model;
        try {
          reply = parseTurn(raw);
        } catch (err) {
          if (!(err instanceof BadReply) || attempt === 1) throw err;
        }
      }
      if (this.finished) return;
      this.applyReply(reply, raw);
      this.hold = false;
      this.busy = false;
      this.pendingAudio = null;
      this.persist();
      this.emit('busy', false);
      this.emit('reply', reply);
      if (this.wrapPending) {
        this.wrapPending = false;
        this.ask('[aplikacja] Czas na podsumowanie lekcji.');
      }
    } catch (err) {
      if (signal.aborted && this.finished) return;
      this.hold = true;
      this.busy = false;
      this.failed = err;
      this.emit('busy', false);
      this.emit('failed', err);
    }
  }

  retry() {
    if (this.busy || this.finished) return;
    this.hold = false;
    this.request();
  }

  applyReply(reply, raw) {
    const s = this.s;
    if (reply.verdict === 'ok') s.correct += 1;
    if (reply.verdict === 'error') s.errors += 1;

    const me = this.currentMe;
    if (me) {
      me.verdict = reply.verdict;
      me.correction = reply.correction;
      if (me.source === 'audio') {
        me.text = reply.heard || '(nagranie)';
        const lastUser = s.history[s.history.length - 1];
        if (lastUser && lastUser.role === 'user') lastUser.text = `[nagranie głosu] ${me.text}`;
      }
      this.currentMe = null;
    }

    if (reply.correction) {
      store.recordMistake(reply.correction);
      if (reply.correction.pl) store.addCard(reply.correction.right, reply.correction.pl, { unit: s.unit, source: 'correction', silent: true });
    }

    for (const r of reply.card_results) {
      if (s.dueIds.includes(r.id) && !s.doneIds.includes(r.id)) {
        store.gradeCard(r.id, Boolean(r.correct));
        s.doneIds.push(r.id);
      }
    }

    const added = [];
    for (const p of reply.new_phrases) {
      if (s.newPhrases.length >= NEW_PHRASE_LIMIT) break;
      const card = store.addCard(p.en, p.pl, { unit: s.unit, source: 'lesson', silent: true });
      if (card) {
        s.newPhrases.push(card.id);
        added.push(card.en);
      }
    }
    for (const n of reply.notes) store.addNote(n);
    store.save();

    // Zdanie ze słuchu odsłaniamy dopiero po odpowiedzi ucznia.
    for (let i = s.turns.length - 1; i >= 0; i -= 1) {
      if (s.turns[i].k === 'emma') {
        s.turns[i].say.forEach((seg) => { seg.hidden = false; });
        break;
      }
    }

    s.turns.push({ k: 'emma', say: reply.say, marks: reply.new_phrases.map((p) => p.en), added });
    s.history.push({ role: 'model', text: raw });
    s.task = reply.task;
    if (reply.task.type !== 'none') s.taskLog.push(reply.task.type);
  }

  // ---------- Koniec ----------
  async finish({ early = false } = {}) {
    if (this.finished) return;
    this.finished = true;
    this.paused = true;
    clearInterval(this.timer);
    this.timer = null;
    if (this.ctrl) this.ctrl.abort();
    this.emit('ending');

    const s = this.s;
    const seconds = Math.round(s.elapsed);
    const completed = s.elapsed >= COMPLETED_FROM;
    let final = null;
    let finalError = null;
    const spoke = s.turns.some((t) => t.k === 'me');
    if (s.elapsed >= 180 && spoke && store.apiKey) {
      try {
        let list = s.history.slice(-HISTORY_LIMIT);
        while (list.length && list[0].role !== 'user') list = list.slice(1);
        const contents = list.map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
        contents.push({ role: 'user', parts: [{ text: '[aplikacja] Lekcja zakończona. Zwróć raport.' }] });
        const out = await generate({
          system: buildFinalPrompt(store, s), contents, schema: FINAL_SCHEMA, temperature: 0.4, maxTokens: 1500, timeoutMs: 20000,
        });
        final = parseFinal(out.text);
      } catch (err) {
        finalError = err;
      }
    }

    const unitBefore = store.state.progress.unit;
    let advanced = false;
    if (final) {
      advanced = store.applyLessonDecision({ mastery: final.mastery, advance: final.advance && s.unit === unitBefore, reason: final.reason });
      store.setTeacherNote(final.noteForNext);
      for (const n of final.notes) store.addNote(n);
    }
    store.addLessonRecord({
      type: 'lesson', date: s.date, seconds, completed, unit: s.unit,
      newPhrases: s.newPhrases.length, correct: s.correct, errors: s.errors,
      summary: final ? final.summary : '', nextFocus: final ? final.nextFocus : '', endedAt: Date.now(),
    });
    store.save();
    store.clearActiveLesson();

    this.emit('ended', {
      seconds, completed, early, advanced, final, finalError,
      unitBefore, unitAfter: store.state.progress.unit,
      newPhrases: s.newPhrases.length, correct: s.correct, errors: s.errors, reviewed: s.doneIds.length,
    });
  }
}
