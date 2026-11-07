// Start aplikacji, nawigacja i ekran główny.

import { A2_AFTER_UNIT, LAST_UNIT, levelName } from './curriculum.js';
import { LESSON_SECONDS } from './emma.js';
import { Lesson } from './lesson.js';
import { renderLesson } from './screen-lesson.js';
import { renderNotebook, renderProgram, renderReport, renderReview } from './screen-other.js';
import { renderSettings, renderSetup } from './screen-setup.js';
import { isIOS, isStandalone, tts } from './speech.js';
import { STREAK_MINUTES, store } from './store.js';
import { syncConfigured, syncNow } from './sync.js';
import { clear, fmtClock, h, plural, todayStr } from './util.js';

const root = document.getElementById('app');
let cleanup = null;
let current = 'home';
let installEvent = null;
let syncProblem = '';

const nav = {
  go(name, params) {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    current = name;
    const out = SCREENS[name](root, nav, params);
    if (typeof out === 'function') cleanup = out;
    if (name === 'home' || name === 'report') runSync();
  },
};

function runSync() {
  if (!syncConfigured()) return;
  syncNow()
    .then(() => {
      if (syncProblem) syncProblem = '';
      if (current === 'home') redrawHome();
    })
    .catch((err) => {
      syncProblem = err.message;
      if (current === 'home') redrawHome();
    });
}

function redrawHome() {
  SCREENS.home(root, nav);
}

function startLesson() {
  if (!store.apiKey) {
    nav.go('setup', { step: 'key' });
    return;
  }
  store.ensureStarterCards();
  tts.unlock();
  nav.go('lesson', { autoStart: true });
}

function renderHome() {
  store.ensureStarterCards();
  const st = store.stats();
  const unit = store.unit;
  const saved = store.loadActiveLesson();
  const note = store.state.teacherNote.text
    || 'Zaczynamy od czasu przeszłego. Gramatykę biorę na siebie, mówienie na Ciebie.';

  const canResume = saved && saved.date === todayStr() && saved.started;
  const main = canResume
    ? h('button', { class: 'btn btn-big', type: 'button', onClick: () => nav.go('lesson', { resume: true }) },
      'Wróć do lekcji', h('small', null, `zostało ${fmtClock(LESSON_SECONDS - saved.elapsed)}`))
    : h('button', { class: 'btn btn-big', type: 'button', onClick: startLesson },
      'Zacznij lekcję', h('small', null, st.todayMinutes ? `30 minut, dziś masz już ${st.todayMinutes} min` : '30 minut'));

  const a2At = (A2_AFTER_UNIT / LAST_UNIT) * 100;
  const fill = h('div', { class: 'track-fill' });
  fill.style.width = `${st.share * 100}%`;
  const tickA2 = h('div', { class: 'track-tick' });
  tickA2.style.left = `${a2At}%`;
  const labelA2 = h('span', null, 'A2');
  labelA2.style.left = `${a2At}%`;
  const labelA1 = h('span', null, 'A1');
  labelA1.style.left = '0';
  const labelB1 = h('span', null, 'B1');
  labelB1.style.left = '100%';

  const sheet = h('div', { class: 'sheet' },
    h('h1', null, store.name ? `Cześć, ${store.name}` : 'Cześć'),
    h('p', { class: 'note-red teacher-note', role: 'note' }, note),

    h('div', { class: 'gap' }, main),
    st.due > 0
      ? h('button', { class: 'link', type: 'button', onClick: () => nav.go('review') }, `Powtórz zwroty bez Emmy (${st.due})`)
      : null,

    h('h2', null, `Dział ${unit.id} z ${LAST_UNIT}: ${unit.title}`),
    h('p', { class: 'muted' }, `${unit.goal} Teraz: ${levelName(unit.id)}.`),
    h('div', { class: 'track', role: 'img', 'aria-label': `Postęp w programie: ${Math.round(st.share * 100)} procent` }, fill, tickA2),
    h('div', { class: 'track-labels', 'aria-hidden': 'true' }, labelA1, labelA2, labelB1),

    h('table', { class: 'register gap' },
      h('tbody', null,
        h('tr', null, h('th', { scope: 'row' }, 'Seria dni'), h('td', null, st.streak)),
        h('tr', null, h('th', { scope: 'row' }, 'Ukończone lekcje'), h('td', null, st.lessons)),
        h('tr', null, h('th', { scope: 'row' }, 'Minuty nauki'), h('td', null, st.minutes)),
        h('tr', null, h('th', { scope: 'row' }, 'Zwroty w zeszycie'), h('td', null, st.cards)),
        h('tr', null, h('th', { scope: 'row' }, 'Dziś do powtórki'), h('td', null, st.due)))),
    h('p', { class: 'small muted gap-half' }, `Dzień liczy się do serii od ${STREAK_MINUTES} ${plural(STREAK_MINUTES, 'minuty', 'minut', 'minut')} nauki.`),

    syncProblem ? h('div', { class: 'notice msg-bad', role: 'alert' }, `Synchronizacja nie działa: ${syncProblem}`) : null,
    !store.apiKey ? h('div', { class: 'notice' }, 'Emma potrzebuje klucza Gemini. ', h('button', { class: 'link', type: 'button', onClick: () => nav.go('setup', { step: 'key' }) }, 'Dodaj klucz')) : null,
    installNotice(),

    h('div', { class: 'home-nav' },
      h('button', { class: 'link', type: 'button', onClick: () => nav.go('program') }, 'Program'),
      h('button', { class: 'link', type: 'button', onClick: () => nav.go('notebook') }, 'Błędy i notatki'),
      h('button', { class: 'link', type: 'button', onClick: () => nav.go('settings') }, 'Ustawienia')),
  );
  clear(root).append(sheet);
}

function installNotice() {
  if (isStandalone()) return null;
  if (isIOS) {
    return h('div', { class: 'notice' },
      h('h3', null, 'Dodaj Emmę do ekranu głównego'),
      h('p', { class: 'small' }, 'W Safari naciśnij Udostępnij i wybierz Do ekranu początkowego. Aplikacja ma osobną pamięć, więc klucz wklej już w niej.'));
  }
  if (installEvent) {
    return h('div', { class: 'notice' },
      h('button', {
        class: 'btn btn-line', type: 'button',
        onClick: async () => {
          installEvent.prompt();
          await installEvent.userChoice;
          installEvent = null;
          if (current === 'home') redrawHome();
        },
      }, 'Zainstaluj aplikację'));
  }
  return null;
}

const SCREENS = {
  home: renderHome,
  setup: renderSetup,
  settings: renderSettings,
  lesson: renderLesson,
  report: renderReport,
  review: renderReview,
  program: renderProgram,
  notebook: renderNotebook,
};

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  if (current === 'home') redrawHome();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && current === 'home') runSync();
});

// Lokalnie pamięć podręczna przeszkadzałaby w testach, chyba że testujemy właśnie ją (?sw=1).
const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
if ('serviceWorker' in navigator && (!isLocal || location.search.includes('sw=1'))) {
  const hadWorker = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // Nowa wersja aplikacji: odświeżamy od razu, chyba że trwa lekcja.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadWorker && current !== 'lesson') location.reload();
  });
}

// Prośba, żeby system nie kasował postępów przy braku miejsca.
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

Lesson.closeStale();
nav.go(store.name ? 'home' : 'setup');

if (isLocal) window.__emma = { store, nav };
