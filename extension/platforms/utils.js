// platforms/utils.js — Shared utilities for every platform content script.
//
// IMPORTANT: each platform script is injected alongside utils.js in the same
// isolated world, so we attach helpers to `globalThis` instead of relying on
// script-local function hoisting. State that must persist across clicks lives
// on a single shared object, not on module-level `let`s that scripts cannot
// re-initialise.

// ─── PII patterns ────────────────────────────────────────────────────────────
const EMAIL_RE_SRC = '[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}';
const PHONE_RE_SRC = '(?<!\\d)(\\+\\d[\\d\\s().\\-]{7,}\\d|\\(\\d{3}\\)\\s?\\d{3}[\\s.-]?\\d{4}|\\d{3}[\\s.-]?\\d{3}[\\s.-]?\\d{4})(?!\\d)';

function findEmails(text) {
  if (!text) return [];
  const re = new RegExp(EMAIL_RE_SRC, 'g');
  const out = new Set();
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[0].toLowerCase());
  return [...out];
}

function findPhones(text) {
  if (!text) return [];
  const re = new RegExp(PHONE_RE_SRC, 'g');
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) continue;
    if (/^(\d)\1+$/.test(digits)) continue;
    if (/^(19|20)\d{6,}$/.test(digits)) continue;
    if (/^\d{1,5}$/.test(digits)) continue;
    if (digits.length >= 13 && !m[0].trim().startsWith('+')) continue;
    const trimmed = m[0].trim();
    if (!seen.has(trimmed)) { seen.add(trimmed); out.push(trimmed); }
  }
  return out;
}

// ─── De-duplication (per content-script lifetime) ────────────────────────────

const _state = globalThis.__sceState || (globalThis.__sceState = { seen: new Set() });

function userKey(profileUrl, username) {
  return (profileUrl || username || '').toLowerCase().replace(/\/+$/, '');
}

function isNewUser(profileUrl, username) {
  const key = userKey(profileUrl, username);
  if (!key) return false;
  if (_state.seen.has(key)) return false;
  _state.seen.add(key);
  return true;
}

function clearSeenUsers() {
  _state.seen.clear();
}

// ─── Profile URL extraction ─────────────────────────────────────────────────

function extractProfileUrls(container, selectors) {
  const urls = new Map(); // url -> { name, username }
  if (!container) return [];
  const hostname = window.location.hostname;
  for (const sel of selectors) {
    let els;
    try { els = container.querySelectorAll(sel); } catch { continue; }
    for (const el of els) {
      const href = el.getAttribute && el.getAttribute('href');
      if (!href) continue;
      let full;
      try { full = new URL(href, window.location.href).href; } catch { continue; }
      try {
        const parsed = new URL(full);
        if (parsed.hostname !== hostname && !parsed.hostname.endsWith('.' + hostname)) continue;
      } catch { continue; }
      const name = (el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '').trim();
      if (!urls.has(full)) urls.set(full, { name: name.substring(0, 100) });
    }
  }
  return [...urls.entries()].map(([url, info]) => ({ url, ...info }));
}

// ─── Click & scroll helpers ─────────────────────────────────────────────────

function clickElement(el) {
  if (!el) return false;
  try { el.scrollIntoView({ block: 'center' }); } catch { /* some elements are not scrollable */ }
  try {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  } catch (e) {
    try { el.click(); } catch { return false; }
  }
  return true;
}

