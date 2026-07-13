// background.js — Chrome Extension Service Worker (Manifest V3)
// Routes messages between popup and content scripts. Errors are swallowed so
// transient "receiving end does not exist" errors don't spam the console.

const RELAY_TYPES = new Set([
  'platformDetected',
  'scanProgress',
  'scanResult',
  'scanComplete',
  'scanError',
]);

function safeSend(msg) {
  // chrome.runtime.sendMessage throws if there is no receiver (popup closed).
  // Wrap with a callback so the runtime can deliver lastError normally.
  try {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  } catch (e) {
    // ignore
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (RELAY_TYPES.has(msg.type)) {
    safeSend(msg);
  }
  // Return true to keep the channel open for any async response (none today).
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Social Contact Extractor] Installed — for personal privacy auditing only');
});
