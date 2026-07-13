// platforms/twitter.js — Twitter / X post interactor extractor
// Works on: twitter.com, x.com
//
// Strategy:
//   1. Click the retweets/likes counts to pop up the people modal
//   2. Recursively click "Show more replies" in the conversation thread
//   3. Walk the modal + thread for User-Name anchors

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
      runTwitterScan(msg.maxLikers, msg.maxComments, msg.maxNestDepth);
    } else if (msg.type === 'cancelScan') {
      cancelled = true;
    }
  });

  async function runTwitterScan(maxLikers, maxComments, maxNestDepth) {
    try {
      sendProgress(0, 100, 'Initialising Twitter/X scan…');

      await openReactionsModal();

      sendProgress(20, 100, 'Collecting profile URLs…');
      const likerProfiles = await collectLikerProfiles(maxLikers);
      const commenterProfiles = await collectCommenterProfiles(maxComments, maxNestDepth);
      const allProfiles = [...likerProfiles, ...commenterProfiles];

      sendProgress(40, 100, `Sending ${allProfiles.length} profiles for visiting…`);
      requestProfileVisits(allProfiles, 'Twitter');

      sendProgress(100, 100, `Collected ${allProfiles.length} profiles — visiting in background`);
      sendCollectionDone(allProfiles.length);
    } catch (err) {
      sendError(err && err.message || String(err));
    }
  }

  async function openReactionsModal() {
    // The retweet count and the like count are both <a> elements that open
    // a modal listing users who did that reaction.
    const candidates = [
      'a[href*="/retweets"]',
      'a[href*="/likes"]',
      'a[href*="/retweeters"]',
      'a[href*="/likers"]',
    ];

    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) {
        clickElement(el);
        await sleep(1500);
        break;
      }
    }

    const modal = document.querySelector('[role="dialog"]') ||
                  document.querySelector('[data-testid="mask"]');
    if (modal) await scrollUntilStable(modal, { maxScrolls: 10, interval: 400 });
  }

  async function expandConversationReplies(depth) {
    for (let d = 0; d < depth && !cancelled; d++) {
      const clicked = await clickButtonsMatching(
        (t) => (t.includes('show') || t.includes('more') || t.includes('see')) &&
               t.includes('repl'),
        { interval: 500, max: 10 },
      );
      if (!clicked) break;
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

  async function collectLikerProfiles(max) {
    const found = [];
    const seen = new Set();

    const modal = document.querySelector('[role="dialog"]') ||
                  document.querySelector('[data-testid="mask"]');
    if (modal) {
      collectFromElements(
        modal.querySelectorAll('[data-testid="User-Name"] a[href^="/"], a[href^="/"]'),
        found, seen, 'liker',
      );
    }

    if (found.length < max) {
      collectFromElements(
        document.querySelectorAll('[data-testid="User-Name"] a[href^="/"]'),
        found, seen, 'liker',
      );
    }

    return found.slice(0, max);
  }

  async function collectCommenterProfiles(max, depth) {
    const found = [];
    const seen = new Set();

    await expandConversationReplies(depth);

    const items = document.querySelectorAll('article');
    for (const item of items) {
      const links = item.querySelectorAll('[data-testid="User-Name"] a[href^="/"], a[href^="/"]');
      collectFromElements(links, found, seen, 'commenter');
      if (found.length >= max) break;
    }

    return found.slice(0, max);
  }

  function collectFromElements(elements, found, seen, source) {
    for (const el of elements) {
      const href = el.getAttribute('href');
      if (!href || !href.startsWith('/')) continue;

      const fullUrl = window.location.origin + href.split('?')[0].split('#')[0];
      if (seen.has(fullUrl)) continue;
      seen.add(fullUrl);

      const username = href.replace(/^\/+/, '').split('/')[0] || null;
      // Skip non-profile paths
      if (!username || ['search', 'explore', 'notifications', 'messages', 'settings', 'home', 'compose'].includes(username)) continue;

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

  function extractDisplayName(el) {
    const span = el.querySelector('span');
    if (!span) return null;
    const txt = (span.innerText || '').trim().split('\n')[0];
    if (!txt || txt.length > 60) return null;
    return txt;
  }
})();
