// background.js — Chrome Extension Service Worker (Manifest V3)
//
// Responsibilities:
//   1. Receive a list of profile URLs from the content script of the active tab.
//   2. Visit each profile in a real background tab (SPAs need to be rendered).
//   3. Deep-extract contacts from each profile: email, phone, bio, website,
//      link-in-bio, social handles on other platforms, allEmails, allPhones.
//   4. Optionally follow one level into link-in-bio aggregators (Linktree,
//      about.me, beacons, etc.) to find the actual contact info behind them.
//   5. Stream results back to the popup, persist progress, support cancel
//      and resume.
//
// Concurrency: we run up to MAX_PARALLEL visits at the same time. The popup
// can configure this. Default is 4 — fast but doesn't slam the platform.

const RELAY_TYPES = new Set([
  'platformDetected',
  'scanProgress',
  'scanResult',
  'collectionDone',
  'scanComplete',
  'scanError',
  'scanStarted',
]);

// Hosts we treat as "link in bio" aggregators. A profile's bio that points
// to one of these is a strong signal the user centralised all their contact
// info there — we'll open it in a follow-up visit to extract the real
// email/phone/handles.
const LINK_IN_BIO_HOST_RE = /(?:^|\.)(linktr\.ee|allmylinks\.com|beacons\.ai|about\.me|carrd\.co|bio\.link|hey\.link|lnk\.bio|taplink\.cc|withkoji\.com|stan\.store|komi\.io|linkpop\.com|shorturl\.com|lnkfi\.re|snipfeed\.co|directme\.link|bento\.me|popl\.co|interact\.me|link\.bio|heyyo\.io|mylink\.page|flowpage\.com|manychat\.com)$/i;

// Hosts we treat as known platforms — exclude them from the "website" and
// "socials" buckets so we don't surface the user's own profile link.
const PLATFORM_HOSTS = new Set([
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com',
  'linkedin.com', 'pinterest.com', 'reddit.com', 'quora.com', 'youtube.com',
  'threads.net', 'bsky.app', 'snapchat.com', 'twitch.tv', 'spotify.com',
  'apple.com', 'music.apple.com',
]);

// Email local-part / domain noise we always discard.
const EMAIL_NOISE_LOCAL = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon',
  'postmaster', 'webmaster', 'admin', 'administrator', 'root', 'abuse',
  'support', 'info', 'press', 'media', 'newsletter', 'team', 'hello',
  'contact', 'feedback', 'help',
]);
const EMAIL_NOISE_DOMAIN = new Set([
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com',
  'linkedin.com', 'pinterest.com', 'reddit.com', 'quora.com', 'youtube.com',
  'google.com', 'gmail.com', 'apple.com', 'microsoft.com', 'outlook.com',
  'w3.org', 'example.com', 'sentry.io', 'cloudflare.com', 'gstatic.com',
  'googleapis.com', 'schema.org', 'github.com', 'githubusercontent.com',
  'wikimedia.org', 'wikipedia.org',
]);

// ─── Persistent state ────────────────────────────────────────────────────────
// Stored in chrome.storage.session so the service worker can die and come
// back without losing the in-flight batch. Survives popup close, dies with
// the browser session.

const STORAGE_KEY = 'activeVisit';

let activeVisit = null; // In-memory mirror of the persisted state.

function loadActive() {
  return new Promise((resolve) => {
    chrome.storage.session.get([STORAGE_KEY], (data) => {
      resolve(data && data[STORAGE_KEY] ? data[STORAGE_KEY] : null);
    });
  });
}

function saveActive(state) {
  return new Promise((resolve) => {
    chrome.storage.session.set({ [STORAGE_KEY]: state }, () => resolve());
  });
}

function clearActive() {
  return new Promise((resolve) => {
    chrome.storage.session.remove([STORAGE_KEY], () => resolve());
  });
}

function safeSend(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  } catch (e) { /* popup closed */ }
}

// ─── Contact extraction (injected into each profile tab) ─────────────────────

// Function form: serialized and run via chrome.scripting.executeScript in
// the target tab's main world. Must be self-contained (no closures over
// background.js scope).

