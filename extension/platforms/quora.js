// platforms/quora.js — Quora answer / question interactor extractor
// Works on: quora.com
//
// Strategy:
//   1. Click "Continue Reading" / "Show more" / "Read all answers" buttons
//      so the full comment list renders
//   2. Open the upvoters panel if reachable
//   3. Walk the answers and the comment thread for profile links
//
// Quora profile URLs look like:
//   https://www.quora.com/profile/<Name-with-dashes>

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
      runQuoraScan(msg.maxLikers, msg.maxComments, msg.maxNestDepth);
    } else if (msg.type === 'cancelScan') {
      cancelled = true;
    }
  });

  async function runQuoraScan(maxLikers, maxComments, maxNestDepth) {
    try {
      sendProgress(0, 100, 'Initialising Quora scan…');

      await expandAllAnswers(maxNestDepth);

      sendProgress(20, 100, 'Collecting profile URLs…');
      const likerProfiles = await collectUpvoterProfiles(maxLikers);
      const commenterProfiles = await collectCommenterProfiles(maxComments);
      const allProfiles = [...likerProfiles, ...commenterProfiles];

      sendProgress(40, 100, `Visiting ${allProfiles.length} profiles…`);
      await visitProfiles(allProfiles, {
        platform: 'Quora',
        onProgress: (done, total) => sendProgress(40 + Math.round((done / total) * 55), 95, `Visiting profile ${done}/${total}…`),
        shouldCancel: () => cancelled,
      });

      sendProgress(100, 100, `Done — visited ${allProfiles.length} profiles`);
      sendComplete(allProfiles.length);
    } catch (err) {
      sendError(err && err.message || String(err));
    }
  }

  async function expandAllAnswers(depth) {
    for (let d = 0; d < depth && !cancelled; d++) {
      const clicked = await clickButtonsMatching(
        (t) => (t.includes('continue reading') ||
                t.includes('read more') ||
                t.includes('show more') ||
                t.includes('read all') ||
                t.includes('view all') ||
                t.includes('see more')) &&
               !t.includes('hide'),
        { interval: 500, max: 12 },
      );
      if (!clicked) break;
    }
  }

  async function clickButtonsMatching(predicate, { interval = 500, max = 10 } = {}) {
    let clickedAny = false;
    for (let i = 0; i < max && !cancelled; i++) {
      const nodes = document.querySelectorAll('div[role="button"], button, a');
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

  async function collectUpvoterProfiles(max) {
    const found = [];
    const seen = new Set();

    const upvoteLink = document.querySelector('a[href*="/upvoters/"]');
    if (upvoteLink) {
      clickElement(upvoteLink);
      await sleep(1000);
    }

    const modal = document.querySelector('[role="dialog"], .modal');
    if (modal) {
      collectFromElements(
        modal.querySelectorAll('a[href*="/profile/"]'),
        found, seen, 'liker',
      );
    }

    if (found.length < max) {
      collectFromElements(
        document.querySelectorAll('a[href*="/profile/"]'),
        found, seen, 'liker',
      );
    }

    return found.slice(0, max);
  }

  async function collectCommenterProfiles(max) {
    const found = [];
    const seen = new Set();

    const candidates = document.querySelectorAll(
      '.Answer, .q-box, [data-testid="answer"], article, .Comment',
    );
    for (const c of candidates) {
      collectFromElements(c.querySelectorAll('a[href*="/profile/"]'), found, seen, 'commenter');
      if (found.length >= max) break;
    }

    if (found.length < max) {
      collectFromElements(
        document.querySelectorAll('a[href*="/profile/"]'),
        found, seen, 'commenter',
      );
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
      const idx = parts.indexOf('profile');
      if (idx !== -1 && parts[idx + 1]) return decodeURIComponent(parts[idx + 1]);
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
