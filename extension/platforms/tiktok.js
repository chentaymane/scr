// platforms/tiktok.js — TikTok post interactor extractor
// Works on: tiktok.com
//
// Strategy:
//   1. Open the comments panel and the likers modal
//   2. Recursively expand reply threads
//   3. Walk the page for profile links (format: /@username)
//
// TikTok profile URLs look like:  https://www.tiktok.com/@username

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
      runTiktokScan(msg.maxLikers, msg.maxComments, msg.maxNestDepth);
    } else if (msg.type === 'cancelScan') {
      cancelled = true;
    }
  });

  async function runTiktokScan(maxLikers, maxComments, maxNestDepth) {
    try {
      sendProgress(0, 100, 'Initialising TikTok scan…');

      await openComments();
      await expandReplies(maxNestDepth);

      sendProgress(20, 100, 'Collecting profile URLs…');
      const likerProfiles = await collectLikerProfiles(maxLikers);
      const commenterProfiles = await collectCommenterProfiles(maxComments);
      const allProfiles = [...likerProfiles, ...commenterProfiles];

      sendProgress(40, 100, `Visiting ${allProfiles.length} profiles…`);
      await visitProfiles(allProfiles, {
        platform: 'TikTok',
        onProgress: (done, total) => sendProgress(40 + Math.round((done / total) * 55), 95, `Visiting profile ${done}/${total}…`),
        shouldCancel: () => cancelled,
      });

      sendProgress(100, 100, `Done — visited ${allProfiles.length} profiles`);
      sendComplete(allProfiles.length);
    } catch (err) {
      sendError(err && err.message || String(err));
    }
  }

  async function openComments() {
    // Click the comment icon to open the comment panel.
    const commentTrigger = document.querySelector(
      '[data-e2e="comment-icon"], [data-e2e="browse-comment"], [data-e2e="comment"]',
    );
    if (commentTrigger && isVisible(commentTrigger)) {
      clickElement(commentTrigger);
      await sleep(1500);
    }

    // Scroll whatever comment list is visible.
    const list = document.querySelector('[data-e2e="comment-list"], [class*="CommentListContainer"]');
    if (list) await scrollUntilStable(list, { maxScrolls: 10, interval: 400 });
  }

  async function expandReplies(depth) {
    for (let d = 0; d < depth && !cancelled; d++) {
      const clicked = await clickButtonsMatching(
        (t) => (t.includes('view') || t.includes('see') || t.includes('show')) &&
               t.includes('repl'),
        { interval: 500, max: 10 },
      );
      if (!clicked) break;
    }
  }

  async function clickButtonsMatching(predicate, { interval = 500, max = 10 } = {}) {
    let clickedAny = false;
    for (let i = 0; i < max && !cancelled; i++) {
      const nodes = document.querySelectorAll('p, span, div[role="button"]');
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

    collectFromElements(
      document.querySelectorAll('a[href*="/@"]'),
      found, seen, 'liker',
    );

    return found.slice(0, max);
  }

  async function collectCommenterProfiles(max) {
    const found = [];
    const seen = new Set();

    const list = document.querySelector('[data-e2e="comment-list"], [class*="CommentListContainer"]');
    if (list) await scrollUntilStable(list, { maxScrolls: 10, interval: 400 });

    const commentContainers = document.querySelectorAll(
      '[data-e2e="comment-item"], [class*="CommentItem"]',
    );
    for (const c of commentContainers) {
      collectFromElements(c.querySelectorAll('a[href*="/@"]'), found, seen, 'commenter');
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
    if (!href) return null;
    const parts = href.split('/@');
    if (parts.length < 2) return null;
    const tail = parts[1].split('?')[0].split('#')[0];
    const first = tail.split('/')[0];
    return first || null;
  }

  function extractDisplayName(el) {
    const span = el.querySelector('span, p, h3, h4');
    if (!span) return null;
    const txt = (span.innerText || '').trim().split('\n')[0];
    if (!txt || txt.length > 60) return null;
    return txt;
  }
})();
