// Pierwsze uruchomienie i ustawienia: klucz, głos, mikrofon, synchronizacja, kopia zapasowa.

import { GeminiError, checkKey, transcribe } from './gemini.js';
import { Mic, autoListenEnabled, hasTTS, isIOS, isStandalone, micEngine, tts, voicesFor } from './speech.js';
import { store } from './store.js';
import { connectSync, disconnectSync, exportProgress, importProgress, lastSyncTime, syncConfigured, syncNow } from './sync.js';
import { clear, fill, h } from './util.js';

const KEY_URL = 'https://aistudio.google.com/apikey';
const TOKEN_URL = 'https://github.com/settings/tokens/new?description=Emma&scopes=gist';

function message(box, text, ok) {
  clear(box);
  if (text) box.append(h('p', { class: `msg ${ok ? 'msg-ok' : 'msg-bad'}`, role: 'status' }, text));
}

// ---------- Fragmenty wspólne ----------
function keyBlock(onDone) {
  const field = h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Wklej klucz', 'aria-label': 'Klucz Gemini' });
  const box = h('div');
  const check = async () => {
    const key = field.value.trim();
    if (!key) {
      message(box, 'Najpierw wklej klucz.', false);
      return;
    }
    btn.disabled = true;
    message(box, 'Sprawdzam klucz...', true);
    try {
      const models = await checkKey(key);
      store.apiKey = key;
      field.value = '';
      message(box, `Klucz działa. Główny model Emmy: ${models[0]}.`, true);
      if (onDone) onDone();
    } catch (err) {
      message(box, err.message, false);
    } finally {
      btn.disabled = false;
    }
  };
  const btn = h('button', { class: 'btn', type: 'button', onClick: check }, 'Sprawdź klucz');
  return h('div', null,
    h('ol', { class: 'steps' },
      h('li', null, h('a', { href: KEY_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Otwórz Google AI Studio'), ' i zaloguj się kontem Google.'),
      h('li', null, 'Kliknij Create API key. Jeśli zapyta o projekt, utwórz nowy.'),
      h('li', null, 'Skopiuj klucz, wróć tutaj i wklej go poniżej.')),
    h('p', { class: 'small muted gap-half' }, 'Nie podłączaj płatności: bez konta rozliczeniowego klucz działa w darmowym limicie. Klucz zostaje tylko na tym urządzeniu i idzie wyłącznie do Google. Na telefonie wklejasz go osobno.'),
    field,
    h('div', { class: 'row-buttons gap-half' }, btn),
    box);
}

function voiceTestBlock() {
  const box = h('div');
  const play = () => {
    clear(box);
    if (!hasTTS()) {
      message(box, 'Ta przeglądarka nie ma syntezatora mowy. Emma będzie tylko pisać.', false);
      return;
    }
    tts.unlock();
    const notes = [];
    if (!tts.hasVoice('pl')) notes.push('Brak polskiego głosu na tym urządzeniu. Polskie zdania przeczyta inny głos albo będą tylko na ekranie.');
    if (!tts.hasVoice('en')) notes.push('Brak angielskiego głosu na tym urządzeniu. Na komputerze otwórz Emmę w Chrome.');
    message(box, notes.join(' ') || `Polski głos: ${tts.voiceName('pl')}. Angielski głos: ${tts.voiceName('en')}.`, !notes.length);
    tts.speak([
      { lang: 'pl', text: 'Cześć, tu Emma. Tak brzmię po polsku.' },
      { lang: 'en', text: 'And this is my voice in English.' },
    ], { ignoreMute: true });
  };
  return h('div', null,
    h('button', { class: 'btn btn-line', type: 'button', onClick: play }, 'Posłuchaj Emmy'),
    box);
}

function micTestBlock() {
  const box = h('div');
  let btn;
  const reset = () => { btn.disabled = false; btn.textContent = 'Sprawdź mikrofon'; };
  const mic = new Mic({
    onState: (st) => {
      if (st === 'listening') {
        btn.textContent = 'Powiedz: I was at home. Naciśnij, gdy skończysz';
        btn.disabled = false;
      }
    },
    onInterim: (t) => message(box, t, true),
    onFinal: async (res) => {
      reset();
      if (res.kind === 'text') {
        message(box, `Rozpoznane: ${res.text}`, true);
        return;
      }
      if (!store.apiKey) {
        message(box, 'Nagranie działa. Rozpoznawanie sprawdzisz po wklejeniu klucza.', true);
        return;
      }
      message(box, 'Wysyłam nagranie do Gemini...', true);
      try {
        const text = await transcribe(res);
        message(box, text ? `Rozpoznane: ${text}` : 'Gemini nic nie usłyszał. Spróbuj głośniej.', Boolean(text));
      } catch (err) {
        const quota = err instanceof GeminiError && err.kind === 'quota';
        message(box, quota
          ? err.message
          : `Gemini nie przyjął nagrania (${err.message}). Możesz mówić przez mikrofon na klawiaturze telefonu: pole tekstowe, ikona mikrofonu.`, false);
      }
    },
    onError: (why) => {
      reset();
      const text = {
        denied: 'Mikrofon jest zablokowany. Zezwól na niego i spróbuj ponownie.',
        nothing: 'Nic nie słychać. Spróbuj jeszcze raz.',
        switched: 'Rozpoznawanie mowy nie działa, przełączam na nagrywanie. Spróbuj jeszcze raz.',
        unsupported: 'Ta przeglądarka nie obsługuje mikrofonu. Możesz pisać odpowiedzi.',
      }[why];
      message(box, text || 'Mikrofon nie działa.', false);
    },
  });
  btn = h('button', {
    class: 'btn btn-line',
    type: 'button',
    onClick: () => {
      if (mic.state === 'listening') { mic.stop(); return; }
      tts.cancel();
      btn.disabled = true;
      mic.start('en');
    },
  }, 'Sprawdź mikrofon');
  const engineName = micEngine() === 'webspeech' ? 'rozpoznawanie mowy przeglądarki' : 'nagranie rozpoznawane przez Gemini';
  return h('div', null, btn, h('p', { class: 'small muted gap-half' }, `Na tym urządzeniu: ${engineName}.`), box);
}

function syncBlock(onDone) {
  const field = h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Wklej token', 'aria-label': 'Token GitHub' });
  const box = h('div');
  const connect = async () => {
    btn.disabled = true;
    message(box, 'Łączę z GitHubem...', true);
    try {
      const out = await connectSync(field.value);
      field.value = '';
      const text = out.existed ? 'Połączono. Postępy z drugiego urządzenia są już tutaj.' : 'Połączono. Utworzyłem ukryty plik z postępami.';
      message(box, text, true);
      if (onDone) onDone(text);
    } catch (err) {
      message(box, err.message, false);
    } finally {
      btn.disabled = false;
    }
  };
  const btn = h('button', { class: 'btn', type: 'button', onClick: connect }, 'Połącz');
  return h('div', null,
    h('ol', { class: 'steps' },
      h('li', null, h('a', { href: TOKEN_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Otwórz stronę tokena na GitHubie'), '. Pole gist jest już zaznaczone.'),
      h('li', null, 'W polu Expiration wybierz No expiration.'),
      h('li', null, 'Kliknij Generate token na dole strony i skopiuj token.'),
      h('li', null, 'Wklej go tutaj. Na drugim urządzeniu wklej ten sam token.')),
    h('p', { class: 'small muted gap-half' }, 'Postępy trafią do ukrytego pliku na Twoim GitHubie. Nikt go nie znajdzie przez wyszukiwarkę, ale może go otworzyć każdy, kto ma dokładny link. Token i klucz Gemini nie trafiają do tego pliku.'),
    field,
    h('div', { class: 'row-buttons gap-half' }, btn),
    box);
}

function installSteps() {
  return h('ol', { class: 'steps' },
    h('li', null, 'Otwórz tę stronę w Safari.'),
    h('li', null, 'Naciśnij przycisk Udostępnij.'),
    h('li', null, 'Wybierz Do ekranu początkowego i potwierdź Dodaj.'),
    h('li', null, 'Otwórz Emmę z ekranu głównego i tam wklej klucz.'));
}

// ---------- Pierwsze uruchomienie ----------
export function renderSetup(root, nav, params = {}) {
  const needsInstall = isIOS && !isStandalone();
  const steps = [];
  if (needsInstall) steps.push('install');
  steps.push('name', 'key', 'voice', 'sync');
  let index = params.step ? Math.max(0, steps.indexOf(params.step)) : 0;

  const next = () => {
    if (index < steps.length - 1) {
      index += 1;
      draw();
    } else {
      nav.go('home');
    }
  };

  function draw() {
    const name = steps[index];
    const nav2 = (primaryLabel, disabled) => h('div', { class: 'row-buttons gap' },
      h('button', { class: 'btn', type: 'button', disabled, onClick: next }, primaryLabel));
    const sheet = h('div', { class: 'sheet' });

    if (name === 'install') {
      sheet.append(
        h('h1', null, 'Najpierw dodaj Emmę do ekranu głównego'),
        h('p', { class: 'gap-half' }, 'Aplikacja z ekranu głównego i strona w Safari mają osobną pamięć. Klucz wklej dopiero w aplikacji, żeby nie robić tego dwa razy.'),
        h('div', { class: 'gap-half' }, installSteps()),
        h('button', { class: 'link gap-half', type: 'button', onClick: next }, 'Pomiń, zostaję w Safari'),
      );
    }

    if (name === 'name') {
      const field = h('input', { type: 'text', value: store.name, placeholder: 'Twoje imię', autocomplete: 'given-name', 'aria-label': 'Twoje imię' });
      const go = () => {
        if (!field.value.trim()) {
          field.focus();
          return;
        }
        store.setName(field.value);
        next();
      };
      field.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      sheet.append(
        h('h1', null, 'Cześć, jestem Emma'),
        h('p', { class: 'note-red gap-half' }, 'U mnie się nie klika, tylko mówi. Zaczynamy od czasu przeszłego.'),
        h('p', { class: 'gap-half' }, 'Co dzień 30 minut: powtórka, nowy materiał, rozmowa po angielsku i podsumowanie. Ja pilnuję czasu i poprawiam błędy.'),
        h('label', { class: 'field' }, 'Jak masz na imię?', field),
        h('div', { class: 'row-buttons gap' }, h('button', { class: 'btn', type: 'button', onClick: go }, 'Dalej')),
      );
    }

    if (name === 'key') {
      const hasKey = Boolean(store.apiKey);
      const later = h('button', { class: 'btn', type: 'button', disabled: !hasKey, onClick: next }, 'Dalej');
      fill(sheet,
        h('h1', null, 'Darmowy klucz do Gemini'),
        h('p', { class: 'gap-half' }, 'Gemini to model AI, który myśli za Emmę. Klucz zdobędziesz w dwie minuty.'),
        h('div', { class: 'gap-half' }, keyBlock(() => { later.disabled = false; })),
        hasKey ? h('p', { class: 'msg msg-ok' }, 'Klucz jest już zapisany na tym urządzeniu.') : null,
        h('div', { class: 'row-buttons gap' }, later),
      );
    }

    if (name === 'voice') {
      sheet.append(
        h('h1', null, 'Głos i mikrofon'),
        h('p', { class: 'gap-half' }, 'Sprawdź, czy słyszysz Emmę i czy ona słyszy Ciebie. Zawsze możesz też pisać zamiast mówić.'),
        h('div', { class: 'gap-half' }, voiceTestBlock()),
        h('div', { class: 'gap-half' }, micTestBlock()),
        nav2('Dalej'),
      );
    }

    if (name === 'sync') {
      const already = syncConfigured();
      sheet.append(
        h('h1', null, 'Komputer i telefon'),
        h('p', { class: 'gap-half' }, 'Żeby postępy przechodziły między urządzeniami, połącz Emmę z GitHubem. Możesz to zrobić później w ustawieniach.'),
        h('div', { class: 'gap-half' }, already ? h('p', { class: 'msg msg-ok' }, 'Synchronizacja jest już włączona.') : syncBlock(() => {})),
        nav2('Zacznij korzystać'),
      );
    }

    clear(root).append(sheet);
    window.scrollTo(0, 0);
  }

  draw();
}

// ---------- Ustawienia ----------
function formatSyncTime(ts) {
  if (!ts) return 'jeszcze nie';
  return new Date(ts).toLocaleString('pl-PL', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function voiceSelect(lang, label) {
  const key = lang === 'pl' ? 'plVoice' : 'enVoice';
  const select = h('select', {
    onChange: (e) => {
      store.settings[key] = e.target.value;
      store.saveSettings();
      tts.speak([{ lang, text: lang === 'pl' ? 'Tak brzmi ten głos.' : 'This is how this voice sounds.' }], { ignoreMute: true });
    },
  }, h('option', { value: '' }, 'Dobierz automatycznie'),
  voicesFor(lang).map((v) => h('option', { value: v.name, selected: store.settings[key] === v.name }, v.name)));
  return h('label', { class: 'field' }, label, select);
}

export function renderSettings(root, nav) {
  const sheet = h('div', { class: 'sheet' });

  // Imię
  const nameField = h('input', { type: 'text', value: store.name, 'aria-label': 'Twoje imię', onChange: (e) => store.setName(e.target.value) });

  // Klucz
  const keyArea = h('div');
  const drawKey = () => {
    clear(keyArea);
    if (store.apiKey) {
      const remove = h('button', {
        class: 'btn btn-line',
        type: 'button',
        onClick: () => {
          store.apiKey = '';
          drawKey();
        },
      }, 'Usuń klucz z tego urządzenia');
      keyArea.append(
        h('p', null, 'Klucz jest zapisany na tym urządzeniu.'),
        h('p', { class: 'small muted' }, `Modele: ${(store.settings.models || []).join(', ') || 'jeszcze nie sprawdzone'}.`),
        h('div', { class: 'row-buttons gap-half' }, remove),
      );
    } else {
      keyArea.append(keyBlock(drawKey));
    }
  };
  drawKey();

  // Mikrofon
  const micSelect = h('select', {
    onChange: (e) => {
      store.settings.micMode = e.target.value;
      store.saveSettings();
    },
  },
  h('option', { value: 'auto', selected: store.settings.micMode === 'auto' }, 'Automatycznie'),
  h('option', { value: 'webspeech', selected: store.settings.micMode === 'webspeech' }, 'Rozpoznawanie mowy przeglądarki'),
  h('option', { value: 'gemini', selected: store.settings.micMode === 'gemini' }, 'Nagranie rozpoznawane przez Gemini'));

  const auto = h('input', {
    type: 'checkbox',
    checked: autoListenEnabled(),
    onChange: (e) => {
      store.settings.autoListen = e.target.checked;
      store.saveSettings();
    },
  });

  const rateLabel = h('span');
  const showRate = (v) => { rateLabel.textContent = v ? `Tempo angielskiego głosu: ${Number(v).toFixed(2).replace('.', ',')}` : 'Tempo angielskiego głosu: dobrane do działu'; };
  showRate(store.settings.enRate);
  const rate = h('input', {
    type: 'range', min: '0.6', max: '1.2', step: '0.05', value: String(store.settings.enRate || 0.85), 'aria-label': 'Tempo angielskiego głosu',
    onInput: (e) => {
      store.settings.enRate = Number(e.target.value);
      store.saveSettings();
      showRate(store.settings.enRate);
    },
    onChange: () => tts.speak([{ lang: 'en', text: 'I was at home yesterday.' }], { enRate: store.settings.enRate, ignoreMute: true }),
  });
  const rateAuto = h('button', {
    class: 'link', type: 'button',
    onClick: () => {
      store.settings.enRate = null;
      store.saveSettings();
      showRate(null);
    },
  }, 'Dobieraj tempo do działu');

  // Synchronizacja
  const syncArea = h('div');
  const drawSync = (connectedText) => {
    clear(syncArea);
    if (syncConfigured()) {
      const box = h('div');
      if (connectedText) message(box, connectedText, true);
      const now = h('button', {
        class: 'btn', type: 'button',
        onClick: async () => {
          now.disabled = true;
          message(box, 'Synchronizuję...', true);
          try {
            await syncNow({ force: true });
            message(box, 'Gotowe. Postępy są aktualne.', true);
            clear(when);
            when.append(`Ostatnia synchronizacja: ${formatSyncTime(lastSyncTime())}.`);
          } catch (err) {
            message(box, err.message, false);
          } finally {
            now.disabled = false;
          }
        },
      }, 'Synchronizuj teraz');
      const off = h('button', {
        class: 'btn btn-line', type: 'button',
        onClick: () => {
          disconnectSync();
          drawSync();
        },
      }, 'Odłącz to urządzenie');
      const when = h('p', null, `Ostatnia synchronizacja: ${formatSyncTime(lastSyncTime())}.`);
      syncArea.append(when, h('div', { class: 'row-buttons gap-half' }, now, off), box);
    } else {
      syncArea.append(syncBlock(drawSync));
    }
  };
  drawSync();

  // Kopia zapasowa
  const backupBox = h('div');
  const fileInput = h('input', {
    type: 'file', accept: 'application/json,.json', 'aria-label': 'Plik z postępami',
    onChange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        await importProgress(file);
        message(backupBox, 'Wczytano. Postępy z pliku połączyłem z tymi na urządzeniu.', true);
      } catch (err) {
        message(backupBox, err.message, false);
      }
      e.target.value = '';
    },
  });
  fileInput.style.display = 'none';

  // Kasowanie
  const resetArea = h('div');
  const drawReset = (asking) => {
    clear(resetArea);
    if (!asking) {
      resetArea.append(h('button', { class: 'link', type: 'button', onClick: () => drawReset(true) }, 'Usuń wszystkie postępy z tego urządzenia'));
    } else {
      resetArea.append(
        h('p', null, 'Znikną fiszki, lekcje, błędy i notatki na tym urządzeniu. Plik na GitHubie zostaje, a klucz też.'),
        h('div', { class: 'row-buttons gap-half' },
          h('button', {
            class: 'btn btn-danger', type: 'button',
            onClick: () => {
              if (syncConfigured()) disconnectSync();
              store.resetEverything();
              nav.go('setup');
            },
          }, 'Usuń postępy'),
          h('button', { class: 'btn btn-line', type: 'button', onClick: () => drawReset(false) }, 'Zostaw')),
      );
    }
  };
  drawReset(false);

  sheet.append(
    h('button', { class: 'link', type: 'button', onClick: () => nav.go('home') }, 'Wróć do zeszytu'),
    h('h1', null, 'Ustawienia'),

    h('h2', null, 'Imię'),
    nameField,

    h('h2', null, 'Klucz Gemini'),
    keyArea,

    h('h2', null, 'Głos Emmy'),
    voiceTestBlock(),
    voiceSelect('pl', 'Polski głos'),
    voiceSelect('en', 'Angielski głos'),
    h('label', { class: 'field' }, rateLabel, rate),
    rateAuto,

    h('h2', null, 'Mikrofon'),
    micTestBlock(),
    h('label', { class: 'field' }, 'Sposób rozpoznawania mowy', micSelect),
    h('label', { class: 'check' }, auto, h('span', null, 'Włączaj mikrofon sam, gdy Emma skończy mówić')),

    h('h2', null, 'Synchronizacja z telefonem'),
    syncArea,

    h('h2', null, 'Kopia zapasowa'),
    h('p', { class: 'small muted' }, 'Plik zawiera postępy, ale nie zawiera klucza ani tokena.'),
    h('div', { class: 'row-buttons gap-half' },
      h('button', { class: 'btn btn-line', type: 'button', onClick: () => exportProgress() }, 'Eksportuj postępy'),
      h('button', { class: 'btn btn-line', type: 'button', onClick: () => fileInput.click() }, 'Importuj postępy')),
    fileInput,
    backupBox,

    h('h2', null, 'Dane'),
    resetArea,
  );
  clear(root).append(sheet);
  window.scrollTo(0, 0);
}
