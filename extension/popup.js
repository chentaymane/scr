// popup.js — UI controller for the Social Contact Extractor
//
// State machine:
//   idle    → user clicks Start Scan → collecting → visiting → idle | error
//   running → user clicks Cancel    → idle
//
// Key fixes from the previous version:
//   • Progress field name mismatch (`msg.done` vs `msg.current`) is gone —
//     we now read the same field the background writes.
//   • Contact source tag (`liker` / `commenter` / `other`) is preserved
//     through the background all the way to the popup, so grouping works.
//   • We also display bio, website, link-in-bio, and detected social handles,
//     and let the user expand a card for the full picture.

const PLATFORM_SCRIPTS = {
  'facebook.com': ['platforms/utils.js', 'platforms/facebook.js'],
  'instagram.com': ['platforms/utils.js', 'platforms/instagram.js'],
  'twitter.com':  ['platforms/utils.js', 'platforms/twitter.js'],
  'x.com':        ['platforms/utils.js', 'platforms/twitter.js'],
  'pinterest.com':['platforms/utils.js', 'platforms/pinterest.js'],
  'quora.com':    ['platforms/utils.js', 'platforms/quora.js'],
  'tiktok.com':   ['platforms/utils.js', 'platforms/tiktok.js'],
  'reddit.com':   ['platforms/utils.js', 'platforms/reddit.js'],
  'linkedin.com': ['platforms/utils.js', 'platforms/linkedin.js'],
};

const PLATFORM_DISPLAY = {
  'facebook.com': 'Facebook',
  'instagram.com': 'Instagram',
  'pinterest.com': 'Pinterest',
  'quora.com': 'Quora',
  'twitter.com': 'Twitter',
  'x.com': 'X',
  'tiktok.com': 'TikTok',
  'reddit.com': 'Reddit',
  'linkedin.com': 'LinkedIn',
};

let currentTabId = null;
let state = {
  users: [],
  loading: false,
  error: null,
  visited: 0,
  total: 0,
};

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    currentTabId = tab.id;
    detectPlatform(tab.url);
  }

  await loadSettings();
  await loadStoredResults();

  document.getElementById('btn-scan').addEventListener('click', onScanClick);
  document.getElementById('btn-export').addEventListener('click', exportResults);
  document.getElementById('btn-clear').addEventListener('click', clearResults);

  document.getElementById('max-likers').addEventListener('change', saveSettings);
  document.getElementById('max-comments').addEventListener('change', saveSettings);
  document.getElementById('max-depth').addEventListener('change', saveSettings);
  document.getElementById('max-parallel').addEventListener('change', saveSettings);
  document.getElementById('opt-follow-bio').addEventListener('change', saveSettings);
  document.getElementById('opt-extract-bio').addEventListener('change', saveSettings);

  chrome.runtime.onMessage.addListener(handleMessage);

  // If the service worker is mid-batch when we open, ask for its state
  // so the popup reflects reality instead of starting at 0.
  try { chrome.runtime.sendMessage({ type: 'getVisitState' }); } catch { /* ignore */ }
});

// ─── Message handling ───────────────────────────────────────────────────────

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'scanStarted':
      state.total = msg.total || 0;
      state.visited = 0;
      updateProgress(0, state.total, `Visiting ${state.total} profiles…`);
      setStatus('running', `Visiting ${state.total} profiles (${msg.parallel || 4} parallel)…`);
      break;

    case 'scanProgress': {
      // Background sends { current, total, detail } — matches what the popup reads.
      const done = typeof msg.current === 'number' ? msg.current : (msg.done || 0);
      const total = msg.total || state.total || 100;
      state.visited = done;
      state.total = total;
      updateProgress(done, total, msg.detail);
      break;
    }

    case 'scanResult':
      handleNewUser(msg.user || msg.data);
      break;

    case 'collectionDone':
      // Content script finished collecting profile URLs
      setStatus('running', `Collected ${msg.total} profiles — visiting profiles…`);
      break;

    case 'visitState':
      // Service worker restored its state — sync the popup
      if (msg.state) {
        state.users = msg.state.results || [];
        state.visited = msg.state.cursor || 0;
        state.total = msg.state.profiles ? msg.state.profiles.length : 0;
        renderResults();
        updateSummary();
        if (state.total > 0) {
          setStatus('running', `Resumed — ${state.visited}/${state.total} visited`);
          setLoading(true);
          updateProgress(state.visited, state.total);
        }
      }
      break;

    case 'scanComplete':
      finishScan(msg.total || state.users.length, msg.aborted);
      break;

    case 'scanError':
      setError(msg.message || 'Unknown error');
      break;
  }
}

