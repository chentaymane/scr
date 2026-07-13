// platforms/utils.js — Shared utilities for every platform content script.
//
// IMPORTANT: each platform script is injected alongside utils.js in the same
// isolated world, so we attach helpers to `globalThis` instead of relying on
// script-local function hoisting. State that must persist across clicks lives
// on a single shared object, not on module-level `let`s that scripts cannot
// re-initialise.

// ─── PII patterns ───────────────────────────────────────────────────────────
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
    const trimmed = m[0].trim();
    if (!seen.has(trimmed)) { seen.add(trimmed); out.push(trimmed); }
  }
  return out;
}

// ─── De-duplication (per content-script lifetime) ───────────────────────────

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
      // Try to get a display name from the element
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

// ─── Messaging back to the popup ────────────────────────────────────────────

function sendResult(user) {
  if (!user) return;
  if (!isNewUser(user.profileUrl, user.username)) return;
  try {
    chrome.runtime.sendMessage({ type: 'scanResult', user }, () => void chrome.runtime.lastError);
  } catch { /* popup closed */ }
}

function sendProgress(done, total, label) {
  try {
    chrome.runtime.sendMessage({ type: 'scanProgress', done, total, label }, () => void chrome.runtime.lastError);
  } catch { /* ignore */ }
}

function sendComplete(total) {
  clearSeenUsers();
  try {
    chrome.runtime.sendMessage({ type: 'scanComplete', total }, () => void chrome.runtime.lastError);
  } catch { /* ignore */ }
}

function sendError(message) {
  clearSeenUsers();
  try {
    chrome.runtime.sendMessage({ type: 'scanError', message: String(message || 'Unknown error') }, () => void chrome.runtime.lastError);
  } catch { /* ignore */ }
}

// ─── Request profile visits from background ─────────────────────────────────
// Instead of fetching profiles from the content script (which can't render SPAs),
// we send the list of profiles to the background service worker. The background
// opens each profile in a real tab, waits for it to load, injects a script to
// extract emails/phones from the rendered DOM, then closes the tab.

function requestProfileVisits(profiles, platform) {
  if (!profiles || profiles.length === 0) return;
  // Deduplicate by URL
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
    });
  }
  if (unique.length === 0) return;
  try {
    chrome.runtime.sendMessage({ type: 'visitProfiles', profiles: unique }, () => void chrome.runtime.lastError);
  } catch { /* ignore */ }
}

// ─── Notify popup that all profiles have been collected ─────────────────────
function sendCollectionDone(total) {
  try {
    chrome.runtime.sendMessage({ type: 'collectionDone', total }, () => void chrome.runtime.lastError);
  } catch { /* ignore */ }
}

// Expose helpers to the platform scripts.
globalThis.SCE = {
  EMAIL_RE_SRC, PHONE_RE_SRC,
  findEmails, findPhones,
  isNewUser, clearSeenUsers,
  extractProfileUrls,
  clickElement, scrollToBottom, scrollUntilStable, sleep,
  sendResult, sendProgress, sendComplete, sendError,
  requestProfileVisits, sendCollectionDone,
};
