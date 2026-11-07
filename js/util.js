// Drobne narzędzia wspólne dla całej aplikacji.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : String(kid));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// Czyści element i wstawia zawartość, pomijając puste pozycje i rozwijając listy.
export function fill(el, ...kids) {
  clear(el);
  for (const kid of kids.flat(Infinity)) {
    if (kid != null && kid !== false) el.append(kid);
  }
  return el;
}

export function uid() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
}

export function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return todayStr(new Date(y, m - 1, d + n));
}

export function daysBetween(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}

export function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Polska odmiana: 1 zwrot, 2 zwroty, 5 zwrotów.
export function plural(n, one, few, many) {
  const a = Math.abs(n);
  if (a === 1) return one;
  const last = a % 10;
  const lastTwo = a % 100;
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return few;
  return many;
}

const CONTRACTIONS = [
  [/\bi'm\b/g, 'i am'], [/\byou're\b/g, 'you are'], [/\bwe're\b/g, 'we are'], [/\bthey're\b/g, 'they are'],
  [/\bhe's\b/g, 'he is'], [/\bshe's\b/g, 'she is'], [/\bit's\b/g, 'it is'], [/\bthat's\b/g, 'that is'],
  [/\bwhat's\b/g, 'what is'], [/\bthere's\b/g, 'there is'],
  [/\bi've\b/g, 'i have'], [/\byou've\b/g, 'you have'], [/\bwe've\b/g, 'we have'], [/\bthey've\b/g, 'they have'],
  [/\bi'll\b/g, 'i will'], [/\byou'll\b/g, 'you will'], [/\bwe'll\b/g, 'we will'], [/\bthey'll\b/g, 'they will'],
  [/\bhe'll\b/g, 'he will'], [/\bshe'll\b/g, 'she will'], [/\bit'll\b/g, 'it will'],
  [/\bi'd\b/g, 'i would'], [/\bwon't\b/g, 'will not'], [/\bcan't\b/g, 'cannot'], [/\bcan not\b/g, 'cannot'],
  [/\bmustn't\b/g, 'must not'], [/\b(\w+)n't\b/g, '$1 not'],
];

export function normalizeSentence(text) {
  let s = String(text || '').toLowerCase().replace(/[’`´]/g, "'");
  for (const [re, to] of CONTRACTIONS) s = s.replace(re, to);
  return s.replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Podobieństwo zdań po normalizacji, od 0 do 1. Używane przy powtórkach bez Emmy.
export function similarity(a, b) {
  const x = normalizeSentence(a);
  const y = normalizeSentence(b);
  if (!x && !y) return 1;
  const longest = Math.max(x.length, y.length) || 1;
  return 1 - levenshtein(x, y) / longest;
}

// Porównanie słowo po słowie: co zostało, co skreślić, co dopisać.
export function wordDiff(wrong, right) {
  const A = String(wrong || '').trim().split(/\s+/).filter(Boolean);
  const B = String(right || '').trim().split(/\s+/).filter(Boolean);
  const key = (w) => w.toLowerCase().replace(/[’`´]/g, "'").replace(/[^\p{L}\p{N}']/gu, '');
  const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i -= 1) {
    for (let j = B.length - 1; j >= 0; j -= 1) {
      dp[i][j] = key(A[i]) === key(B[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && key(A[i]) === key(B[j])) {
      out.push({ t: 'same', w: B[j] });
      i += 1;
      j += 1;
    } else if (j < B.length && (i >= A.length || dp[i][j + 1] > dp[i + 1][j])) {
      out.push({ t: 'ins', w: B[j] });
      j += 1;
    } else {
      out.push({ t: 'del', w: A[i] });
      i += 1;
    }
  }
  return out;
}

export function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function safeSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

export function safeRemove(key) {
  try { localStorage.removeItem(key); } catch { /* nic */ }
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(out);
}

export function sleep(ms) {
  return new Promise((r) => { setTimeout(r, ms); });
}
