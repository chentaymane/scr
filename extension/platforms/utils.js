// platforms/utils.js — Shared utilities for every platform content script.
//
// IMPORTANT: each platform script is injected alongside utils.js in the same
// isolated world, so we attach helpers to `globalThis` instead of relying on
// script-local function hoisting. State that must persist across clicks lives
// on a single shared object, not on module-level `let`s that scripts cannot
// re-initialise.

// ─── PII patterns ───────────────────────────────────────────────────────────
// NOTE: do NOT use the /g flag here — sharing a single stateful regex across
// many call sites is a footgun. Each caller creates its own instance.
const EMAIL_RE_SRC = '[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}';
// Phone with optional opening "(" (e.g. "(415) 555-0123") or "+" (e.g. "+1 415 555 0123").
// Length 7–15 digits (E.164 max) to suppress false positives on ids/counts.
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

// ─── Contact extraction from a DOM element ─────────────────────────────────

function extractContactsFromElement(el) {
  const result = { emails: [], phones: [] };
  if (!el) return result;

  // Pull text once; innerText triggers a layout, but for the small subtrees
  // we look at it's fine.
  let text = '';
  try { text = el.innerText || ''; } catch { text = ''; }

  result.emails = findEmails(text);

  // mailto: links
  try {
    for (const a of el.querySelectorAll('a[href^="mailto:"]')) {
      const href = (a.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
      if (href && !result.emails.includes(href.toLowerCase())) {
        result.emails.push(href.toLowerCase());
      }
    }
  } catch { /* querySelectorAll may throw on detached elements */ }

  result.phones = findPhones(text);

  // tel: links
  try {
    for (const a of el.querySelectorAll('a[href^="tel:"]')) {
      const href = (a.getAttribute('href') || '').replace(/^tel:/i, '').trim();
      if (href && !result.phones.includes(href)) result.phones.push(href);
    }
  } catch { /* ignore */ }

  return result;
}

// ─── Profile URL extraction ─────────────────────────────────────────────────

function extractProfileUrls(container, selectors) {
  const urls = new Set();
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
      urls.add(full);
    }
  }
  return [...urls];
}

// ─── Click & scroll helpers ─────────────────────────────────────────────────

function clickElement(el) {
  if (!el) return false;
  try {
    el.scrollIntoView({ block: 'center' });
  } catch { /* some elements are not scrollable */ }
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

// Scroll a container repeatedly until its scrollHeight stops growing or
// `maxScrolls` is reached. Returns when the list looks stable.
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
    chrome.runtime.sendMessage({ type: 'scanResult', data: user }, () => void chrome.runtime.lastError);
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

// ─── Profile visiting (fetch profile pages to extract contacts) ────────────

async function visitProfiles(profiles, { platform, onProgress, shouldCancel } = {}) {
  for (let i = 0; i < profiles.length; i++) {
    if (shouldCancel && shouldCancel()) break;
    const p = profiles[i];
    if (onProgress) onProgress(i + 1, profiles.length);
    try {
      const resp = await fetch(p.profileUrl, {
        credentials: 'include',
        headers: { 'Accept': 'text/html,application/xhtml+xml' },
      });
      if (!resp.ok) continue;
      const html = await resp.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      if (!doc.body) continue;

      const contacts = extractContactsFromElement(doc.body);

      // Also scan meta tags and JSON-LD for contact info.
      const metaContacts = extractContactsFromMeta(doc);
      const emails = [...new Set([...contacts.emails, ...metaContacts.emails])];
      const phones = [...new Set([...contacts.phones, ...metaContacts.phones])];

      sendResult({
        name: p.name || p.username || 'Unknown',
        username: p.username,
        email: emails[0] || null,
        phone: phones[0] || null,
        profileUrl: p.profileUrl,
        platform,
        source: p.source,
      });
    } catch { /* ignore fetch/parse errors */ }
  }
}

function extractContactsFromMeta(doc) {
  const result = { emails: [], phones: [] };
  if (!doc) return result;

  // Meta tags
  for (const meta of doc.querySelectorAll('meta')) {
    const content = meta.getAttribute('content') || '';
    const attr = (meta.getAttribute('name') || meta.getAttribute('property') || '').toLowerCase();
    if (attr.includes('email') || attr.includes('contact')) {
      result.emails.push(...findEmails(content));
    }
    if (attr.includes('phone') || attr.includes('tel')) {
      result.phones.push(...findPhones(content));
    }
  }

  // mailto: / tel: links
  for (const a of doc.querySelectorAll('a[href^="mailto:"]')) {
    const href = (a.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
    if (href) result.emails.push(href.toLowerCase());
  }
  for (const a of doc.querySelectorAll('a[href^="tel:"]')) {
    const href = (a.getAttribute('href') || '').replace(/^tel:/i, '').trim();
    if (href) result.phones.push(href);
  }

  // JSON-LD structured data
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try { walkJsonLd(JSON.parse(script.textContent), result); } catch { /* ignore */ }
  }

  result.emails = [...new Set(result.emails)];
  result.phones = [...new Set(result.phones)];
  return result;
}

function walkJsonLd(node, out) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(n => walkJsonLd(n, out)); return; }
  if (typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    const key = k.toLowerCase();
    if (key === 'email' && typeof v === 'string') out.emails.push(...findEmails(v));
    if ((key === 'phone' || key === 'telephone') && typeof v === 'string') out.phones.push(...findPhones(v));
    if (typeof v === 'object') walkJsonLd(v, out);
  }
}

// Expose helpers to the platform scripts.
globalThis.SCE = {
  EMAIL_RE_SRC, PHONE_RE_SRC,
  findEmails, findPhones,
  isNewUser, clearSeenUsers,
  extractContactsFromElement, extractProfileUrls,
  clickElement, scrollToBottom, scrollUntilStable, sleep,
  sendResult, sendProgress, sendComplete, sendError,
  visitProfiles,
};
