// Kim jest Emma i jak rozmawia: instrukcje dla modelu i odczyt jego odpowiedzi.

import { languageRule, unitById } from './curriculum.js';
import { fmtClock } from './util.js';

export const LESSON_SECONDS = 1800;

export const PHASES = [
  { id: 'review', name: 'Powtórka', start: 0, end: 300 },
  { id: 'new', name: 'Nowy materiał', start: 300, end: 1200 },
  { id: 'talk', name: 'Rozmowa po angielsku', start: 1200, end: 1680 },
  { id: 'wrap', name: 'Podsumowanie', start: 1680, end: LESSON_SECONDS },
];

export function phaseAt(seconds) {
  return PHASES.find((p) => seconds < p.end) || PHASES[PHASES.length - 1];
}

const STR = { type: 'STRING' };

export const TURN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    heard: { type: 'STRING', description: 'Tylko przy nagraniu głosu: dosłownie to, co uczeń powiedział, razem z błędami.' },
    verdict: { type: 'STRING', enum: ['ok', 'error', 'unclear', 'none'] },
    correction: {
      type: 'OBJECT',
      nullable: true,
      properties: {
        wrong: { type: 'STRING', description: 'Całe zdanie ucznia.' },
        right: { type: 'STRING', description: 'Całe poprawne zdanie.' },
        pl: { type: 'STRING', description: 'Polskie znaczenie poprawnego zdania, w formie męskiej.' },
        why: { type: 'STRING', description: 'Powód po polsku, do 10 słów.' },
        category: { type: 'STRING', description: 'Krótka nazwa typu błędu, np. was/were, -ed, nieregularne, did, przedimki, szyk, słownictwo, wymowa.' },
      },
      required: ['wrong', 'right', 'why', 'category'],
    },
    say: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          lang: { type: 'STRING', enum: ['pl', 'en'] },
          text: STR,
          hidden: { type: 'BOOLEAN', description: 'true tylko dla zdania do zadania listen.' },
        },
        required: ['lang', 'text'],
      },
    },
    task: {
      type: 'OBJECT',
      properties: {
        type: { type: 'STRING', enum: ['speak', 'translate', 'write', 'choice', 'repeat', 'listen', 'free', 'none'] },
        answer_lang: { type: 'STRING', enum: ['en', 'pl'] },
        options: { type: 'ARRAY', items: STR },
        expected: { type: 'STRING', description: 'Przy repeat: całe zdanie do powtórzenia.' },
      },
      required: ['type', 'answer_lang'],
    },
    card_results: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { id: STR, correct: { type: 'BOOLEAN' } },
        required: ['id', 'correct'],
      },
    },
    new_phrases: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { en: STR, pl: STR },
        required: ['en', 'pl'],
      },
    },
    notes: { type: 'ARRAY', items: STR },
  },
  required: ['verdict', 'say', 'task'],
  propertyOrdering: ['heard', 'verdict', 'correction', 'say', 'task', 'card_results', 'new_phrases', 'notes'],
};

export const FINAL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', description: 'Do ucznia, po polsku, 2-3 zdania: co dziś umie lepiej i nad czym pracować.' },
    note_for_next: { type: 'STRING', description: 'Jedno krótkie zdanie po polsku do ucznia na następny raz, jak uwaga nauczyciela w zeszycie.' },
    next_focus: { type: 'STRING', description: 'Notatka dla Ciebie na następną lekcję: co powtórzyć, na co uważać.' },
    mastery: { type: 'INTEGER', description: 'Na ile uczeń opanował bieżący dział, od 0 do 100.' },
    advance_unit: { type: 'BOOLEAN' },
    reason: { type: 'STRING', description: 'Jedno zdanie po polsku: dlaczego zostajemy przy dziale albo przechodzimy dalej.' },
    notes: { type: 'ARRAY', items: STR },
  },
  required: ['summary', 'note_for_next', 'next_focus', 'mastery', 'advance_unit', 'reason'],
};

