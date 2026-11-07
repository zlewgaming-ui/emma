// Ekran lekcji: zegar, zeszyt z rozmową, zadanie i mikrofon.

import { defaultEnglishRate, unitById } from './curriculum.js';
import { LESSON_SECONDS, PHASES } from './emma.js';
import { cross, icon, tick } from './icons.js';
import { Lesson } from './lesson.js';
import { Mic, autoListenEnabled, isIOS, tts } from './speech.js';
import { store } from './store.js';
import { clear, fmtClock, h, wordDiff } from './util.js';

const HINTS = {
  speak: (lang) => (lang === 'pl' ? 'Powiedz to po polsku' : 'Powiedz to po angielsku'),
  translate: () => 'Przetłumacz i powiedz na głos',
  write: () => 'Napisz to na klawiaturze',
  choice: () => 'Wybierz odpowiedź',
  repeat: () => 'Powtórz całe zdanie',
  listen: () => 'Posłuchaj i powtórz, co usłyszałeś',
  free: () => 'Odpowiedz własnymi słowami',
  none: () => '',
};

const MIC_ERRORS = {
  denied: isIOS
    ? 'Mikrofon jest zablokowany. Włącz go w Ustawieniach iPhone\'a albo napisz odpowiedź.'
    : 'Mikrofon jest zablokowany. Zezwól na niego przy pasku adresu albo napisz odpowiedź.',
  nothing: 'Nic nie słychać. Naciśnij mikrofon i powiedz jeszcze raz albo napisz.',
  switched: 'Rozpoznawanie mowy nie działa, przełączam na nagrywanie. Naciśnij mikrofon jeszcze raz.',
  unsupported: 'Ta przeglądarka nie obsługuje mikrofonu. Napisz odpowiedź.',
};

const LISTENING = 'Słucham. Naciśnij czerwony przycisk, gdy skończysz.';

function enRate(unit) {
  return store.settings.enRate || defaultEnglishRate(unit);
}