function extractContactsFromPage() {
  const out = {
    emails: [],
    phones: [],
    website: null,
    linkInBio: null,
    socials: {},
    bio: null,
  };

  const text = (document.body ? document.body.innerText : '') || '';

  // ── 1. Emails from text
  const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
  const emailSet = new Set();
  for (const m of (text.match(EMAIL_RE) || [])) emailSet.add(m.toLowerCase());
  out.emails = [...emailSet];

  // ── 2. Emails from mailto: links
  for (const a of document.querySelectorAll('a[href^="mailto:"], a[href^="Mailto:"]')) {
    const raw = (a.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
    if (raw) out.emails.push(raw.toLowerCase());
  }

  // ── 3. Emails from meta tags
  for (const sel of [
    'meta[name="description"]',
    'meta[property="og:description"]',
    'meta[property="og:title"]',
    'meta[name="twitter:description"]',
    'meta[name="keywords"]',
    'meta[itemprop="description"]',
  ]) {
    for (const m of document.querySelectorAll(sel)) {
      const c = m.getAttribute('content') || '';
      for (const e of (c.match(EMAIL_RE) || [])) out.emails.push(e.toLowerCase());
    }
  }

  // ── 4. Emails from JSON-LD
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const json = JSON.stringify(JSON.parse(s.textContent || '{}'));
      for (const e of (json.match(EMAIL_RE) || [])) out.emails.push(e.toLowerCase());
    } catch { /* ignore */ }
  }

  // Dedup + filter
  out.emails = [...new Set(out.emails)].filter((e) => {
    const at = e.indexOf('@');
    if (at < 1) return false;
    const local = e.slice(0, at).toLowerCase();
    const domain = e.slice(at + 1).toLowerCase();
    if (EMAIL_NOISE_LOCAL.has(local)) return false;
    if (EMAIL_NOISE_DOMAIN.has(domain)) return false;
    if (domain.endsWith('.png') || domain.endsWith('.jpg') || domain.endsWith('.gif')) return false;
    // Heuristic: skip emails with two consecutive dots in the local part
    if (local.includes('..')) return false;
    return true;
  });

  // ── 5. Phones from text (with stricter filtering)
  const PHONE_RE = /(?<!\d)(\+?\d[\d\s().\-]{6,18}\d)(?!\d)/g;
  const phoneSet = new Set();
  for (const m of (text.match(PHONE_RE) || [])) {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) continue;
    if (/^(\d)\1+$/.test(digits)) continue; // 0000000
    if (/^(19|20)\d{6,}$/.test(digits)) continue; // looks like a unix-ish id
    if (/^19\d{2}|20\d{2}/.test(digits) && digits.length <= 8) continue; // year fragment
    if (/^\d{1,5}$/.test(digits)) continue; // too short after stripping
    // Skip numeric strings that are just IDs (e.g. 1000001234567890 — 16 digits, no +)
    if (digits.length >= 13 && !m.trim().startsWith('+')) continue;
    const cleaned = m.replace(/\s+/g, ' ').trim();
    phoneSet.add(cleaned);
  }
  out.phones = [...phoneSet];

  // ── 6. Phones from tel: links
  for (const a of document.querySelectorAll('a[href^="tel:"], a[href^="Tel:"]')) {
    const raw = (a.getAttribute('href') || '').replace(/^tel:/i, '').trim();
    if (raw) out.phones.push(raw);
  }
  out.phones = [...new Set(out.phones)];

  // ── 7. Walk anchors for website, link-in-bio, socials
  const anchors = document.querySelectorAll('a[href]');

  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    if (!href || !/^https?:\/\//i.test(href) && !href.startsWith('/')) continue;

    let full;
    try { full = new URL(href, window.location.href).href; } catch { continue; }
    let host;
    try { host = new URL(full).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; }
    if (!host) continue;

    // Link-in-bio aggregator
    if (LINK_IN_BIO_HOST_RE.test(host)) {
      if (!out.linkInBio) out.linkInBio = full;
      continue;
    }

    // Socials on other platforms
    let m;
    if ((m = full.match(/instagram\.com\/([A-Za-z0-9._]{2,30})/i)) && !out.socials.instagram) {
      if (!/(?:^|\/)p\/|reel\/|tv\/|stories\/|explore\//i.test(new URL(full).pathname)) {
        out.socials.instagram = m[1];
      }
    } else if ((m = full.match(/(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})/i)) && !out.socials.twitter) {
      const pathSeg = new URL(full).pathname.split('/').filter(Boolean);
      if (pathSeg[0] && !['i','intent','share','search','home','compose','messages','notifications','settings'].includes(pathSeg[0].toLowerCase())) {
        out.socials.twitter = m[1];
      }
    } else if ((m = full.match(/tiktok\.com\/@?([A-Za-z0-9._]{2,24})/i)) && !out.socials.tiktok) {
      out.socials.tiktok = m[1];
    } else if ((m = full.match(/youtube\.com\/(?:@|channel\/|c\/|user\/)?([A-Za-z0-9._\-]{2,40})/i)) && !out.socials.youtube) {
      if (!['watch','feed','playlist','shorts'].includes((new URL(full).pathname.split('/').filter(Boolean)[0] || '').toLowerCase())) {
        out.socials.youtube = m[1];
      }
    } else if ((m = full.match(/linkedin\.com\/in\/([A-Za-z0-9\-]{3,100})/i)) && !out.socials.linkedin) {
      out.socials.linkedin = m[1];
    } else if ((m = full.match(/github\.com\/([A-Za-z0-9\-]{1,39})/i)) && !out.socials.github) {
      const segs = new URL(full).pathname.split('/').filter(Boolean);
      if (segs.length === 1 && !['about','pricing','features','topics','trending','sponsors'].includes(segs[0].toLowerCase())) {
        out.socials.github = m[1];
      }
    } else if ((m = full.match(/t\.me\/([A-Za-z0-9_]{4,32})/i)) && !out.socials.telegram) {
      out.socials.telegram = m[1];
    } else if ((m = full.match(/(?:wa\.me|whatsapp\.com\/[a-z]+\/)\/?(\d{6,15})/i)) && !out.socials.whatsapp) {
      out.socials.whatsapp = m[1];
    } else if ((m = full.match(/discord\.gg\/([A-Za-z0-9]+)/i)) && !out.socials.discord) {
      out.socials.discord = m[1];
    } else if ((m = full.match(/threads\.net\/@?([A-Za-z0-9._]{2,30})/i)) && !out.socials.threads) {
      out.socials.threads = m[1];
    } else if ((m = full.match(/bsky\.app\/profile\/([A-Za-z0-9._\-]+\.bsky\.social|[A-Za-z0-9._\-]+)/i)) && !out.socials.bluesky) {
      out.socials.bluesky = m[1];
    } else if ((m = full.match(/snapchat\.com\/add\/([A-Za-z0-9._\-]{2,15})/i)) && !out.socials.snapchat) {
      out.socials.snapchat = m[1];
    } else if ((m = full.match(/twitch\.tv\/([A-Za-z0-9_]{2,25})/i)) && !out.socials.twitch) {
      if (!['directory','products','p'].includes((new URL(full).pathname.split('/').filter(Boolean)[0] || '').toLowerCase())) {
        out.socials.twitch = m[1];
      }
    } else if (!out.website) {
      // Anything that is NOT a known platform and NOT a link-in-bio aggregator.
      if (![...PLATFORM_HOSTS].some((h) => host === h || host.endsWith('.' + h))) {
        if (!LINK_IN_BIO_HOST_RE.test(host)) {
          // Anchor text often tells us if this is the "website" or just nav.
          // We grab the first external one — that is almost always the bio link.
          out.website = full;
        }
      }
    }
  }

  // ── 8. Bio — try common selectors, then fall back to meta description
  const BIO_SELECTORS = [
    'meta[property="og:description"]',
    'meta[name="description"]',
    '[data-testid*="bio" i]',
    '[data-testid*="Bio"]',
    'section[aria-label*="Intro" i]',
    'section[aria-label*="About" i]',
    'div[aria-label*="Intro" i]',
    'div[aria-label*="About" i]',
    'div[class*="bio" i]',
    'p[class*="bio" i]',
    '[itemprop="description"]',
  ];
  for (const sel of BIO_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const content = el.getAttribute && el.getAttribute('content');
    const text2 = (content != null ? content : (el.innerText || el.textContent || '')).trim();
    if (text2 && text2.length > 10) { out.bio = text2.slice(0, 500); break; }
  }
  if (!out.bio) {
    // Try the first reasonably long paragraph in the main area
    const main = document.querySelector('main') || document.body;
    if (main) {
      const ps = main.querySelectorAll('p, span, div');
      for (const p of ps) {
        const t = (p.innerText || '').trim();
        if (t.length >= 40 && t.length <= 500 && !t.includes('{') && !t.includes('\n')) {
          out.bio = t.slice(0, 500);
          break;
        }
      }
    }
  }

  return out;
}

