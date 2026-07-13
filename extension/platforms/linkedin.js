// platforms/linkedin.js — LinkedIn post interactor extractor
// Works on: linkedin.com
//
// Strategy:
//   1. Click the reactions count to open the reactors modal
//   2. Recursively click "N replies" to expand comment threads
//   3. Walk the modal and the comment list for /in/ profile links
//
// LinkedIn profile URLs look like:
//   https://www.linkedin.com/in/<username>

(function () {
  'use strict';

  const { clickElement, scrollUntilStable, sleep,
          sendResult, sendProgress, sendComplete, sendError,
          requestProfileVisits, sendCollectionDone } = globalThis.SCE;

  let cancelled = false;

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'startScan') {
      cancelled = false;
      runLinkedInScan(msg.maxLikers, msg.maxComments, msg.maxNestDepth);
    } else if (msg.type === 'cancelScan') {
      cancelled = true;
    }
  });

  async function runLinkedInScan(maxLikers, maxComments, maxNestDepth) {
    try {
      sendProgress(0, 100, 'Initialising LinkedIn scan…');

      await openReactions();

      sendProgress(20, 100, 'Collecting profile URLs…');
      const likerProfiles = await collectReactionProfiles(maxLikers);
      const commenterProfiles = await collectCommenterProfiles(maxComments, maxNestDepth);
      const allProfiles = [...likerProfiles, ...commenterProfiles];

      sendProgress(40, 100, `Sending ${allProfiles.length} profiles for visiting…`);
      requestProfileVisits(allProfiles, 'LinkedIn');

      sendProgress(100, 100, `Collected ${allProfiles.length} profiles — visiting in background`);
      sendCollectionDone(allProfiles.length);
    } catch (err) {
      sendError(err && err.message || String(err));
    }
  }

  async function openReactions() {
    const candidates = [
      'button[aria-label*="reactions"]',
      'button[data-test-id*="reactions"]',
      '.social-details-social-activity button',
      'span[data-test-id*="social"]',
    ];

    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) {
        clickElement(el);
        await sleep(1500);
        break;
      }
    }

    const modal = document.querySelector('.artdeco-modal, .artdeco-modal__overlay');
    if (modal) await scrollUntilStable(modal, { maxScrolls: 10, interval: 400 });
  }

  async function expandReplies(depth) {
    for (let d = 0; d < depth && !cancelled; d++) {
      const clicked = await clickButtonsMatching(
        (t) => t.includes('repl') && (t.includes('view') || t.includes('show') || t.includes('see') || /\d+ repl/.test(t)),
        { interval: 600, max: 10 },
      );
      if (!clicked) break;
    }
  }

  async function clickButtonsMatching(predicate, { interval = 500, max = 10 } = {}) {
    let clickedAny = false;
    for (let i = 0; i < max && !cancelled; i++) {
      const nodes = document.querySelectorAll('button, div[role="button"], a, span');
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

  async function collectReactionProfiles(max) {
    const found = [];
    const seen = new Set();

    const modal = document.querySelector('.artdeco-modal');
    if (modal) {
      collectFromElements(
        modal.querySelectorAll('a[href*="/in/"], a[href*="/pub/"]'),
        found, seen, 'liker',
      );
    }

    if (found.length < max) {
      collectFromElements(
        document.querySelectorAll(
          '.feed-shared-actor__name-link, ' +
          '.social-details-social-activity a[href*="/in/"], ' +
          'a[href*="/in/"]',
        ),
        found, seen, 'liker',
      );
    }

    return found.slice(0, max);
  }

  async function collectCommenterProfiles(max, depth) {
    const found = [];
    const seen = new Set();

    await expandReplies(depth);

    const list = document.querySelector('.comments-comments-list, .comments-comment-list');
    if (list) await scrollUntilStable(list, { maxScrolls: 10, interval: 400 });

    const commentEls = document.querySelectorAll(
      '.comments-comment-item, .comments-comment-reshare-item, .comments-post-comment',
    );
    for (const c of commentEls) {
      collectFromElements(c.querySelectorAll('a[href*="/in/"]'), found, seen, 'commenter');
      if (found.length >= max) break;
    }

    return found.slice(0, max);
  }

  function collectFromElements(elements, found, seen, source) {
    for (const el of elements) {
      const href = el.getAttribute('href');
      if (!href) continue;

      const username = extractUsername(href);
      if (!username) continue;

      const fullUrl = safeAbsoluteUrl(href);
      if (!fullUrl || !isSameHost(fullUrl)) continue;
      if (seen.has(fullUrl)) continue;
      seen.add(fullUrl);

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
      const idx = parts.indexOf('in');
      if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
    } catch { /* ignore */ }
    return null;
  }

  function extractDisplayName(el) {
    const span = el.querySelector('span, .visually-hidden');
    if (!span) return null;
    const txt = (span.innerText || '').trim().split('\n')[0];
    if (!txt || txt.length > 60) return null;
    return txt;
  }
})();
