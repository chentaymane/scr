// background.js — Chrome Extension Service Worker (Manifest V3)
// Orchestrates profile visiting: opens real tabs, extracts contacts from rendered pages.

const RELAY_TYPES = new Set([
  'platformDetected',
  'scanProgress',
  'scanResult',
  'scanComplete',
  'scanError',
]);

let activeVisit = null; // { abort: bool }

function safeSend(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  } catch (e) { /* ignore */ }
}

// ─── Contact extraction function injected into profile tabs ──────────────────
function extractContactsFromPage() {
  const text = (document.body ? document.body.innerText : '') || '';
  const html = (document.body ? document.body.innerHTML : '') || '';

  // Email
  const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
  const rawEmails = text.match(EMAIL_RE) || [];
  const emails = [...new Set(rawEmails.map(e => e.toLowerCase()))];

  // Phone — digits with optional + prefix, 7+ digits, optional separators
  const PHONE_RE = /(?<!\d)((?:\+?\d{1,3}[\s\-]?)?\(?\d{2,4}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{3,4})(?!\d)/g;
  const rawPhones = text.match(PHONE_RE) || [];
  const phones = [...new Set(rawPhones.map(p => p.replace(/\s+/g, ' ').trim()))];

  // mailto: links
  for (const a of document.querySelectorAll('a[href^="mailto:"]')) {
    const href = (a.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
    if (href && !emails.includes(href.toLowerCase())) emails.push(href.toLowerCase());
  }

  // tel: links
  for (const a of document.querySelectorAll('a[href^="tel:"]')) {
    const href = (a.getAttribute('href') || '').replace(/^tel:/i, '').trim();
    if (href && !phones.includes(href)) phones.push(href);
  }

  // Meta description / about section (some platforms put contact info there)
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) {
    const content = metaDesc.getAttribute('content') || '';
    const mEmails = content.match(EMAIL_RE) || [];
    for (const e of mEmails) {
      const lower = e.toLowerCase();
      if (!emails.includes(lower)) emails.push(lower);
    }
    const mPhones = content.match(PHONE_RE) || [];
    for (const p of mPhones) {
      const cleaned = p.replace(/\s+/g, ' ').trim();
      if (!phones.includes(cleaned)) phones.push(cleaned);
    }
  }

  // JSON-LD structured data
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const s of scripts) {
    try {
      const data = JSON.parse(s.textContent);
      const json = JSON.stringify(data);
      const jEmails = json.match(EMAIL_RE) || [];
      for (const e of jEmails) {
        const lower = e.toLowerCase();
        if (!emails.includes(lower)) emails.push(lower);
      }
    } catch { /* ignore parse errors */ }
  }

  return { emails, phones };
}

// ─── Visit a single profile tab ──────────────────────────────────────────────
async function visitProfile(profileUrl, visitId) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: profileUrl, active: false });
  } catch (e) {
    return null;
  }

  // Wait for tab to finish loading (max 15 seconds)
  await new Promise((resolve) => {
    let resolved = false;
    const listener = (tabId, changeInfo) => {
      if (tabId === tab.id && changeInfo.status === 'complete' && !resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, 15000);
  });

  // Extra wait for SPA content to render
  await new Promise(r => setTimeout(r, 2000));

  let result = null;
  try {
    const [execResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractContactsFromPage,
    });
    if (execResult && execResult.result) {
      result = execResult.result;
    }
  } catch (e) {
    // Script injection failed (e.g. chrome:// page)
  }

  // Close the tab
  try {
    await chrome.tabs.remove(tab.id);
  } catch { /* ignore */ }

  return result;
}

// ─── Batch visit profiles ────────────────────────────────────────────────────
async function visitProfilesBatch(profiles, senderTabId) {
  const total = profiles.length;
  let visited = 0;
  const results = [];

  for (const profile of profiles) {
    if (activeVisit && activeVisit.abort) break;

    visited++;
    safeSend({
      type: 'scanProgress',
      percent: Math.round((visited / total) * 100),
      current: visited,
      total,
      detail: `Visiting ${profile.username || profile.profileUrl}…`,
    });

    const contacts = await visitProfile(profile.profileUrl, profile.id);

    if (contacts && (contacts.emails.length > 0 || contacts.phones.length > 0)) {
      const user = {
        name: profile.name || profile.username || '',
        username: profile.username || '',
        platform: profile.platform || '',
        profileUrl: profile.profileUrl,
        email: contacts.emails[0] || null,
        phone: contacts.phones[0] || null,
        allEmails: contacts.emails,
        allPhones: contacts.phones,
      };
      results.push(user);
      safeSend({ type: 'scanResult', user });
    }
  }

  safeSend({ type: 'scanComplete', users: results });
  activeVisit = null;

  // Notify the content script that visits are done
  try {
    chrome.tabs.sendMessage(senderTabId, { type: 'visitDone' });
  } catch { /* ignore */ }
}

// ─── Message handler ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  // Relay messages from content scripts to popup
  if (RELAY_TYPES.has(msg.type)) {
    safeSend(msg);
    return true;
  }

  // Content script sends profile URLs to visit
  if (msg.type === 'visitProfiles' && msg.profiles) {
    const senderTabId = sender.tab ? sender.tab.id : null;
    if (!senderTabId) return true;

    // Cancel any previous visit
    if (activeVisit) activeVisit.abort = true;
    activeVisit = { abort: false };

    visitProfilesBatch(msg.profiles, senderTabId);
    return true;
  }

  // Cancel visit
  if (msg.type === 'cancelVisit') {
    if (activeVisit) activeVisit.abort = true;
    activeVisit = null;
    return true;
  }

  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Social Contact Extractor] Installed — for personal privacy auditing only');
});