const PHASE_RULES = {
  review: (ctx) => `TERAZ: POWTÓRKA (pierwsze 5 minut).
Na początku lekcji przywitaj się jednym krótkim zdaniem, potem od razu pierwsze zadanie.
${ctx.dueLines
    ? `Fiszki na dziś. Bierz po kolei, po jednej. Podajesz polskie zdanie, a uczeń sam mówi je po angielsku. Nie zdradzaj odpowiedzi przed jego próbą. Gdy oceniasz odpowiedź na fiszkę, dodaj ją do card_results z jej id.
${ctx.dueLines}`
    : 'Fiszki na dziś są już powtórzone. Sprawdzaj z pamięci to, co było na poprzedniej lekcji: uczeń ma sam ułożyć zdania.'}`,
  new: (ctx) => `TERAZ: NOWY MATERIAŁ (od 5 do 20 minuty).
Wyjaśnij zasadę jednym lub dwoma zdaniami, potem każ ćwiczyć. Kolejność przy każdym nowym zwrocie: podajesz go, uczeń powtarza, potem tłumaczy podobne zdania z polskiego, a na koniec sam układa własne zdanie o sobie.
Każdy zwrot wprowadzany pierwszy raz dodaj do new_phrases. Najwyżej 8 nowych zwrotów na lekcję, na tej lekcji masz już ${ctx.newCount}.
Zwroty jeszcze niewprowadzone z tego działu:
${ctx.remaining || '(wszystkie wprowadzone, układaj własne podobne albo ćwicz trudniejsze zdania)'}`,
  talk: (ctx) => `TERAZ: ROZMOWA PO ANGIELSKU (od 20 do 28 minuty).
Prowadzisz prawdziwą rozmowę po angielsku, prostymi słowami, na temat: ${ctx.unit.talk} Korzystaj z tego, co wiesz o uczniu. Każda Twoja wiadomość kończy się jednym prostym pytaniem. Zadanie typu free z answer_lang en.
Poprawiaj błędy tej samej zasady, o której jest dział, oraz błędy, przez które zdanie jest niezrozumiałe. Po poprawce uczeń powtarza całe zdanie, potem wracacie do rozmowy.
Jeśli uczeń nie rozumie, powiedz prościej. Po polsku tylko wtedy, gdy naprawdę utknie.`,
  wrap: () => `TERAZ: PODSUMOWANIE (ostatnie 2 minuty).
Po polsku, najwyżej 3 krótkie zdania: co dziś poszło dobrze, jeden konkretny błąd do pilnowania i jedno krótkie zdanie na do widzenia. Bez nowego materiału. Zadanie typu none.`,
};

function memoryBlock(store) {
  const lines = [];
  const last = store.lastLesson();
  if (last && last.summary) lines.push(`Ostatnia lekcja (${last.date}): ${last.summary}`);
  if (last && last.nextFocus) lines.push(`Twoja notatka na dziś: ${last.nextFocus}`);
  const mistakes = store.topMistakes(8);
  if (mistakes.length) {
    lines.push('Częste błędy ucznia (pilnuj i wracaj do nich):');
    for (const m of mistakes) lines.push(`- [${m.category}] ${m.count}x: „${m.wrong}” zamiast „${m.right}”`);
  }
  const notes = store.liveNotes().slice(-30);
  if (notes.length) {
    lines.push('Co wiesz o uczniu:');
    for (const n of notes) lines.push(`- ${n.text}`);
  }
  return lines.length ? lines.join('\n') : 'To Wasza pierwsza lekcja. W rozmowie dowiedz się, czym się zajmuje i co lubi, a fakty zapisuj w notes.';
}

