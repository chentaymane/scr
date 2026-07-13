// platforms/pinterest.js — Pinterest pin interactor extractor
// Works on: pinterest.com
//
// Strategy:
//   1. Click the likes count to open the reactors overlay
//   2. Open the comments panel; expand "View replies"
//   3. Walk the reactors modal and the comment list for profile links
//
// Pinterest profile URLs look like:  https://pinterest.com/user/<username>/

(function () {
  'use strict';

  const { clickElement, scrollUntilStable, sleep,
          extractContactsFromElement, sendResult, sendProgress, sendComplete, sendError,
          visitProfiles } = globalThis.SCE;

  let cancelled = false;

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'startScan') {
      cancelled = false;
      runPinterestScan(msg.maxLikers, msg.maxComments, msg.maxNestDepth);
    } else if (msg.type === 'cancelScan') {
      cancelled = true;
    }
  });

  async function runPinterestScan(maxLikers, maxComments, maxNestDepth) {
    try {
      sendProgress(0, 100, 'Initialising Pinterest scan…');

      await openLikers();
      await expandComments(maxNestDepth);

      sendProgress(20, 100, 'Collecting profile URLs…');
      const likerProfiles = await collectLikerProfiles(maxLikers);
      const commenterProfiles = await collectCommenterProfiles(maxComments);
      const allProfiles = [...likerProfiles, ...commenterProfiles];

      sendProgress(40, 100, `Visiting ${allProfiles.length} profiles…`);
      await visitProfiles(allProfiles, {
        platform: 'Pinterest',
        onProgress: (done, total) => sendProgress(40 + Math.round((done / total) * 55), 95, `Visiting profile ${done}/${total}…`),
        shouldCancel: () => cancelled,
      });

      sendProgress(100, 100, `Done — visited ${allProfiles.length} profiles`);
      sendComplete(allProfiles.length);
    } catch (err) {
      sendError(err && err.message || String(err));
    }
  }

  async function openLikers() {
    const candidates = [
      'a[data-testid="react-like-count"]',
      'a[href*="/likedBy/"]',
      '[data-testid="CloseupReactBar"] a',
      'a[href*="/pin/liked/"]',
    ];

    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) {
        clickElement(el);
        await sleep(1500);
        break;
      }
    }

    const modal = document.querySelector('[role="dialog"]');
    if (modal) await scrollUntilStable(modal, { maxScrolls: 10, interval: 400 });
  }

  async function expandComments(depth) {
    for (let d = 0; d < depth && !cancelled; d++) {
      const clicked = await clickButtonsMatching(
        (t) => (t.includes('view') || t.includes('see') || t.includes('show')) &&
               (t.includes('repl') || t.includes('comment')),
        { interval: 500, max: 10 },
      );
      if (!clicked) break;
    }
  }

  async function clickButtonsMatching(predicate, { interval = 500, max = 10 } = {}) {
    let clickedAny = false;
    for (let i = 0; i < max && !cancelled; i++) {
      const nodes = document.querySelectorAll('div[role="button"], span, a, button');
      let picked = null;
      for (const n of nodes) {
        if (!isVisible(n)) continue;
        const txt = (n.innerText || '').toLowerCase().trim();
        if (txt && predicate(txt)) { picked = n; break; }
      }
      if (!picked) return clickedAny;
      clickElement(picked);
      clickedAny = true;
      await sleep(interval);
    }
    return clickedAny;
  }

  async function collectLikerProfiles(max) {
    const found = [];
    const seen = new Set();

    const modal = document.querySelector('[role="dialog"]');
    if (modal) {
      collectFromElements(modal.querySelectorAll('a[href*="/user/"]'), found, seen, 'liker');
    }

    if (found.length < max) {
      collectFromElements(
        document.querySelectorAll('a[href*="/user/"], a[href*="/pin/"]'),
        found, seen, 'liker',
      );
    }

    return found.slice(0, max);
  }

  async function collectCommenterProfiles(max) {
    const found = [];
    const seen = new Set();

    const commentEls = document.querySelectorAll(
      '[data-testid="comment-text"], .comment, .Comment, [aria-label*="comment"]',
    );
    for (const c of commentEls) {
      collectFromElements(c.querySelectorAll('a[href*="/user/"]'), found, seen, 'commenter');
      if (found.length >= max) break;
    }

    return found.slice(0, max);
  }

  function collectFromElements(elements, found, seen, source) {
    for (const el of elements) {
      const href = el.getAttribute('href');
      if (!href) continue;

      const fullUrl = safeAbsoluteUrl(href);
      if (!fullUrl || !isSameHost(fullUrl)) continue;
      if (seen.has(fullUrl)) continue;
      seen.add(fullUrl);

      const username = extractUsername(href);
      const name = extractDisplayName(el);

      found.push({
        name: name || username || 'Unknown',
        username,
        profileUrl: fullUrl,
        source,
      });
    }
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent !== null) return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function safeAbsoluteUrl(href) {
    try { return new URL(href, window.location.href).href; } catch { return null; }
  }

  function isSameHost(url) {
    try {
      const target = new URL(url).hostname;
      const base = window.location.hostname;
      return target === base || target.endsWith('.' + base);
    } catch { return false; }
  }

  function extractUsername(href) {
    try {
      const parts = new URL(href, window.location.href).pathname.split('/').filter(Boolean);
      if (parts[0] === 'user' && parts[1]) return parts[1];
      if (parts[0] && parts[0] !== 'pin' && parts[0] !== 'board' && parts[0] !== 'search') {
        return parts[0];
      }
    } catch { /* ignore */ }
    return null;
  }

  function extractDisplayName(el) {
    const span = el.querySelector('span, div');
    if (!span) return null;
    const txt = (span.innerText || '').trim().split('\n')[0];
    if (!txt || txt.length > 60) return null;
    return txt;
  }
})();