function scrollToBottom(el) {
  if (!el) return;
  try { el.scrollTop = el.scrollHeight; } catch { /* ignore */ }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function scrollUntilStable(el, { maxScrolls = 10, interval = 400 } = {}) {
  if (!el) return;
  for (let i = 0; i < maxScrolls; i++) {
    const prev = el.scrollHeight;
    scrollToBottom(el);
    await sleep(interval);
    if (el.scrollHeight <= prev) break;
  }
}

// ─── Messaging back to the popup ─────────────────────────────────────────────

// IMPORTANT: when the content script sends collected profile URLs to the
// background, each profile MUST carry a `source` field so the popup can group
// results as Likers / Commenters / Other. The previous version of the
// background dropped this field — the new version preserves it.

function sendResult(user) {
  if (!user) return;
  if (!isNewUser(user.profileUrl, user.username)) return;
  try {
    chrome.runtime.sendMessage({ type: 'scanResult', user }, () => void chrome.runtime.lastError);
  } catch { /* popup closed */ }
}

function sendProgress(done, total, label) {
  try {
    chrome.runtime.sendMessage({
      type: 'scanProgress',
      // Match what the popup expects (see popup.js handleMessage). The
      // background's *profile-visit* progress uses the same shape.
      current: done,
      total,
      detail: label,
    }, () => void chrome.runtime.lastError);
  } catch { /* ignore */ }
}

function sendComplete(total) {
  clearSeenUsers();
  try {
    chrome.runtime.sendMessage({ type: 'scanComplete', total }, () => void chrome.runtime.lastError);
  } catch { /* popup closed */ }
}

function sendError(message) {
  clearSeenUsers();
  try {
    chrome.runtime.sendMessage({ type: 'scanError', message: String(message || 'Unknown error') }, () => void chrome.runtime.lastError);
  } catch { /* popup closed */ }
}

// ─── Platform detection helpers ──────────────────────────────────────────────

// Heuristic: are we on a *post* page (not home / search / profile)? Each
// platform can override; the default checks for the typical post URL shape.
function looksLikePostUrl(url) {
  if (!url) return false;
  const path = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
  if (!path) return false;
  // Generic marker: a path segment longer than 12 chars that isn't a top-nav
  // section. Each platform script can replace this with a stricter test.
  return path.length > 1 && path.split('/').filter(Boolean).length >= 1;
}

// ─── Request profile visits from background ─────────────────────────────────
//
// Instead of fetching profiles from the content script (which can't render
// SPAs), we send the list of profiles to the background service worker.
// The background opens each profile in a real tab, deep-extracts contacts
// from the rendered DOM, follows link-in-bio one level deep, and streams
// results back.

function requestProfileVisits(profiles, platform) {
  if (!profiles || profiles.length === 0) return;
  const seen = new Set();
  const unique = [];
  for (const p of profiles) {
    const key = (p.url || p.profileUrl || '').toLowerCase().replace(/\/+$/, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push({
      profileUrl: p.url || p.profileUrl,
      username: p.username || '',
      name: p.name || '',
      platform: platform || '',
      // CRITICAL: preserve the source tag (liker / commenter / other) so the
      // background can pass it through to the popup grouping.
      source: p.source || 'other',
    });
  }
  if (unique.length === 0) return;
  // Read the latest parallel setting from storage so the popup's slider
  // takes effect without needing us to re-thread it through startScan.
  let parallel = 4;
  try {
    chrome.storage.local.get(['maxParallel'], (s) => {
      const p = parseInt(s && s.maxParallel, 10);
      if (!Number.isNaN(p) && p >= 1 && p <= 8) parallel = p;
      sendVisitRequest(unique, parallel);
    });
  } catch {
    sendVisitRequest(unique, parallel);
  }
}

function sendVisitRequest(unique, parallel) {
  try {
    chrome.runtime.sendMessage({
      type: 'visitProfiles',
      profiles: unique,
      parallel,
    }, () => void chrome.runtime.lastError);
  } catch { /* ignore */ }
}

function sendCollectionDone(total) {
  try {
    chrome.runtime.sendMessage({ type: 'collectionDone', total }, () => void chrome.runtime.lastError);
  } catch { /* popup closed */ }
}

function sendStarted(total) {
  try {
    chrome.runtime.sendMessage({ type: 'scanStarted', total }, () => void chrome.runtime.lastError);
  } catch { /* popup closed */ }
}

// Expose helpers to the platform scripts.
globalThis.SCE = {
  EMAIL_RE_SRC, PHONE_RE_SRC,
  findEmails, findPhones,
  isNewUser, clearSeenUsers,
  extractProfileUrls,
  clickElement, scrollToBottom, scrollUntilStable, sleep,
  sendResult, sendProgress, sendComplete, sendError,
  sendStarted,
  requestProfileVisits, sendCollectionDone,
  looksLikePostUrl,
};