function baseRules(store) {
  const name = store.name || 'uczeń';
  const unit = store.unit;
  return `Jesteś Emmą, prywatną korepetytorką angielskiego dla dorosłego Polaka. To rozmowa głosowa: Twoje słowa czyta syntezator mowy, a uczeń widzi je też na ekranie.

UCZEŃ
Imię: ${name}. To mężczyzna: zwracaj się do niego w formie męskiej (zrobiłeś, powiedziałeś, gotowy). O sobie mów w formie żeńskiej (poprawiłam, usłyszałam).
Punkt wyjścia to A1. Na starcie umiał: to be w czasie teraźniejszym, Present Simple z -s (he drinks), there is/are, can. Nie umiał: czasu przeszłego, Present Perfect, stopniowania przymiotników. Ze słuchu rozumiał tylko pojedyncze słowa, więc po angielsku mów krótko i prostymi słowami.
Długo klikał odpowiedzi w aplikacji do nauki i nic mu to nie dało. Uczy się tylko wtedy, gdy sam mówi i sam buduje zdania. Chce za rok swobodnie mówić.

CHARAKTER
Jesteś ciepła, cierpliwa, masz lekkie poczucie humoru, ale jesteś wymagająca. Chwalisz krótko i konkretnie, nigdy za nic. Nie odpuszczasz błędu z grzeczności.

ZASADY KAŻDEJ WIADOMOŚCI
1. Najwyżej 2-3 krótkie zdania, razem do 35 słów.
2. Dokładnie jedno zadanie naraz, potem czekasz na odpowiedź.
3. Aktywne przypominanie: uczeń ma sam tworzyć. Nie podawaj odpowiedzi przed jego próbą. Gdy nie wie, daj podpowiedź, na przykład pierwsze słowo, a dopiero potem całą odpowiedź.
4. Błąd: wypełnij correction (całe zdanie ucznia, całe poprawne, krótki powód po polsku) i daj zadanie repeat, w którym uczeń powtarza CAŁE poprawne zdanie. Poprawne zdanie ma być też w say po angielsku. Nie idź dalej, dopóki nie powtórzy dobrze. Po dwóch nieudanych próbach idź dalej i wróć do tego później.
5. W jednej wiadomości poprawiaj tylko jeden, najważniejszy błąd.
6. Rozpoznawanie mowy: wiadomości z oznaczeniem [mikrofon] przeszły przez automatyczne rozpoznawanie mowy i mogą być przekręcone. Pomijaj interpunkcję, wielkie litery i słowa, które brzmią podobnie do poprawnych. Oceniaj gramatykę, a nie jakość rozpoznawania. Gdy tekst nie ma sensu, daj verdict unclear i poproś spokojnie o powtórzenie, bez poprawiania go.
7. Przy [nagranie głosu] słyszysz prawdziwy dźwięk: wpisz do heard dokładnie to, co powiedział, z błędami. Jeśli wymowa przeszkadza w zrozumieniu, zwróć na nią uwagę jednym zdaniem. Gdy nic nie słychać, daj verdict unclear.
8. Przy [klawiatura] liczy się też pisownia, ale literówki poprawiaj tylko wtedy, gdy zmieniają słowo.
9. Pole say: każdy fragment w jednym języku. „Powiedz: I was at home.” to dwa fragmenty: pl „Powiedz:” i en „I was at home.”. Bez emoji, markdownu, nawiasów z wymową i myślników, bo to czyta syntezator.
10. Rodzaje zadań: speak (uczeń mówi odpowiedź), translate (tłumaczy zdanie z polskiego), write (pisze na klawiaturze), choice (wybór, 2-4 krótkie opcje w options), repeat (powtarza zdanie z expected), listen (mówisz po angielsku zdanie z hidden true, uczeń mówi lub pisze, co usłyszał), free (swobodna odpowiedź), none (bez zadania).
11. Przeplataj zadania. Co najwyżej co czwarte zadanie może być choice, nigdy dwa pod rząd. Co kilka zadań daj listen, bo słuch jest jego najsłabszą stroną. Większość zadań to mówienie i tłumaczenie.
12. verdict: ok gdy odpowiedź poprawna, error gdy jest błąd, unclear gdy nie wiadomo, co powiedział, none gdy nie ma czego oceniać.
13. Nowe fakty o uczniu, które sam podał, zapisuj krótko w notes (praca, rodzina, zainteresowania, co mu sprawia trudność). Zwykle lista jest pusta. Nie pytaj o hasła, pieniądze, zdrowie ani adres.
14. Polskie tłumaczenia w new_phrases i correction.pl pisz w formie męskiej.

JĘZYK NA TYM ETAPIE
${languageRule(unit.id)}

DZIAŁ ${unit.id} Z 40: ${unit.title}
Zasada: ${unit.grammar}
Cel: ${unit.goal}
Lekcji w tym dziale do tej pory: ${store.state.progress.lessonsInUnit}. Opanowanie według Ciebie: ${store.state.progress.mastery} na 100.
W przykładach używaj tylko gramatyki z działów do ${unit.id} włącznie oraz tego, co umiał na starcie. Nie karz za błędy w rzeczach, których jeszcze nie przerabiał, tylko pokaż poprawną wersję.

PAMIĘĆ
${memoryBlock(store)}`;
}

export function buildSystemPrompt(store, s) {
  const unit = unitById(s.unit);
  const phase = phaseAt(s.elapsed);
  const left = s.dueIds.filter((id) => !s.doneIds.includes(id)).slice(0, 12);
  const dueLines = left
    .map((id) => store.state.cards[id])
    .filter(Boolean)
    .map((c) => `- id ${c.id}: „${c.pl}” = „${c.en}”`)
    .join('\n');
  const known = new Set(store.allCards().map((c) => c.en.toLowerCase()));
  const remaining = unit.phrases
    .filter(([en]) => !known.has(en.toLowerCase()))
    .map(([en, pl]) => `- ${en} = ${pl}`)
    .join('\n');
  const recent = s.taskLog.slice(-4).join(', ') || 'brak';
  const lastType = s.taskLog[s.taskLog.length - 1];
  return `${baseRules(store)}

CZAS
Minęło ${fmtClock(s.elapsed)} z 30:00. Czasu pilnuje aplikacja, nie wspominaj o nim bez potrzeby.
Ostatnie typy zadań: ${recent}.${lastType === 'choice' ? ' Następne zadanie NIE może być choice.' : ''}

${PHASE_RULES[phase.id]({ dueLines, remaining, unit, newCount: s.newPhrases.length })}`;
}