export function renderLesson(root, nav, params = {}) {
  const saved = params.resume ? store.loadActiveLesson() : null;
  const lesson = new Lesson(saved);
  const s = lesson.s;
  const unit = unitById(s.unit);
  let answerLang = (s.task && s.task.answer_lang) || 'en';
  let waitNote = '';
  let slowTimer = null;
  let confirmingEnd = false;
  let ended = false;

  // ---------- Elementy ----------
  const clock = h('div', { class: 'clock', role: 'timer', 'aria-live': 'off' }, fmtClock(lesson.left));
  const phaseName = h('b');
  const unitName = h('span');
  const phaseBox = h('div', { class: 'phase-name' }, phaseName, unitName);
  const muteBtn = h('button', { class: 'icon-btn', type: 'button', onClick: toggleMute });
  const pauseBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Pauza', onClick: () => lesson.pause() }, icon('pause'));
  const rulerNow = h('div', { class: 'ruler-now' });
  const rulerParts = PHASES.map((p) => {
    const part = h('div', { class: 'ruler-part' });
    const minutes = (p.end - p.start) / 60;
    part.style.flex = `${minutes} 1 0`;
    part.style.setProperty('--tick', `${100 / minutes}%`);
    return part;
  });
  const ruler = h('div', { class: 'ruler', 'aria-hidden': 'true' }, rulerParts, rulerNow);

  const pageInner = h('div', { class: 'page-inner' });
  const page = h('div', { class: 'page' }, pageInner);

  const hint = h('div', { class: 'hint' });
  const interim = h('div', { class: 'interim', 'aria-live': 'polite' });
  const errorBox = h('div', { class: 'dock-error', role: 'alert' });
  const options = h('div', { class: 'options' });
  const enBtn = h('button', { type: 'button', onClick: () => setLang('en'), 'aria-label': 'Mówię po angielsku' }, 'EN');
  const plBtn = h('button', { type: 'button', onClick: () => setLang('pl'), 'aria-label': 'Mówię po polsku' }, 'PL');
  const input = h('input', {
    type: 'text', placeholder: 'Albo napisz tutaj', autocomplete: 'off', autocapitalize: 'sentences', spellcheck: 'false',
    'aria-label': 'Twoja odpowiedź',
    onInput: updateMainButton,
    onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); sendTyped(); } },
  });
  const mainBtn = h('button', { class: 'mic', type: 'button', onClick: onMainButton });
  const composer = h('div', { class: 'composer' }, h('div', { class: 'lang-switch' }, enBtn, plBtn), input, mainBtn);
  const dock = h('div', { class: 'dock' }, errorBox, hint, options, interim, composer);

  const overlay = h('div', { class: 'overlay' });
  overlay.hidden = true;
  overlay.style.display = 'none';

  const head = h('div', { class: 'lesson-head' },
    h('div', { class: 'head-row' }, clock, phaseBox, muteBtn, pauseBtn),
    ruler);
  const wrap = h('div', { class: 'lesson' }, head, page, dock, overlay);
  clear(root).append(wrap);

  // ---------- Mikrofon ----------
  const mic = new Mic({
    onState: () => updateMainButton(),
    onInterim: (text) => { interim.textContent = text; },
    onLevel: (v) => { mainBtn.style.setProperty('--level', String(v)); },
    onFinal: (res) => {
      interim.textContent = '';
      if (res.kind === 'text') lesson.sendText(res.text, 'mic');
      else lesson.sendAudio(res);
    },
    onError: (why) => {
      interim.textContent = '';
      setError(MIC_ERRORS[why] || '');
    },
  });

  function setLang(lang) {
    answerLang = lang;
    enBtn.setAttribute('aria-pressed', String(lang === 'en'));
    plBtn.setAttribute('aria-pressed', String(lang === 'pl'));
  }

  function setError(text, actions = []) {
    clear(errorBox);
    if (text) {
      errorBox.append(text);
      if (actions.length) errorBox.append(h('div', { class: 'row-buttons gap-half' }, actions));
    }
  }

  function updateMainButton() {
    const typed = input.value.trim().length > 0;
    const listening = mic.state === 'listening';
    const blocked = lesson.busy || lesson.finished || mic.state === 'processing' || mic.state === 'starting';
    clear(mainBtn);
    mainBtn.classList.toggle('is-on', listening);
    mainBtn.classList.toggle('is-web', mic.engine === 'webspeech');
    if (listening) {
      mainBtn.append(icon('stop'));
      mainBtn.setAttribute('aria-label', 'Zakończ mówienie');
      if (!interim.textContent) interim.textContent = LISTENING;
    } else if (typed) {
      mainBtn.append(icon('send'));
      mainBtn.setAttribute('aria-label', 'Wyślij');
      if (interim.textContent === LISTENING) interim.textContent = '';
    } else {
      mainBtn.append(icon('mic'));
      mainBtn.setAttribute('aria-label', 'Mów do Emmy');
      if (interim.textContent === LISTENING) interim.textContent = '';
    }
    if (mic.state === 'processing') interim.textContent = 'Przygotowuję nagranie...';
    mainBtn.disabled = blocked && !listening;
    input.disabled = lesson.finished;
  }

  function onMainButton() {
    setError('');
    if (mic.state === 'listening') {
      mic.stop();
      return;
    }
    if (input.value.trim()) {
      sendTyped();
      return;
    }
    tts.cancel();
    mic.start(answerLang);
  }

  function sendTyped() {
    if (lesson.busy) return;
    const text = input.value.trim();
    if (!text) return;
    mic.cancel();
    tts.cancel();
    input.value = '';
    lesson.sendText(text, 'keyboard');
    updateMainButton();
  }

  function toggleMute() {
    store.settings.muted = !store.settings.muted;
    store.saveSettings();
    if (store.settings.muted) tts.cancel();
    drawMute();
  }

  function drawMute() {
    clear(muteBtn);
    muteBtn.append(icon(store.settings.muted ? 'mute' : 'sound'));
    muteBtn.setAttribute('aria-label', store.settings.muted ? 'Włącz głos Emmy' : 'Wycisz głos Emmy');
    muteBtn.setAttribute('aria-pressed', String(store.settings.muted));
  }

  // ---------- Zeszyt ----------
  function renderSegment(seg, marks) {
    if (seg.hidden) {
      return h('p', { class: 'seg seg-hidden' }, 'Posłuchaj. Tekst pokaże się po Twojej odpowiedzi.',
        h('span', { class: 'seg-tools' },
          h('button', { type: 'button', onClick: () => tts.speak([seg], { enRate: enRate(s.unit), ignoreMute: true }) }, 'Jeszcze raz'),
          h('button', { type: 'button', onClick: () => tts.speak([seg], { enRate: 0.6, ignoreMute: true }) }, 'Wolniej')));
    }
    const text = seg.lang === 'en' ? highlighted(seg.text, marks) : [seg.text];
    const p = h('p', { class: `seg seg-${seg.lang}`, lang: seg.lang }, text);
    if (seg.lang === 'en') {
      p.append(h('span', { class: 'seg-tools' },
        h('button', { type: 'button', onClick: () => tts.speak([seg], { enRate: enRate(s.unit), ignoreMute: true }) }, 'Jeszcze raz'),
        h('button', { type: 'button', onClick: () => tts.speak([seg], { enRate: 0.6, ignoreMute: true }) }, 'Wolniej')));
    }
    return p;
  }

  function highlighted(text, marks) {
    const lower = text.toLowerCase();
    for (const m of marks || []) {
      const at = lower.indexOf(m.toLowerCase().replace(/[.!?]+$/, ''));
      if (at >= 0) {
        const len = m.replace(/[.!?]+$/, '').length;
        return [text.slice(0, at), h('mark', null, text.slice(at, at + len)), text.slice(at + len)];
      }
    }
    return [text];
  }

  function renderMe(turn, isNewest) {
    let margin = null;
    if (turn.verdict === 'ok') margin = tick(isNewest);
    if (turn.verdict === 'error') margin = cross();
    const body = h('div');
    if (turn.correction) {
      const row = h('p', { class: 'me-text', lang: 'en' });
      for (const part of wordDiff(turn.text, turn.correction.right)) {
        if (part.t === 'same') row.append(`${part.w} `);
        else row.append(h('span', { class: part.t === 'del' ? 'diff-del' : 'diff-ins' }, part.w), ' ');
      }
      body.append(row);
      if (turn.correction.why) body.append(h('p', { class: 'fix-why' }, turn.correction.why));
    } else {
      body.append(h('p', { class: 'me-text' }, turn.text || 'Nagranie wysłane'));
    }
    if (turn.source === 'mic') body.append(h('span', { class: 'me-source' }, 'rozpoznane z mikrofonu'));
    if (turn.source === 'audio') body.append(h('span', { class: 'me-source' }, 'z nagrania'));
    return h('div', { class: 'line' }, h('div', { class: 'line-margin' }, margin), body);
  }

  function renderTurns() {
    clear(pageInner);
    const list = s.turns;
    let lastMe = -1;
    list.forEach((t, i) => { if (t.k === 'me') lastMe = i; });
    list.forEach((turn, i) => {
      if (turn.k === 'phase') {
        pageInner.append(h('div', { class: 'phase-line' }, h('span', null, turn.name)));
      } else if (turn.k === 'emma') {
        pageInner.append(h('div', { class: 'line' },
          h('div', { class: 'line-margin', 'aria-label': 'Emma' }, 'E'),
          h('div', null, turn.say.map((seg) => renderSegment(seg, turn.marks)))));
      } else if (turn.k === 'me') {
        pageInner.append(renderMe(turn, i === lastMe));
      }
    });
    if (lesson.busy) {
      pageInner.append(h('div', { class: 'line' },
        h('div', { class: 'line-margin' }, 'E'),
        h('p', { class: 'typing' }, waitNote || 'Emma myśli...')));
    }
    page.scrollTop = page.scrollHeight;
  }

  function renderDock() {
    const task = s.task;
    clear(hint);
    clear(options);
    if (task && !lesson.busy) {
      const label = (HINTS[task.type] || HINTS.speak)(task.answer_lang);
      hint.append(label);
      if (task.type === 'repeat' && task.expected) hint.append(h('span', { class: 'hint-target', lang: 'en' }, task.expected));
      if (task.type === 'choice') {
        for (const opt of task.options) {
          options.append(h('button', {
            class: 'option', type: 'button', lang: 'en',
            onClick: () => {
              tts.cancel();
              mic.cancel();
              lesson.sendText(opt, 'choice');
            },
          }, opt));
        }
      }
    }
    options.style.display = options.firstChild ? '' : 'none';
    updateMainButton();
  }

  function drawClock() {
    clock.textContent = fmtClock(lesson.left);
    const phase = lesson.phase;
    phaseName.textContent = phase.name;
    unitName.textContent = `Dział ${unit.id}: ${unit.title}`;
    rulerParts.forEach((part, i) => part.classList.toggle('is-now', PHASES[i].id === phase.id));
    rulerNow.style.left = `${(s.elapsed / LESSON_SECONDS) * 100}%`;
  }

  // ---------- Pauza i koniec ----------
  function showOverlay(children) {
    clear(overlay);
    overlay.append(...children);
    overlay.hidden = false;
    overlay.style.display = '';
  }

  function hideOverlay() {
    overlay.hidden = true;
    overlay.style.display = 'none';
  }

  function resume() {
    tts.unlock();
    confirmingEnd = false;
    hideOverlay();
    lesson.run();
    const lastEmma = [...s.turns].reverse().find((t) => t.k === 'emma');
    if (lastEmma && !lesson.busy) speakTurn(lastEmma);
  }

  function drawPause() {
    const items = [
      h('h1', null, 'Lekcja wstrzymana'),
      h('div', { class: 'clock' }, fmtClock(lesson.left)),
      h('p', { class: 'muted' }, 'Zegar stoi. Wrócisz do tego samego miejsca.'),
      h('button', { class: 'btn btn-big', type: 'button', onClick: resume }, 'Wróć do lekcji'),
      h('button', { class: 'link', type: 'button', onClick: () => { lesson.persist(); teardown(); nav.go('home'); } }, 'Wyjdź do zeszytu, lekcja poczeka'),
    ];
    if (!confirmingEnd) {
      items.push(h('button', { class: 'link', type: 'button', onClick: () => { confirmingEnd = true; drawPause(); } }, 'Zakończ lekcję teraz'));
    } else {
      items.push(
        h('p', null, 'Czas nauki się zapisze, ale lekcja krótsza niż 28 minut nie liczy się jako ukończona.'),
        h('div', { class: 'row-buttons' },
          h('button', { class: 'btn btn-danger', type: 'button', onClick: () => lesson.finish({ early: true }) }, 'Zakończ lekcję'),
          h('button', { class: 'btn btn-line', type: 'button', onClick: () => { confirmingEnd = false; drawPause(); } }, 'Zostań na lekcji')),
      );
    }
    showOverlay(items);
  }

  function speakTurn(turn) {
    return tts.speak(turn.say, { enRate: enRate(s.unit) });
  }

  async function speakAndMaybeListen(turn) {
    await speakTurn(turn);
    const task = s.task;
    if (!task || lesson.paused || lesson.busy || lesson.finished || mic.active) return;
    if (!['speak', 'translate', 'repeat', 'free', 'listen'].includes(task.type)) return;
    if (input.value.trim() || document.activeElement === input) return;
    if (autoListenEnabled()) mic.start(answerLang);
  }

  // ---------- Zdarzenia lekcji ----------
  lesson.on((type, payload) => {
    switch (type) {
      case 'tick':
        drawClock();
        break;
      case 'phase':
        renderTurns();
        drawClock();
        if (payload.id === 'wrap') mic.cancel();
        break;
      case 'sent':
        setError('');
        renderTurns();
        renderDock();
        break;
      case 'busy':
        clearTimeout(slowTimer);
        if (payload) {
          waitNote = '';
          setError('');
          slowTimer = setTimeout(() => {
            if (!lesson.busy) return;
            waitNote = 'Google ma teraz duży ruch. Zegar stoi, Emma zaraz odpowie.';
            renderTurns();
          }, 5000);
        }
        renderTurns();
        renderDock();
        break;
      case 'wait':
        waitNote = `Darmowy limit na minutę. Emma odpowie za około ${payload} s, zegar stoi.`;
        renderTurns();
        break;
      case 'reply': {
        setLang(payload.task.answer_lang);
        renderTurns();
        renderDock();
        const lastEmma = s.turns[s.turns.length - 1];
        if (!lesson.paused) speakAndMaybeListen(lastEmma);
        if (payload.task.type === 'write') input.focus();
        break;
      }
      case 'failed':
        showFailure(payload);
        break;
      case 'paused':
        if (payload) {
          mic.cancel();
          tts.cancel();
          drawPause();
        }
        break;
      case 'ending':
        mic.cancel();
        showOverlay([
          h('h1', null, 'Koniec lekcji'),
          h('p', { class: 'muted' }, 'Emma pisze podsumowanie i decyduje, co dalej.'),
        ]);
        break;
      case 'ended':
        ended = true;
        teardown();
        nav.go('report', payload);
        break;
      default:
    }
  });

  function showFailure(err) {
    const retry = h('button', { class: 'btn', type: 'button', onClick: () => { setError(''); lesson.retry(); } }, 'Spróbuj ponownie');
    if (err.kind === 'quota') {
      setError(err.message, [
        retry,
        h('button', { class: 'btn btn-line', type: 'button', onClick: () => lesson.finish({ early: true }) }, 'Zakończ lekcję'),
      ]);
    } else if (err.kind === 'auth') {
      setError(err.message, [
        h('button', { class: 'btn', type: 'button', onClick: () => { lesson.pause(); teardown(); nav.go('settings'); } }, 'Otwórz ustawienia'),
      ]);
    } else {
      setError(err.message || 'Emma nie odpowiedziała.', [retry]);
    }
    renderTurns();
    renderDock();
  }

  // ---------- Telefon schowany w kieszeni: lekcja staje ----------
  function onVisibility() {
    if (document.hidden) lesson.pause();
  }
  function onHide() {
    if (!lesson.finished) lesson.persist();
  }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onHide);

  function teardown() {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onHide);
    mic.cancel();
    if (!ended) tts.cancel();
    if (lesson.timer) clearInterval(lesson.timer);
    lesson.timer = null;
    lesson.paused = true;
  }

  // ---------- Start ----------
  setLang(answerLang);
  drawMute();
  drawClock();
  renderTurns();
  renderDock();
  updateMainButton();

  // Testy lokalne mogą sterować lekcją, na opublikowanej stronie tego nie ma.
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') window.__emmaLesson = lesson;

  if (params.autoStart) {
    tts.unlock();
    lesson.persist();
    lesson.run();
  } else {
    drawPause();
  }

  return teardown;
}
