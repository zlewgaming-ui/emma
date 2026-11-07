// Raport po lekcji, powtórki bez Emmy, program, błędy i notatki.

import { A2_AFTER_UNIT, UNITS, defaultEnglishRate, unitById } from './curriculum.js';
import { transcribe } from './gemini.js';
import { tick } from './icons.js';
import { Mic, tts } from './speech.js';
import { store } from './store.js';
import { clear, fill, h, plural, similarity, wordDiff } from './util.js';

const PASS_SCORE = 0.85;

function backLink(nav) {
  return h('button', { class: 'link', type: 'button', onClick: () => { tts.cancel(); nav.go('home'); } }, 'Wróć do zeszytu');
}

// ---------- Raport ----------
export function renderReport(root, nav, data) {
  const sheet = h('div', { class: 'sheet' });
  const final = data.final;
  const minutes = Math.round(data.seconds / 60);
  sheet.append(h('h1', null, data.completed ? 'Lekcja zakończona' : 'Lekcja przerwana'));
  if (final) {
    sheet.append(h('p', { class: 'note-red gap-half' }, final.summary));
    const unitLine = data.advanced
      ? `Przechodzimy do działu ${data.unitAfter}: ${unitById(data.unitAfter).title}.`
      : `Zostajemy przy dziale ${data.unitBefore}: ${unitById(data.unitBefore).title}.`;
    sheet.append(h('h2', null, unitLine));
    if (final.reason) sheet.append(h('p', null, final.reason));
  } else if (data.finalError) {
    sheet.append(h('p', { class: 'msg msg-bad' }, `Podsumowanie Emmy nie dotarło: ${data.finalError.message} Postępy są zapisane.`));
  } else {
    sheet.append(h('p', { class: 'muted gap-half' }, 'Lekcja była zbyt krótka na podsumowanie. Czas nauki jest zapisany.'));
  }
  sheet.append(
    h('table', { class: 'register gap' },
      h('tbody', null,
        h('tr', null, h('th', { scope: 'row' }, 'Czas nauki'), h('td', null, `${minutes} min`)),
        h('tr', null, h('th', { scope: 'row' }, 'Poprawne odpowiedzi'), h('td', null, data.correct)),
        h('tr', null, h('th', { scope: 'row' }, 'Błędy poprawione'), h('td', null, data.errors)),
        h('tr', null, h('th', { scope: 'row' }, 'Nowe zwroty'), h('td', null, data.newPhrases)),
        h('tr', null, h('th', { scope: 'row' }, 'Powtórzone fiszki'), h('td', null, data.reviewed)))),
    h('div', { class: 'row-buttons gap' }, h('button', { class: 'btn', type: 'button', onClick: () => nav.go('home') }, 'Wróć do zeszytu')),
  );
  clear(root).append(sheet);
  window.scrollTo(0, 0);
}

