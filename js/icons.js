// Ikony rysowane w kodzie, stałe teksty bez danych z zewnątrz.

const PATHS = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor"/>',
  send: '<path d="M4 12l16-8-6 16-3-7z" fill="currentColor"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor"/>',
  sound: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  mute: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};

export function icon(name) {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || ''}</svg>`;
  return tpl.content.firstChild;
}

// Czerwony „ptaszek” nauczyciela.
export function tick(animated = false) {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg viewBox="0 0 26 24" aria-label="Dobrze" role="img" class="${animated ? 'tick-new' : ''}"><path d="M3 13.5c2.2 1.6 4.2 3.8 6 6.5 3.4-7 8-12.6 14-17" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return tpl.content.firstChild;
}

export function cross() {
  const tpl = document.createElement('template');
  tpl.innerHTML = '<svg viewBox="0 0 26 24" aria-label="Do poprawy" role="img"><path d="M6 5c4 4.5 9 9.500 14 14M20 4.500C15.500 9.500 10.500 14.500 6 19.500" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  return tpl.content.firstChild;
}