// ─── Visit a single profile tab ──────────────────────────────────────────────

async function visitProfile(profile, opts = {}) {
  const { followLinkInBio = true, maxFollowDepth = 1 } = opts;
  if (!profile || !profile.profileUrl) return null;

  const allEmails = new Set();
  const allPhones = new Set();
  let website = null;
  let linkInBio = null;
  let socials = {};
  let bio = null;
  let didFollow = false;

  // 1) Visit the profile itself
  const primary = await openAndExtract(profile.profileUrl);
  if (primary) {
    for (const e of primary.emails || []) allEmails.add(e);
    for (const p of primary.phones || []) allPhones.add(p);
    if (!website && primary.website) website = primary.website;
    if (!linkInBio && primary.linkInBio) linkInBio = primary.linkInBio;
    socials = { ...socials, ...(primary.socials || {}) };
    if (!bio && primary.bio) bio = primary.bio;
  }

  // 2) Follow one level into the link-in-bio aggregator
  if (followLinkInBio && linkInBio && maxFollowDepth > 0) {
    // De-dupe — don't re-visit if the same link is queued by multiple profiles
    const visited = (await loadActive())?.visitedLinks || [];
    if (!visited.includes(linkInBio)) {
      visited.push(linkInBio);
      const cur = await loadActive();
      if (cur) { cur.visitedLinks = visited; await saveActive(cur); }
      didFollow = true;
      const secondary = await openAndExtract(linkInBio);
      if (secondary) {
        for (const e of secondary.emails || []) allEmails.add(e);
        for (const p of secondary.phones || []) allPhones.add(p);
        if (!website && secondary.website) website = secondary.website;
        socials = { ...socials, ...(secondary.socials || {}) };
        if (!bio && secondary.bio) bio = secondary.bio;
      }
    }
  }

  return {
    name: profile.name || profile.username || '',
    username: profile.username || '',
    platform: profile.platform || '',
    profileUrl: profile.profileUrl,
    source: profile.source || 'other',
    email: allEmails.size > 0 ? [...allEmails][0] : null,
    phone: allPhones.size > 0 ? [...allPhones][0] : null,
    allEmails: [...allEmails],
    allPhones: [...allPhones],
    website,
    linkInBio,
    socials,
    bio,
    followedLinkInBio: didFollow,
  };
}

