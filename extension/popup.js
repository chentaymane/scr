// popup.js — UI controller for the Social Contact Extractor
//
// State machine:
//   idle    → user clicks Start Scan → running → idle | error
//   running → user clicks Cancel    → idle
// Results are persisted to chrome.storage so closing the popup doesn't lose
// them. Settings persist across sessions.

const PLATFORM_NAMES = {
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
let state = { users: [], loading: false, error: null };

// ─── Init ────────────────────────────────────────────────────────────────────

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

  chrome.runtime.onMessage.addListener(handleMessage);
});

// ─── Message handling ───────────────────────────────────────────────────────

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'platformDetected':
      // Content scripts identify themselves; this is informational only.
      break;
    case 'scanProgress':
      updateProgress(msg.done, msg.total, msg.label);
      break;
    case 'scanResult':
      handleNewUser(msg.data);
      break;
    case 'scanComplete':
      finishScan(msg.total || state.users.length);
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
  for (const [domain, name] of Object.entries(PLATFORM_NAMES)) {
    if (hostname === domain || hostname.endsWith('.' + domain)) { matched = name; break; }
  }
  el.textContent = matched ? `Platform: ${matched}` : 'Unknown platform';
}

// ─── Settings persistence ────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.local.get(['maxLikers', 'maxComments', 'maxNestDepth']);
  if (stored.maxLikers)   document.getElementById('max-likers').value   = stored.maxLikers;
  if (stored.maxComments) document.getElementById('max-comments').value = stored.maxComments;
  if (stored.maxNestDepth) document.getElementById('max-depth').value    = stored.maxNestDepth;
}

async function saveSettings() {
  const maxLikers   = clampInt(document.getElementById('max-likers').value,   1, 1000, 100);
  const maxComments = clampInt(document.getElementById('max-comments').value, 1, 2000, 200);
  const maxNestDepth = clampInt(document.getElementById('max-depth').value,   1,   20,   5);
  document.getElementById('max-likers').value   = maxLikers;
  document.getElementById('max-comments').value = maxComments;
  document.getElementById('max-depth').value    = maxNestDepth;
  await chrome.storage.local.set({ maxLikers, maxComments, maxNestDepth });
}

function clampInt(v, lo, hi, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// ─── Scan control ─────────────────────────────────────────────────────────────

async function onScanClick() {
  if (state.loading) {
    // Cancel in-flight scan
    try { chrome.tabs.sendMessage(currentTabId, { type: 'cancelScan' }); } catch { /* ignore */ }
    setLoading(false);
    setStatus('ready', 'Cancelled');
    return;
  }

  if (!currentTabId) {
    setError('No active tab found');
    return;
  }

  await saveSettings();

  state = { users: [], loading: true, error: null };
  renderResults();
  setStatus('running', 'Scanning…');
  setLoading(true);
  updateProgress(0, 100, 'Starting…');

  const maxLikers    = clampInt(document.getElementById('max-likers').value,   1, 1000, 100);
  const maxComments  = clampInt(document.getElementById('max-comments').value, 1, 2000, 200);
  const maxNestDepth = clampInt(document.getElementById('max-depth').value,    1,   20,   5);

  try {
    await chrome.tabs.sendMessage(currentTabId, {
      type: 'startScan',
      maxLikers, maxComments, maxNestDepth,
    });
  } catch (err) {
    setError('Could not reach the page. Make sure you\'re on a supported platform and reload it.');
    setLoading(false);
  }
}

function handleNewUser(user) {
  if (!user || !user.profileUrl) return;
  if (state.users.some(u => u.profileUrl === user.profileUrl)) return;
  state.users.push(user);
  renderResults();
}

function finishScan(total) {
  state.loading = false;
  setLoading(false);
  setStatus('done', `Scan complete — found ${state.users.length} contact${state.users.length === 1 ? '' : 's'}`);
  updateProgress(100, 100, 'Done');
  renderResults();
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
    setStatus('done', `Loaded ${state.users.length} contact(s) from last session`);
    document.getElementById('btn-export').disabled = false;
  }
}

async function clearResults() {
  state = { users: [], loading: false, error: null };
  renderResults();
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
  const headers = ['Name', 'Username', 'Email', 'Phone', 'Profile URL', 'Platform', 'Source'];
  const escape = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
  const rows = state.users.map(u => [
    u.name, u.username, u.email, u.phone, u.profileUrl, u.platform, u.source,
  ].map(escape).join(','));
  return [headers.map(escape).join(','), ...rows].join('\n');
}

// ─── Rendering ───────────────────────────────────────────────────────────────

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

  const links = [];
  if (u.email)     links.push(`<a class="contact-link email" href="mailto:${encodeURIComponent(u.email)}">${escapeHtml(u.email)}</a>`);
  if (u.phone)     links.push(`<a class="contact-link phone" href="tel:${encodeURIComponent(u.phone)}">${escapeHtml(u.phone)}</a>`);
  if (u.profileUrl) links.push(`<a class="contact-link profile" href="${escapeHtml(u.profileUrl)}" target="_blank" rel="noopener noreferrer">Profile</a>`);

  return `<div class="contact-card ${platformClass}">
    <div class="contact-name">
      <span>${name}</span>
      ${username}
      <span class="platform-badge">${escapeHtml(platformLabel)}</span>
    </div>
    <div class="contact-links">${links.join('')}</div>
  </div>`;
}

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
  fill.style.width = `${pct}%`;
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