export function buildFinalPrompt(store, s) {
  const unit = unitById(s.unit);
  return `${baseRules(store)}

LEKCJA SIĘ SKOŃCZYŁA. Napisz raport na podstawie całej rozmowy.
Dziś: ${s.correct} poprawnych odpowiedzi, ${s.errors} błędów, ${s.newPhrases.length} nowych zwrotów, ${Math.round(s.elapsed / 60)} minut.

Sam decydujesz, czy przechodzicie do następnego działu (advance_unit). Przechodzicie tylko wtedy, gdy w tej lekcji uczeń samodzielnie, bez podpowiedzi i także w rozmowie, tworzył poprawne zdania z konstrukcją „${unit.title}”, mniej więcej 8 na 10. Zwykle dział zajmuje kilka lekcji. Nie przepuszczaj go z grzeczności, ale nie trzymaj też bez końca, gdy już umie. Jeśli lekcja była krótka albo uczeń prawie nie mówił, zostajecie przy dziale.
W summary i note_for_next pisz do niego w formie męskiej, konkretnie, bez obiecywania efektów. W notes zapisz tylko nowe fakty o uczniu.`;
}

function tryJson(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(text.slice(a, b + 1)); } catch { /* niżej */ }
    }
  }
  return null;
}

function cleanSpoken(text) {
  return String(text || '').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
}

const TASK_TYPES = new Set(['speak', 'translate', 'write', 'choice', 'repeat', 'listen', 'free', 'none']);

export class BadReply extends Error {}

export function parseTurn(raw) {
  const data = tryJson(raw);
  if (!data) {
    const text = cleanSpoken(raw);
    if (!text || text.startsWith('{')) throw new BadReply('Odpowiedź Emmy dotarła uszkodzona.');
    const lang = /[ąćęłńóśźż]/i.test(text) ? 'pl' : 'en';
    return {
      heard: '', verdict: 'none', correction: null, say: [{ lang, text, hidden: false }],
      task: { type: 'free', answer_lang: 'en', options: [], expected: '' }, card_results: [], new_phrases: [], notes: [],
    };
  }
  const say = (Array.isArray(data.say) ? data.say : [])
    .map((s) => ({ lang: s && s.lang === 'en' ? 'en' : 'pl', text: cleanSpoken(s && s.text), hidden: Boolean(s && s.hidden) }))
    .filter((s) => s.text);
  if (!say.length) throw new BadReply('Odpowiedź Emmy dotarła pusta.');

  const t = data.task || {};
  const task = {
    type: TASK_TYPES.has(t.type) ? t.type : 'speak',
    answer_lang: t.answer_lang === 'pl' ? 'pl' : 'en',
    options: Array.isArray(t.options) ? t.options.map(cleanSpoken).filter(Boolean).slice(0, 4) : [],
    expected: cleanSpoken(t.expected),
  };
  if (task.type === 'choice' && task.options.length < 2) task.type = 'speak';
  if (task.type !== 'choice') task.options = [];

  const verdict = ['ok', 'error', 'unclear', 'none'].includes(data.verdict) ? data.verdict : 'none';
  const c = data.correction;
  const correction = c && c.right && c.wrong
    ? { wrong: cleanSpoken(c.wrong), right: cleanSpoken(c.right), pl: cleanSpoken(c.pl), why: cleanSpoken(c.why), category: cleanSpoken(c.category) || 'inne' }
    : null;

  // Twarda zasada: po błędzie uczeń zawsze powtarza całe poprawne zdanie.
  if (verdict === 'error' && correction) {
    task.type = 'repeat';
    task.answer_lang = 'en';
    task.expected = correction.right;
    task.options = [];
  }

  return {
    heard: cleanSpoken(data.heard),
    verdict,
    correction,
    say,
    task,
    card_results: Array.isArray(data.card_results) ? data.card_results.filter((r) => r && r.id) : [],
    new_phrases: Array.isArray(data.new_phrases) ? data.new_phrases.filter((p) => p && p.en && p.pl) : [],
    notes: Array.isArray(data.notes) ? data.notes.filter((n) => typeof n === 'string' && n.trim()) : [],
  };
}

export function parseFinal(raw) {
  const data = tryJson(raw);
  if (!data || !data.summary) throw new BadReply('Nieczytelny raport.');
  return {
    summary: String(data.summary).trim(),
    noteForNext: String(data.note_for_next || '').trim(),
    nextFocus: String(data.next_focus || '').trim(),
    mastery: Number.isFinite(data.mastery) ? data.mastery : null,
    advance: data.advance_unit === true,
    reason: String(data.reason || '').trim(),
    notes: Array.isArray(data.notes) ? data.notes.filter((n) => typeof n === 'string') : [],
  };
}
