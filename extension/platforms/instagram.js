// platforms/instagram.js — Instagram post interactor extractor
// Works on: instagram.com
//
// Strategy:
//   1. Open the likers modal (click the likes link under the post)
//   2. Open the comments panel; recursively click "View all N replies"
//   3. Walk the likers modal and the comment thread for profile links
//
// Instagram renders most of the UI in a single React tree, so we mostly
// match anchors whose href starts with "/".

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
      runInstagramScan(msg.maxLikers, msg.maxComments, msg.maxNestDepth);
    } else if (msg.type === 'cancelScan') {
      cancelled = true;
    }
  });

  async function runInstagramScan(maxLikers, maxComments, maxNestDepth) {
    try {
      sendProgress(0, 100, 'Initialising Instagram scan…');

      await openLikers();
      await expandAllReplies(maxNestDepth);

      sendProgress(20, 100, 'Collecting profile URLs…');
      const likerProfiles = await collectLikerProfiles(maxLikers);
      const commenterProfiles = await collectCommenterProfiles(maxComments);
      const allProfiles = [...likerProfiles, ...commenterProfiles];

      sendProgress(40, 100, `Sending ${allProfiles.length} profiles for visiting…`);
      requestProfileVisits(allProfiles, 'Instagram');

      sendProgress(100, 100, `Collected ${allProfiles.length} profiles — visiting in background`);
      sendCollectionDone(allProfiles.length);
    } catch (err) {
      sendError(err && err.message || String(err));
    }
  }

  // ─── Open the likers modal ─────────────────────────────────────────────────

  async function openLikers() {
    const candidates = [
      'a[href*="/liked_by/"]',
      'a[href*="/likers/"]',
      'button[aria-label*="Like"]',
      'section a[href*="/"]',
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
    if (modal) await scrollUntilStable(modal, { maxScrolls: 12, interval: 450 });
  }

  // ─── Expand all replies recursively ──────────────────────────────────────

  async function expandAllReplies(depth) {
    for (let d = 0; d < depth && !cancelled; d++) {
      const repliesClicked = await clickButtonsMatching(
        (t) => (t.includes('view') || t.includes('see') || t.includes('show') || t.includes('load')) &&
               t.includes('repl'),
        { interval: 600, max: 15 },
      );
      const moreClicked = await clickButtonsMatching(
        (t) => (t.includes('more') || t.includes('older') || t.includes('previous')) &&
               t.includes('comment'),
        { interval: 600, max: 10 },
      );
      if (!repliesClicked && !moreClicked) break;
    }
  }

  async function clickButtonsMatching(predicate, { interval = 500, max = 10 } = {}) {
    let clickedAny = false;
    for (let i = 0; i < max && !cancelled; i++) {
      const nodes = document.querySelectorAll('div[role="button"], span, a');
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

  // ─── Collect liker profile URLs ──────────────────────────────────────────

  async function collectLikerProfiles(max) {
    const found = [];
    const seen = new Set();

    const modal = document.querySelector('[role="dialog"]');
    if (modal) {
      collectFromElements(modal.querySelectorAll('a[href^="/"]'), found, seen, 'liker');
    }

    if (found.length < max) {
      collectFromElements(document.querySelectorAll('a[href^="/"]'), found, seen, 'liker');
    }

    return found.slice(0, max);
  }

  // ─── Collect commenter profile URLs ──────────────────────────────────────

  async function collectCommenterProfiles(max) {
    const found = [];
    const seen = new Set();

    const commentContainers = document.querySelectorAll(
      'ul li div[role="presentation"], article[role="presentation"] ul li, [data-testid="comment"]',
    );
    for (const c of commentContainers) {
      collectFromElements(c.querySelectorAll('a[href^="/"]'), found, seen, 'commenter');
      if (found.length >= max) break;
    }

    if (found.length < max) {
      collectFromElements(
        document.querySelectorAll('article a[href^="/"]'),
        found, seen, 'commenter',
      );
    }

    return found.slice(0, max);
  }

  // ─── Collect profile info from link elements ─────────────────────────────

  function collectFromElements(elements, found, seen, source) {
    for (const el of elements) {
      const href = el.getAttribute('href');
      if (!href || !href.startsWith('/')) continue;
      // Skip non-profile links (hashtags, explore, liked_by pages, etc.)
      const username = extractUsernameFromPath(href);
      if (!username) continue;

      const fullUrl = 'https://www.instagram.com/' + username + '/';
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

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent !== null) return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function extractUsernameFromPath(path) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    // Skip known non-username path segments
    const skip = new Set(['p', 'reel', 'tv', 'explore', 'stories', 'accounts', 'direct', 'liked_by', 'tags', 'locations']);
    for (const part of parts) {
      if (skip.has(part)) continue;
      // Instagram usernames: alphanumeric, dots, underscores, 1-30 chars
      if (/^[A-Za-z0-9._]{1,30}$/.test(part)) return part;
    }
    return null;
  }

  function extractDisplayName(el) {
    const span = el.querySelector('span');
    if (!span) return null;
    const txt = (span.innerText || '').trim();
    if (!txt || txt.length > 60) return null;
    return txt;
  }
})();
