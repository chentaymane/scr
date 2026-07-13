// platforms/facebook.js — Facebook post interactor extractor
// Works on: facebook.com
//
// Strategy:
//   1. Click the likes/reactions count to open the reactors overlay
//   2. Click "View more comments" and "View X more replies" recursively
//   3. Walk the rendered DOM and collect profile links from the reactions
//      overlay, the comment threads, and any related-reactions panel
//
// Facebook is heavy on the page and rotates CSS-in-JS class names, so we lean
// on stable anchors (aria-label, role, data-testid, href patterns) rather
// than .x1i10hfl-style opaque classes.

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
      runFacebookScan(msg.maxLikers, msg.maxComments, msg.maxNestDepth);
    } else if (msg.type === 'cancelScan') {
      cancelled = true;
    }
  });

  // ─── Main flow ─────────────────────────────────────────────────────────────

  async function runFacebookScan(maxLikers, maxComments, maxNestDepth) {
    try {
      sendProgress(0, 100, 'Initialising Facebook scan…');

      await openReactionsOverlay();
      await openAllComments(maxNestDepth);

      sendProgress(20, 100, 'Collecting profile URLs…');
      const likerProfiles = await collectLikerProfiles(maxLikers);
      const commenterProfiles = await collectCommenterProfiles(maxComments);
      const allProfiles = [...likerProfiles, ...commenterProfiles];

      sendProgress(40, 100, `Sending ${allProfiles.length} profiles for visiting…`);
      requestProfileVisits(allProfiles, 'Facebook');

      sendProgress(100, 100, `Collected ${allProfiles.length} profiles — visiting in background`);
      sendCollectionDone(allProfiles.length);
    } catch (err) {
      sendError(err && err.message || String(err));
    }
  }

  // ─── Open the reactions / likes overlay ───────────────────────────────────

  async function openReactionsOverlay() {
    // The post footer usually renders a span/div with the reactor count
    // (e.g. "1.2K"). Clicking it pops up a dialog with the reactors list.
    const candidates = [
      'div[role="button"][aria-label*="reaction"]',
      'span[aria-label*="reaction"]',
      'a[href*="/ufi/reaction"]',
      'span[data-testid="like_text"]',
      'a[href*="/reactions/"]',
    ];

    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) {
        clickElement(el);
        await sleep(1500);
        break;
      }
    }

    // Scroll whatever overlay appeared.
    const dialog = document.querySelector('[role="dialog"]');
    if (dialog) await scrollUntilStable(dialog, { maxScrolls: 8, interval: 400 });
  }

  // ─── Open all comments (recursive) ────────────────────────────────────────

  async function openAllComments(depth) {
    for (let d = 0; d < depth && !cancelled; d++) {
      const viewMoreClicked = await clickButtonsMatching(
        (t) => t.includes('view') && t.includes('comment') && !t.includes('hide'),
        { interval: 700, max: 12 },
      );
      const repliesClicked = await clickButtonsMatching(
        (t) => (t.includes('view') || t.includes('see') || t.includes('show')) &&
               (t.includes('repl') || t.includes('reply')) &&
               !t.includes('hide') && !t.includes('cancel'),
        { interval: 500, max: 20 },
      );
      if (!viewMoreClicked && !repliesClicked) break;
    }
  }

  // Walks every visible button/span/anchor and clicks the first one whose
  // visible text matches `predicate`. Returns true if at least one click
  // happened. Stops once the matcher stops finding matches.
  async function clickButtonsMatching(predicate, { interval = 500, max = 10 } = {}) {
    let clickedAny = false;
    for (let i = 0; i < max && !cancelled; i++) {
      const candidates = document.querySelectorAll('div[role="button"], span[role="button"], a[role="button"]');
      let picked = null;
      for (const c of candidates) {
        if (!isVisible(c)) continue;
        const txt = (c.innerText || '').toLowerCase().trim();
        if (txt && predicate(txt)) { picked = c; break; }
      }
      if (!picked) return clickedAny;
      clickElement(picked);
      clickedAny = true;
      await sleep(interval);
    }
    return clickedAny;
  }

  // ─── Collect reactor (liker) profile URLs ─────────────────────────────────

  async function collectLikerProfiles(max) {
    const found = [];
    const seen = new Set();

    const dialog = document.querySelector('[role="dialog"]');
    if (dialog) {
      const links = dialog.querySelectorAll('a[href*="/user/"], a[href*="/people/"], a[href*="/profile.php"]');
      collectFromElements(links, found, seen, 'liker');
    }

    const inline = document.querySelectorAll('[data-testid="fb-ufi-likelist"] a, #reaction_profile_browser a');
    collectFromElements(inline, found, seen, 'liker');

    return found.slice(0, max);
  }

  // ─── Collect commenter profile URLs ──────────────────────────────────────

  async function collectCommenterProfiles(max) {
    const found = [];
    const seen = new Set();

    const commentContainers = document.querySelectorAll(
      '[data-testid="comment"], [aria-label*="Comment"] > div, [data-pagelet*="Comment"]',
    );
    for (const c of commentContainers) {
      const links = c.querySelectorAll('a[href*="/"]');
      collectFromElements(links, found, seen, 'commenter');
      if (found.length >= max) break;
    }

    if (found.length < max) {
      const areas = document.querySelectorAll('[data-pagelet*="Comment"], [data-testid="UFI2CommentPreviewBody"]');
      for (const area of areas) {
        collectFromElements(area.querySelectorAll('a[href*="/"]'), found, seen, 'commenter');
        if (found.length >= max) break;
      }
    }

    return found.slice(0, max);
  }

  // ─── Collect profile info from link elements ─────────────────────────────

  function collectFromElements(elements, found, seen, source) {
    for (const el of elements) {
      const href = el.getAttribute('href');
      if (!href) continue;

      const fullUrl = safeAbsoluteUrl(href);
      if (!fullUrl) continue;
      if (!isSameHost(fullUrl)) continue;
      if (seen.has(fullUrl)) continue;
      seen.add(fullUrl);

      const username = getUsernameFromEl(el) || extractUsernameFromUrl(fullUrl);
      const name = getNameFromEl(el);

      found.push({
        name: name || username || 'Unknown',
        username,
        profileUrl: normalizeProfileUrl(fullUrl),
        source,
      });
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent !== null) return true;
    // Fall back to getBoundingClientRect.
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

  function normalizeProfileUrl(url) {
    try { const u = new URL(url); u.search = ''; u.hash = ''; return u.href; } catch { return url; }
  }

  function getUsernameFromEl(el) {
    // Prefer inner span text.
    const inner = el.querySelector('span');
    if (inner) {
      const txt = (inner.innerText || '').trim();
      const atMatch = txt.match(/@([A-Za-z0-9._]+)/);
      if (atMatch) return atMatch[1];
      const first = txt.split(/\s/)[0];
      if (first && /^[A-Za-z0-9._]{2,30}$/.test(first)) return first;
    }
    // Fall back to href pattern.
    const href = el.getAttribute('href') || '';
    const m = href.match(/\/(?:profile|user|people)\/([^/?&]+)/);
    if (m) return decodeURIComponent(m[1]);
    return null;
  }

  function getNameFromEl(el) {
    const span = el.querySelector('span');
    if (!span) return null;
    const txt = (span.innerText || '').trim().split('\n')[0];
    if (!txt || txt.length > 60 || txt.includes('@')) return null;
    return txt;
  }

  function extractUsernameFromUrl(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      const last = parts[parts.length - 1];
      if (!last) return null;
      if (last === 'profile' || last === 'people' || last.includes('.php')) return null;
      return decodeURIComponent(last);
    } catch { return null; }
  }
})();
