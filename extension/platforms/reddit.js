// platforms/reddit.js — Reddit post interactor extractor
// Works on: reddit.com (old + new UI)
//
// Strategy:
//   1. Click "Continue thread" and "load more comments" repeatedly
//   2. Lazy-scroll the page to expose all comment threads
//   3. Walk the comment tree for /user/ and /u/ profile links
//
// Reddit profile URLs look like:
//   https://www.reddit.com/user/<username>
//   https://www.reddit.com/u/<username>

(function () {
  'use strict';

  const { clickElement, sleep, extractContactsFromElement,
          sendResult, sendProgress, sendComplete, sendError,
          visitProfiles } = globalThis.SCE;

  let cancelled = false;

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'startScan') {
      cancelled = false;
      runRedditScan(msg.maxLikers, msg.maxComments, msg.maxNestDepth);
    } else if (msg.type === 'cancelScan') {
      cancelled = true;
    }
  });

  async function runRedditScan(maxLikers, maxComments, maxNestDepth) {
    try {
      sendProgress(0, 100, 'Initialising Reddit scan…');

      await expandAllComments(maxNestDepth);

      sendProgress(20, 100, 'Collecting profile URLs…');
      const likerProfiles = await collectUpvoterProfiles(maxLikers);
      const commenterProfiles = await collectCommenterProfiles(maxComments);
      const allProfiles = [...likerProfiles, ...commenterProfiles];

      sendProgress(40, 100, `Visiting ${allProfiles.length} profiles…`);
      await visitProfiles(allProfiles, {
        platform: 'Reddit',
        onProgress: (done, total) => sendProgress(40 + Math.round((done / total) * 55), 95, `Visiting profile ${done}/${total}…`),
        shouldCancel: () => cancelled,
      });

      sendProgress(100, 100, `Done — visited ${allProfiles.length} profiles`);
      sendComplete(allProfiles.length);
    } catch (err) {
      sendError(err && err.message || String(err));
    }
  }

  async function expandAllComments(depth) {
    for (let d = 0; d < depth && !cancelled; d++) {
      const clicked = await clickButtonsMatching(
        (t) => t.includes('continue thread') ||
               t.includes('load more comments') ||
               t.includes('view more comments') ||
               t.includes('show more comments') ||
               t.includes('more replies'),
        { interval: 500, max: 12 },
      );
      if (!clicked) break;
    }

    // Lazy-load the rest by scrolling the page in chunks.
    for (let i = 0; i < 12 && !cancelled; i++) {
      const prev = document.documentElement.scrollHeight;
      window.scrollBy(0, 1500);
      await sleep(500);
      if (document.documentElement.scrollHeight <= prev) break;
    }
    // Return to top so the popup can still see the post.
    window.scrollTo(0, 0);
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

  async function collectUpvoterProfiles(max) {
    const found = [];
    const seen = new Set();

    const upvoteCount = document.querySelector(
      'button[aria-label*="upvote"] + span, [id^="vote-arrows"]',
    );
    if (upvoteCount && isVisible(upvoteCount)) {
      clickElement(upvoteCount);
      await sleep(500);
    }

    collectFromElements(
      document.querySelectorAll('a[href*="/user/"], a[href*="/u/"]'),
      found, seen, 'liker',
    );

    return found.slice(0, max);
  }

  async function collectCommenterProfiles(max) {
    const found = [];
    const seen = new Set();

    const commentEls = document.querySelectorAll(
      '[data-testid="comment"], shreddit-comment, .Comment, .comment',
    );
    for (const c of commentEls) {
      collectFromElements(
        c.querySelectorAll('a[href*="/user/"], a[href*="/u/"]'),
        found, seen, 'commenter',
      );
      if (found.length >= max) break;
    }

    if (found.length < max) {
      collectFromElements(
        document.querySelectorAll('aside a[href*="/user/"], aside a[href*="/u/"]'),
        found, seen, 'commenter',
      );
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
      const userIdx = parts.indexOf('user');
      const uIdx = parts.indexOf('u');
      const idx = userIdx !== -1 ? userIdx : uIdx;
      if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
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