// ─── Platform detection ──────────────────────────────────────────────────────

function detectPlatform(url) {
  const el = document.getElementById('site-info');
  if (!url) { el.textContent = 'No active tab'; return; }
  let hostname;
  try { hostname = new URL(url).hostname.replace(/^www\./, ''); }
  catch { el.textContent = 'Not a valid URL'; return; }
  let matched = null;
  for (const [domain, name] of Object.entries(PLATFORM_DISPLAY)) {
    if (hostname === domain || hostname.endsWith('.' + domain)) { matched = name; break; }
  }
  el.textContent = matched ? `Platform: ${matched}` : 'Unknown platform';
}

function getHostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function getScriptsForUrl(url) {
  const host = getHostname(url);
  if (!host) return null;
  for (const [domain, scripts] of Object.entries(PLATFORM_SCRIPTS)) {
    if (host === domain || host.endsWith('.' + domain)) return scripts;
  }
  return null;
}

// ─── Settings persistence ────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.local.get([
    'maxLikers', 'maxComments', 'maxNestDepth', 'maxParallel',
    'followLinkInBio', 'extractBio',
  ]);
  if (stored.maxLikers)    document.getElementById('max-likers').value   = stored.maxLikers;
  if (stored.maxComments)  document.getElementById('max-comments').value = stored.maxComments;
  if (stored.maxNestDepth) document.getElementById('max-depth').value    = stored.maxNestDepth;
  if (stored.maxParallel)  document.getElementById('max-parallel').value  = stored.maxParallel;
  if (typeof stored.followLinkInBio === 'boolean')
    document.getElementById('opt-follow-bio').checked = stored.followLinkInBio;
  if (typeof stored.extractBio === 'boolean')
    document.getElementById('opt-extract-bio').checked = stored.extractBio;
}

async function saveSettings() {
  const maxLikers    = clampInt(document.getElementById('max-likers').value,   1, 1000, 100);
  const maxComments  = clampInt(document.getElementById('max-comments').value, 1, 2000, 200);
  const maxNestDepth = clampInt(document.getElementById('max-depth').value,    1,   20,   5);
  const maxParallel  = clampInt(document.getElementById('max-parallel').value, 1,    8,   4);
  document.getElementById('max-likers').value   = maxLikers;
  document.getElementById('max-comments').value = maxComments;
  document.getElementById('max-depth').value    = maxNestDepth;
  document.getElementById('max-parallel').value = maxParallel;
  const followLinkInBio = document.getElementById('opt-follow-bio').checked;
  const extractBio = document.getElementById('opt-extract-bio').checked;
  await chrome.storage.local.set({ maxLikers, maxComments, maxNestDepth, maxParallel, followLinkInBio, extractBio });
  // Push the parallel value to in-flight content scripts via a global stash
  // (the content scripts read __sceParallel before each visit request).
  try { globalThis.__sceParallel = maxParallel; } catch { /* ignore */ }
}