// ---------- Powtórki bez Emmy: działają też po wyczerpaniu limitu ----------
export function renderReview(root, nav) {
  const queue = store.dueCards().slice(0, 40);
  const started = performance.now();
  let index = 0;
  let correct = 0;
  let wrong = 0;
  let recorded = false;
  const enRate = store.settings.enRate || defaultEnglishRate(store.state.progress.unit);
  const sheet = h('div', { class: 'sheet' });
  clear(root).append(sheet);

  const mic = new Mic({
    onState: () => drawMicState(),
    onInterim: (t) => { if (micNote) micNote.textContent = t; },
    onFinal: async (res) => {
      if (res.kind === 'text') {
        check(res.text);
        return;
      }
      if (micNote) micNote.textContent = 'Sprawdzam nagranie...';
      try {
        check(await transcribe(res));
      } catch (err) {
        if (micNote) micNote.textContent = `Nagranie nie przeszło: ${err.message} Napisz odpowiedź.`;
      }
    },
    onError: (why) => {
      if (micNote) {
        micNote.textContent = why === 'denied'
          ? 'Mikrofon jest zablokowany. Napisz odpowiedź.'
          : 'Nic nie słychać. Spróbuj jeszcze raz albo napisz.';
      }
    },
  });

  let micBtn = null;
  let micNote = null;

  function drawMicState() {
    if (!micBtn) return;
    micBtn.textContent = mic.state === 'listening' ? 'Zakończ mówienie' : 'Powiedz po angielsku';
    micBtn.disabled = mic.state === 'processing' || mic.state === 'starting';
  }

  function record() {
    if (recorded || index === 0 && correct + wrong === 0) return;
    recorded = true;
    store.addLessonRecord({
      type: 'review', seconds: Math.min(3600, Math.round((performance.now() - started) / 1000)), completed: true,
      correct, errors: wrong, newPhrases: 0, unit: store.state.progress.unit, summary: '', nextFocus: '', endedAt: Date.now(),
    });
    store.save();
  }

  function drawDone() {
    record();
    clear(sheet).append(
      h('h1', null, queue.length ? 'Powtórki zrobione' : 'Na dziś nie ma powtórek'),
      queue.length
        ? h('p', { class: 'note-red gap-half' }, `Dobrze: ${correct}. Do powtórki jutro: ${wrong}.`)
        : h('p', { class: 'gap-half' }, 'Następne zwroty wrócą, gdy nadejdzie ich termin.'),
      h('div', { class: 'row-buttons gap' }, h('button', { class: 'btn', type: 'button', onClick: () => nav.go('home') }, 'Wróć do zeszytu')),
    );
  }

  function check(answer) {
    const card = queue[index];
    const clean = String(answer || '').trim();
    const ok = clean && similarity(clean, card.en) >= PASS_SCORE;
    drawResult(card, clean, Boolean(ok));
  }

  function grade(card, ok) {
    store.gradeCard(card.id, ok);
    store.save();
    if (ok) correct += 1;
    else wrong += 1;
    index += 1;
    drawCard();
  }

  function drawResult(card, answer, ok) {
    tts.speak([{ lang: 'en', text: card.en }], { enRate, ignoreMute: true });
    const body = [];
    if (answer) {
      const row = h('p', { class: 'me-text', lang: 'en' });
      if (ok) row.append(answer);
      else {
        for (const part of wordDiff(answer, card.en)) {
          if (part.t === 'same') row.append(`${part.w} `);
          else row.append(h('span', { class: part.t === 'del' ? 'diff-del' : 'diff-ins' }, part.w), ' ');
        }
      }
      body.push(row);
    }
    const nextOk = h('button', { class: 'btn', type: 'button', onClick: () => grade(card, true) }, ok ? 'Dalej' : 'Jednak miałem dobrze');
    const nextBad = h('button', { class: ok ? 'btn btn-line' : 'btn', type: 'button', onClick: () => grade(card, false) }, ok ? 'Jednak nie umiałem' : 'Dalej');
    clear(sheet).append(
      backLink(nav),
      h('p', { class: 'muted' }, `${index + 1} z ${queue.length}`),
      h('p', { class: 'flash-pl gap-half' }, card.pl),
      h('div', { class: 'gap-half' }, body),
      h('p', { class: 'hand gap-half', lang: 'en' }, ok ? tick(true) : null, ok ? ' ' : null, h('mark', null, card.en)),
      h('div', { class: 'row-buttons gap' }, ok ? [nextOk, nextBad] : [nextBad, nextOk]),
    );
    const svg = sheet.querySelector('svg');
    if (svg) {
      svg.style.width = '26px';
      svg.style.height = '22px';
      svg.style.color = 'var(--red)';
    }
  }

  function drawCard() {
    mic.cancel();
    if (index >= queue.length) {
      drawDone();
      return;
    }
    const card = queue[index];
    const field = h('input', {
      type: 'text', placeholder: 'Napisz po angielsku', autocomplete: 'off', autocapitalize: 'sentences', spellcheck: 'false', 'aria-label': 'Odpowiedź po angielsku',
      onKeydown: (e) => { if (e.key === 'Enter' && field.value.trim()) check(field.value); },
    });
    micBtn = h('button', {
      class: 'btn', type: 'button',
      onClick: () => {
        if (mic.state === 'listening') {
          mic.stop();
          return;
        }
        tts.cancel();
        if (micNote) micNote.textContent = '';
        mic.start('en');
      },
    }, 'Powiedz po angielsku');
    micNote = h('p', { class: 'interim', 'aria-live': 'polite' });
    clear(sheet).append(
      backLink(nav),
      h('p', { class: 'muted' }, `${index + 1} z ${queue.length}`),
      h('p', { class: 'flash-pl gap-half' }, card.pl),
      h('div', { class: 'row-buttons gap-half' }, micBtn),
      micNote,
      field,
      h('div', { class: 'row-buttons gap-half' },
        h('button', { class: 'btn btn-line', type: 'button', onClick: () => { if (field.value.trim()) check(field.value); } }, 'Sprawdź'),
        h('button', { class: 'link', type: 'button', onClick: () => drawResult(card, '', false) }, 'Nie pamiętam')),
    );
  }

  drawCard();
  return () => {
    mic.cancel();
    tts.cancel();
    record();
  };
}