async function openAndExtract(url) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (e) {
    return null;
  }

  try {
    // Wait for the tab to finish loading
    await waitForTabComplete(tab.id, 20000);
    // SPA settle
    await sleep(2500);

    // Scroll the page to load lazy content
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => new Promise((resolve) => {
          let y = 0;
          const step = 600;
          const t = setInterval(() => {
            window.scrollBy(0, step);
            y += step;
            if (y > document.documentElement.scrollHeight + 800) {
              clearInterval(t);
              window.scrollTo(0, 0);
              resolve();
            }
          }, 120);
          setTimeout(() => { clearInterval(t); window.scrollTo(0, 0); resolve(); }, 6000);
        }),
      });
    } catch { /* ignore */ }
    await sleep(800);

    const [exec] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractContactsFromPage,
    });
    return exec && exec.result ? exec.result : null;
  } catch (e) {
    return null;
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch { /* ignore */ }
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const listener = (id, change) => { if (id === tabId && change.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── Concurrent batch runner ─────────────────────────────────────────────────
//
// Pulls one item at a time off the queue, runs up to MAX_PARALLEL visits in
// parallel. The popup can adjust MAX_PARALLEL live.

async function runBatch() {
  const state = await loadActive();
  if (!state) return;
  activeVisit = state;
  let { profiles, cursor, parallel, results, visitedLinks, senderTabId, prefs } = state;
  const followLinkInBio = !prefs || prefs.followLinkInBio !== false;
  const extractBio = !prefs || prefs.extractBio !== false;

  // Normalize: de-dupe profile URLs but preserve order
  const seen = new Set();
  profiles = profiles.filter((p) => {
    const k = (p.profileUrl || '').toLowerCase().replace(/\/+$/, '');
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  state.profiles = profiles;
  await saveActive(state);

  const total = profiles.length;
  const pool = new Set();
  let aborted = false;

  const safeToContinue = async () => {
    const cur = await loadActive();
    return cur && !cur.aborted;
  };

  const runOne = async (profile, idx) => {
    if (await safeToContinue()) {
      safeSend({
        type: 'scanProgress',
        current: idx + 1,
        total,
        detail: `Visiting ${profile.username || profile.name || profile.profileUrl}…`,
      });
    }

    let user = null;
    try {
      user = await visitProfile(profile, {
        followLinkInBio,
        extractBio,
        maxFollowDepth: 1,
      });
    } catch (e) { /* swallow per-profile errors */ }

    // Stream any profile that produced useful data — even if it has only
    // a website or socials, the user might want to know about it. The
    // `email/phone/bio/socials/website` field truthy check decides this.
    const hasUseful = user && (
      (user.allEmails && user.allEmails.length > 0) ||
      (user.allPhones && user.allPhones.length > 0) ||
      (extractBio && (user.bio || user.website || user.linkInBio)) ||
      (user.socials && Object.keys(user.socials).length > 0)
    );
    if (hasUseful) {
      const cur = await loadActive();
      if (cur) {
        cur.results.push(user);
        await saveActive(cur);
      }
      safeSend({ type: 'scanResult', user });
    }
  };

  // Pump loop: keep `parallel` workers busy
  while (cursor < profiles.length && !aborted) {
    if (!(await safeToContinue())) { aborted = true; break; }
    while (pool.size < parallel && cursor < profiles.length) {
      if (!(await safeToContinue())) { aborted = true; break; }
      const profile = profiles[cursor++];
      const idx = cursor - 1;
      const cur = await loadActive();
      if (cur) { cur.cursor = cursor; await saveActive(cur); }
      const p = runOne(profile, idx).finally(() => pool.delete(p));
      pool.add(p);
    }
    if (pool.size > 0) await Promise.race(pool);
  }

  await Promise.allSettled([...pool]);

  const final = await loadActive();
  if (final && !final.aborted) {
    safeSend({ type: 'scanComplete', total: final.results.length, results: final.results });
  } else if (final && final.aborted) {
    safeSend({ type: 'scanComplete', total: final.results.length, results: final.results, aborted: true });
  }

  // Clean up tabs we might still have open (defensive — visitProfile closes
  // its own tabs but a service-worker restart can leave orphans)
  if (senderTabId) {
    try { chrome.tabs.sendMessage(senderTabId, { type: 'visitDone' }); } catch { /* ignore */ }
  }

  activeVisit = null;
  await clearActive();
}

// ─── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (RELAY_TYPES.has(msg.type)) { safeSend(msg); return true; }

  if (msg.type === 'visitProfiles' && Array.isArray(msg.profiles)) {
    const senderTabId = sender.tab ? sender.tab.id : null;
    const parallel = Math.max(1, Math.min(10, msg.parallel || 4));

    // Cancel any previous run, then start fresh
    if (activeVisit) activeVisit.aborted = true;

    // Read user preferences from storage. The popup persists them with
    // every change; the background re-reads at batch start so we don't
    // have to plumb every setting through the message chain.
    const readPrefs = new Promise((resolve) => {
      chrome.storage.local.get(['followLinkInBio', 'extractBio'], (s) => {
        resolve({
          followLinkInBio: s.followLinkInBio !== false,  // default on
          extractBio:      s.extractBio      !== false,  // default on
        });
      });
    });

    readPrefs.then((prefs) => {
      const state = {
        profiles: msg.profiles.slice(),
        cursor: 0,
        parallel,
        results: [],
        visitedLinks: [],
        senderTabId,
        aborted: false,
        prefs,
        startedAt: Date.now(),
      };
      saveActive(state).then(() => {
        safeSend({ type: 'scanStarted', total: state.profiles.length, parallel });
        runBatch();
      });
    });

    return true;
  }

  if (msg.type === 'cancelVisit') {
    if (activeVisit) activeVisit.aborted = true;
    loadActive().then((s) => {
      if (s) { s.aborted = true; return saveActive(s); }
    });
    return true;
  }

  // Ask the service worker to surface its current state to the popup —
  // used when the popup re-opens mid-scan and the worker has lost its
  // in-memory mirror.
  if (msg.type === 'getVisitState') {
    loadActive().then((s) => {
      if (s) safeSend({ type: 'visitState', state: s });
      else safeSend({ type: 'visitState', state: null });
    });
    return true;
  }

  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Social Contact Extractor] Installed — for personal privacy auditing only');
});

// Keep the service worker alive during long batches. chrome.alarms is the
// MV3-sanctioned way to do this.
if (chrome.alarms && chrome.alarms.create) {
  try {
    chrome.alarms.create('keep-alive', { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((a) => {
      if (a.name === 'keep-alive') {
        // Touch state to keep the worker alive
        loadActive().catch(() => {});
      }
    });
  } catch { /* ignore */ }
}