function clampInt(v, lo, hi, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// ─── Scan control ─────────────────────────────────────────────────────────────

async function onScanClick() {
  if (state.loading) {
    try { chrome.tabs.sendMessage(currentTabId, { type: 'cancelScan' }); } catch { /* ignore */ }
    try { chrome.runtime.sendMessage({ type: 'cancelVisit' }); } catch { /* ignore */ }
    setLoading(false);
    setStatus('ready', 'Cancelled');
    return;
  }

  if (!currentTabId) {
    setError('No active tab found');
    return;
  }

  await saveSettings();

  state = { users: [], loading: true, error: null, visited: 0, total: 0 };
  renderResults();
  setStatus('running', 'Scanning…');
  setLoading(true);
  updateProgress(0, 100, 'Starting…');
  updateSummary();

  const maxLikers    = clampInt(document.getElementById('max-likers').value,   1, 1000, 100);
  const maxComments  = clampInt(document.getElementById('max-comments').value, 1, 2000, 200);
  const maxNestDepth = clampInt(document.getElementById('max-depth').value,    1,   20,   5);
  const maxParallel  = clampInt(document.getElementById('max-parallel').value, 1,    8,   4);

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch { /* ignore */ }
  if (!tab || !tab.url) {
    setError('Cannot read the current tab');
    setLoading(false);
    return;
  }

  const scripts = getScriptsForUrl(tab.url);
  if (!scripts) {
    setError('Not a supported platform. Open a post on Facebook, Instagram, X, TikTok, Reddit, LinkedIn, Pinterest, or Quora.');
    setLoading(false);
    return;
  }

  // Force-inject content scripts so the extension works even if the page
  // was opened before the extension was installed.
  try {
    for (const jsFile of scripts) {
      await chrome.scripting.executeScript({ target: { tabId: currentTabId }, files: [jsFile] });
    }
  } catch (err) {
    setError('Cannot inject scripts into this page. Make sure you are on a supported platform.');
    setLoading(false);
    return;
  }

  // Small delay to let the injected scripts register their listeners
  await new Promise(r => setTimeout(r, 200));

  try {
    await chrome.tabs.sendMessage(currentTabId, {
      type: 'startScan',
      maxLikers, maxComments, maxNestDepth, maxParallel,
    });
  } catch (err) {
    setError('Content script failed to start. Reload the page and try again.');
    setLoading(false);
  }
}

function handleNewUser(user) {
  if (!user || !user.profileUrl) return;
  if (state.users.some(u => u.profileUrl === user.profileUrl)) return;
  state.users.push(user);
  renderResults();
  updateSummary();
}

function finishScan(total, aborted) {
  state.loading = false;
  setLoading(false);
  const word = aborted ? 'cancelled' : 'complete';
  setStatus(aborted ? 'ready' : 'done', `Scan ${word} — found ${state.users.length} contact${state.users.length === 1 ? '' : 's'}`);
  updateProgress(state.total || total, state.total || total, aborted ? 'Cancelled' : 'Done');
  renderResults();
  updateSummary();
  persistResults();
  document.getElementById('btn-export').disabled = state.users.length === 0;
}

function setError(message) {
  state.loading = false;
  state.error = message;
  setLoading(false);
  setStatus('error', `Error: ${message}`);
}

// ─── Persistence ─────────────────────────────────────────────────────────────

async function persistResults() {
  await chrome.storage.local.set({ lastResults: { users: state.users, error: null } });
}

async function loadStoredResults() {
  const stored = await chrome.storage.local.get(['lastResults']);
  if (stored.lastResults && Array.isArray(stored.lastResults.users) && stored.lastResults.users.length > 0) {
    state.users = stored.lastResults.users;
    renderResults();
    updateSummary();
    setStatus('done', `Loaded ${state.users.length} contact(s) from last session`);
    document.getElementById('btn-export').disabled = false;
  }
}

async function clearResults() {
  state = { users: [], loading: false, error: null, visited: 0, total: 0 };
  renderResults();
  updateSummary();
  setStatus('ready', 'Results cleared');
  document.getElementById('btn-export').disabled = true;
  await chrome.storage.local.remove(['lastResults']);
}

// ─── Export ──────────────────────────────────────────────────────────────────

function exportResults() {
  if (state.users.length === 0) return;
  const csv = buildCSV();
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `contacts_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildCSV() {
  const headers = [
    'Name', 'Username', 'Source', 'Email (primary)', 'Phone (primary)',
    'All Emails', 'All Phones', 'Website', 'Link in Bio',
    'Instagram', 'Twitter', 'TikTok', 'YouTube', 'LinkedIn', 'GitHub', 'Telegram', 'Discord', 'WhatsApp', 'Snapchat', 'Twitch', 'Threads', 'Bluesky',
    'Bio', 'Profile URL', 'Platform', 'Link-in-bio followed',
  ];
  const escape = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
  const rows = state.users.map(u => [
    u.name, u.username, u.source, u.email, u.phone,
    (u.allEmails || []).join('; '),
    (u.allPhones || []).join('; '),
    u.website, u.linkInBio,
    u.socials && u.socials.instagram,
    u.socials && u.socials.twitter,
    u.socials && u.socials.tiktok,
    u.socials && u.socials.youtube,
    u.socials && u.socials.linkedin,
    u.socials && u.socials.github,
    u.socials && u.socials.telegram,
    u.socials && u.socials.discord,
    u.socials && u.socials.whatsapp,
    u.socials && u.socials.snapchat,
    u.socials && u.socials.twitch,
    u.socials && u.socials.threads,
    u.socials && u.socials.bluesky,
    u.bio,
    u.profileUrl, u.platform, u.followedLinkInBio,
  ].map(escape).join(','));
  return [headers.map(escape).join(','), ...rows].join('\n');
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function updateSummary() {
  const bar = document.getElementById('summary-bar');
  if (state.users.length === 0 && state.visited === 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  document.getElementById('sum-visited').textContent = state.visited || 0;
  document.getElementById('sum-contacts').textContent = state.users.length;
  let emailCount = 0, phoneCount = 0;
  for (const u of state.users) {
    emailCount += (u.allEmails || (u.email ? [u.email] : [])).length;
    phoneCount += (u.allPhones || (u.phone ? [u.phone] : [])).length;
  }
  document.getElementById('sum-emails').textContent = emailCount;
  document.getElementById('sum-phones').textContent = phoneCount;
}

function renderResults() {
  const container = document.getElementById('results-container');
  if (state.users.length === 0) {
    container.innerHTML = state.loading
      ? `<div class="empty-state"><p>Scanning for contacts…</p></div>`
      : `<div class="empty-state">
           <p>No results yet.</p>
           <p>Navigate to a post on any supported platform, then click Start Scan.</p>
         </div>`;
    return;
  }

  const likers     = state.users.filter(u => u.source === 'liker');
  const commenters = state.users.filter(u => u.source === 'commenter');
  const others     = state.users.filter(u => u.source !== 'liker' && u.source !== 'commenter');

  const sections = [];
  if (likers.length)     sections.push(renderSection('Likers',     likers));
  if (commenters.length) sections.push(renderSection('Commenters', commenters));
  if (others.length)     sections.push(renderSection('Other',      others));

  container.innerHTML = sections.join('');
}

function renderSection(title, users) {
  const header = `<div class="section-header">
    <span>${escapeHtml(title)}</span>
    <span class="section-count">${users.length}</span>
  </div>`;
  return header + users.map(renderCard).join('');
}

function renderCard(u) {
  const platformClass = `platform-${(u.platform || 'unknown').toLowerCase()}`;
  const platformLabel = u.platform || '?';
  const name = escapeHtml(u.name || u.username || 'Unknown');
  const username = u.username ? `<span class="at">@${escapeHtml(u.username)}</span>` : '';
  const sourceTag = u.source && u.source !== 'other'
    ? `<span class="contact-source">${escapeHtml(u.source)}</span>`
    : '';
  const followFlag = u.followedLinkInBio
    ? `<span class="follow-flag" title="Visited their link-in-bio aggregator too">↳ bio expanded</span>`
    : '';

  // Primary contact links
  const links = [];
  const allEmails = u.allEmails && u.allEmails.length ? u.allEmails : (u.email ? [u.email] : []);
  const allPhones = u.allPhones && u.allPhones.length ? u.allPhones : (u.phone ? [u.phone] : []);
  for (const e of allEmails) {
    links.push(`<a class="contact-link email" href="mailto:${encodeURIComponent(e)}">${escapeHtml(e)}</a>`);
  }
  for (const p of allPhones) {
    links.push(`<a class="contact-link phone" href="tel:${encodeURIComponent(p)}">${escapeHtml(p)}</a>`);
  }
  if (u.profileUrl) {
    links.push(`<a class="contact-link profile" href="${escapeHtml(u.profileUrl)}" target="_blank" rel="noopener noreferrer">Profile</a>`);
  }

  // Extras (collapsed by default) — bio, website, link-in-bio, socials
  const extras = [];
  if (u.bio) {
    extras.push(`<div class="extras-section">
      <div class="extras-section-title">Bio</div>
      <div class="bio-text">${escapeHtml(u.bio)}</div>
    </div>`);
  }

  const sideLinks = [];
  if (u.website) {
    sideLinks.push(`<a class="contact-link website" href="${escapeHtml(u.website)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortenUrl(u.website))}</a>`);
  }
  if (u.linkInBio) {
    sideLinks.push(`<a class="contact-link linkinbio" href="${escapeHtml(u.linkInBio)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortenUrl(u.linkInBio))}</a>`);
  }
  if (u.socials) {
    const SOC = [
      ['instagram', 'IG', 'instagram.com/'],
      ['twitter',   'X',  /(twitter|x)\.com\//],
      ['tiktok',    'TT', 'tiktok.com/@'],
      ['youtube',   'YT', 'youtube.com/'],
      ['linkedin',  'in', 'linkedin.com/in/'],
      ['github',    'GH', 'github.com/'],
      ['telegram',  'TG', 't.me/'],
      ['discord',   'DC', 'discord.gg/'],
      ['whatsapp',  'WA', 'wa.me/'],
      ['snapchat',  'SC', 'snapchat.com/add/'],
      ['twitch',    'TV', 'twitch.tv/'],
      ['threads',   '@',  'threads.net/@'],
      ['bluesky',   'BS', 'bsky.app/'],
    ];
    for (const [key, tag, _] of SOC) {
      if (u.socials[key]) {
        sideLinks.push(`<span class="contact-link social" title="${escapeHtml(key)}">${escapeHtml(tag)} ${escapeHtml(u.socials[key])}</span>`);
      }
    }
  }
  if (sideLinks.length) {
    extras.push(`<div class="extras-section">
      <div class="extras-section-title">Links</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">${sideLinks.join('')}</div>
    </div>`);
  }

  const hasExtras = extras.length > 0;
  const extrasBlock = hasExtras
    ? `<button class="expand-btn" data-action="toggle">▾ More details</button>
       <div class="contact-extras">${extras.join('')}</div>`
    : '';

  return `<div class="contact-card ${platformClass}" data-card>
    <div class="contact-row">
      <span class="contact-name">${name}</span>
      ${username}
      <span class="platform-badge">${escapeHtml(platformLabel)}</span>
      ${sourceTag}
      ${followFlag}
    </div>
    <div class="contact-links">${links.join('')}</div>
    ${extrasBlock}
  </div>`;
}

// Delegate clicks on expand buttons
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-action="toggle"]');
  if (!btn) return;
  const card = btn.closest('[data-card]');
  if (!card) return;
  card.classList.toggle('expanded');
  btn.textContent = card.classList.contains('expanded') ? '▴ Less' : '▾ More details';
});

// ─── UI helpers ──────────────────────────────────────────────────────────────

function setStatus(type, text) {
  document.getElementById('status-dot').className = `status-dot ${type}`;
  document.getElementById('status-text').textContent = text;
}

function updateProgress(done, total, label) {
  const bar = document.getElementById('progress-bar');
  const fill = document.getElementById('progress-fill');
  bar.style.display = 'block';
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (label) setStatus('running', label);
}

function setLoading(loading) {
  state.loading = loading;
  const btn = document.getElementById('btn-scan');
  const txt = document.getElementById('btn-scan-text');
  if (loading) {
    txt.innerHTML = '<span class="spinner"></span>Cancel';
  } else {
    txt.textContent = 'Start Scan';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

function shortenUrl(u) {
  try {
    const url = new URL(u);
    const path = url.pathname.length > 1 ? url.pathname : '';
    return url.hostname.replace(/^www\./, '') + path;
  } catch { return u; }
}