// ---------- Program ----------
export function renderProgram(root, nav) {
  const current = store.state.progress.unit;
  const list = UNITS.map((u) => {
    const done = u.id < current;
    const now = u.id === current;
    const details = h('details', { class: `unit${now ? ' unit-now' : ''}`, open: now });
    details.append(
      h('summary', null,
        h('span', { class: 'unit-num' }, u.id),
        h('span', { class: 'unit-title' }, h('span', null, u.title)),
        h('span', { class: 'unit-done' }, done ? tick(false) : null)),
      h('div', { class: 'unit-body' },
        h('p', null, u.grammar),
        h('p', { class: 'muted' }, u.goal),
        h('ul', null, u.phrases.map(([en, pl]) => h('li', null, h('b', { lang: 'en' }, en), pl)))),
    );
    return [details, u.id === A2_AFTER_UNIT ? h('h2', null, 'Tu jesteś na poziomie A2, dalej droga do B1') : null];
  });
  const sheet = h('div', { class: 'sheet' },
    backLink(nav),
    h('h1', null, 'Program na rok'),
    h('p', { class: 'gap-half' }, 'Emma sama decyduje, kiedy przejść dalej. Dział zwykle zajmuje kilka lekcji.'),
    h('div', { class: 'gap' }, list));
  clear(root).append(sheet);
  window.scrollTo(0, 0);
}

// ---------- Błędy, notatki, zwroty ----------
export function renderNotebook(root, nav) {
  const sheet = h('div', { class: 'sheet' });

  function draw() {
    const mistakes = store.topMistakes(40);
    const notes = store.liveNotes().slice().reverse();
    const cards = store.allCards().sort((a, b) => b.addedAt - a.addedAt);
    fill(sheet,
      backLink(nav),
      h('h1', null, 'Błędy i notatki'),

      h('h2', null, 'Częste błędy'),
      mistakes.length
        ? mistakes.map((m) => h('div', { class: 'item' },
          h('div', { class: 'item-row' },
            h('div', { lang: 'en' },
              h('p', { class: 'me-text' }, wordDiff(m.wrong, m.right).map((part) => (part.t === 'same'
                ? `${part.w} `
                : [h('span', { class: part.t === 'del' ? 'diff-del' : 'diff-ins' }, part.w), ' ']))),
              h('p', { class: 'small muted' }, `${m.category}, ${m.count} ${plural(m.count, 'raz', 'razy', 'razy')}${m.why ? `. ${m.why}` : ''}`)),
            h('button', { class: 'link small', type: 'button', onClick: () => { store.deleteMistake(m.key); draw(); } }, 'Usuń'))))
        : h('p', { class: 'muted' }, 'Emma zapisze tu błędy, do których będzie wracać.'),

      h('h2', null, 'Co Emma o Tobie wie'),
      notes.length
        ? notes.map((n) => h('div', { class: 'item item-row' },
          h('p', null, n.text),
          h('button', { class: 'link small', type: 'button', onClick: () => { store.deleteNote(n.id); draw(); } }, 'Usuń')))
        : h('p', { class: 'muted' }, 'Emma zapisze tu to, co opowiesz jej o sobie. Każdą notatkę możesz usunąć.'),

      h('h2', null, `Zwroty w zeszycie: ${cards.length}`),
      cards.length
        ? cards.map((c) => h('div', { class: 'item' },
          h('p', { lang: 'en' }, h('b', null, c.en)),
          h('p', { class: 'small muted' }, `${c.pl} Następna powtórka: ${c.due}.`)))
        : h('p', { class: 'muted' }, 'Zwroty pojawią się po pierwszej lekcji.'),
    );
  }

  draw();
  clear(root).append(sheet);
  window.scrollTo(0, 0);
}
