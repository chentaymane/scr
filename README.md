# scr — Social Privacy & Contact Extraction Toolkit

A two-tool setup for **personal privacy auditing** of social media accounts:

| Tool | What it does | Where it runs |
| --- | --- | --- |
| `privacy_exposure_check.py` | Tests your **own staging/test** site for privacy leaks: given a post URL, it visits every liker and commenter profile and reports whether email/phone fields leak in violation of that user's expected privacy setting. Value-blind — never logs the actual value. | Python + Playwright on your machine |
| `extension/` | A **Manifest V3 Chrome extension** that, on the live web (Facebook, Instagram, Twitter/X, Pinterest, Quora, TikTok, Reddit, LinkedIn), opens the likes and comments of a post you're viewing, recursively expands reply threads, **visits each interactor's profile in parallel**, deep-extracts emails, phones, bio, website, link-in-bio, and social handles, **follows link-in-bio aggregators one level deep** to find the real contact info, and streams everything into the popup. | Inside your browser |

Both tools are written for **legitimate personal privacy auditing only** — for example, checking whether *your own* profiles leak contact info you didn't intend to expose, or auditing your own app's privacy enforcement on staging. Do not point either tool at accounts or systems you do not own or are not explicitly authorised to test.

---

## 1. `extension/` — Social Contact Extractor

### What it does

1. You open any **post** on a supported platform in Chrome.
2. You click the extension icon → **Start Scan**.
3. The content script auto-clicks the likes/reactions count to open the reactors modal.
4. It recursively clicks "View more comments" and "View N more replies" to expand nested reply threads.
5. The collected list of liker + commenter profile URLs is sent to the **service worker**.
6. The service worker opens profiles **in parallel** (default 4 at a time, configurable 1–8) in background tabs.
7. For each profile, it deep-extracts:
   - All visible email addresses (text + `mailto:` links + meta tags + JSON-LD)
   - All visible phone numbers (text + `tel:` links, with noise filtering)
   - The user's **bio / about text**
   - The user's **website** (first external link in the bio, excluding the platform itself)
   - The user's **link-in-bio** aggregator URL (linktr.ee, about.me, beacons, etc.)
   - **Social handles on other platforms** (Instagram, Twitter/X, TikTok, YouTube, LinkedIn, GitHub, Telegram, Discord, WhatsApp, Snapchat, Twitch, Threads, Bluesky)
8. If a link-in-bio aggregator is found, the service worker **follows it** (one level deep) and adds any contact info found there to the same user record.
9. Results stream into the popup, grouped by **Likers** / **Commenters** / **Other**, each card showing all collected data. Click **▾ More details** on a card to see the full bio, website, link-in-bio, and social handles.
10. **Export to CSV** (now includes all the new fields) when done.

### What's new in v1.1

| Before | After |
| --- | --- |
| Visited profiles **one at a time** | **Parallel pool** (1–8, default 4) — a 200-comment post goes from ~30 min to ~7 min |
| Only extracted `body.innerText` | Extracts from body + meta tags + JSON-LD + mailto: + tel: + bio containers + og:description + twitter:description |
| No bio, website, or social handles | Each card now shows bio, website, link-in-bio, and handles for IG, X, TikTok, YT, LinkedIn, GitHub, Telegram, Discord, WhatsApp, Snapchat, Twitch, Threads, Bluesky |
| Missed real contact info behind Linktree / about.me | **Follows link-in-bio one level deep** and merges the findings into the same user |
| Progress bar broken (field name mismatch) | Fixed — progress bar tracks actual visit count |
| Everything ended up in "Other" group (source tag was dropped) | Fixed — Likers / Commenters / Other grouping works |
| Phone regex picked up dates, post IDs, large numbers | Stricter regex with noise filtering (min 7 digits, no all-same-digit, no year fragments, no 13+ digit IDs without +) |
| Email regex picked up noreply@ and platform domains | Noise filter drops system addresses |
| Cancel did not actually abort in-flight visits | Cancel sets a flag the service worker checks after each step |
| Service worker could be killed mid-batch, losing progress | Persisted to `chrome.storage.session` + `chrome.alarms` keep-alive + popup re-syncs on reopen |

### Supported platforms

| Platform | What gets opened | Profile URL shape |
| --- | --- | --- |
| Facebook | reactions overlay, "view more comments", "view more replies" | `/user/…`, `/people/…`, `/profile.php?id=…` |
| Instagram | likers modal, "view all N replies", "load more comments" | `/<username>` |
| Twitter / X | retweets/likes modal, "show more replies" | `/<username>` |
| Pinterest | likers modal, "view replies" | `/user/<username>` |
| Quora | "Continue reading", upvoters panel, comment list | `/profile/<name>` |
| TikTok | comments panel, "view replies" | `/@<username>` |
| Reddit | "continue thread", "load more comments", sidebar | `/user/<username>`, `/u/<username>` |
| LinkedIn | reactions modal, "N replies" | `/in/<username>` |

### Install

1. Open Chrome and visit `chrome://extensions/`.
2. Toggle **Developer mode** (top right) on.
3. Click **Load unpacked**.
4. Select the `extension/` folder.
5. Pin the extension to your toolbar.
6. Open any post on a supported platform and click the icon → **Start Scan**.

### Settings (persisted across sessions)

| Setting | Default | Meaning |
| --- | --- | --- |
| Max likers | 100 | Cap on unique likers collected |
| Max comments | 200 | Cap on unique commenters collected |
| Reply depth | 5 | How many rounds of "view more replies" to click |
| Parallel | 4 | How many profile tabs to keep open at once (1–8) |
| Follow link-in-bio | on | If a profile's bio points to a Linktree / about.me / etc., open that page too and merge findings |
| Capture bio / website / socials | on | Whether to extract the extras (bio, website, other-platform handles) |

### Files

```
extension/
├── manifest.json              # MV3 manifest + link-in-bio host permissions
├── background.js              # service worker — concurrent visits, deep extraction, link-in-bio follow
├── popup.html                 # popup UI
├── popup.js                   # UI controller
├── icons/                     # toolbar icons
└── platforms/
    ├── utils.js               # shared helpers (PII patterns, click/scroll, messaging, source-tag preservation)
    ├── facebook.js
    ├── instagram.js
    ├── twitter.js
    ├── pinterest.js
    ├── quora.js
    ├── tiktok.js
    ├── reddit.js
    └── linkedin.js
```

### Safety notes

- The extension **only reads the DOM of pages you're on** (the post page and the profile tabs it opens). It does not call any private/internal API. It does not make HTTP requests to the platform.
- It does not store anything outside the popup's `chrome.storage.local` (last session's results) and `chrome.storage.session` (in-flight visit state, cleared when the browser session ends).
- It uses `mailto:` / `tel:` hrefs only for click-to-contact in the popup, not for exfiltration.
- Manifest V3 is honoured: no `background` page, no remote code. `host_permissions` are explicit per supported platform + per link-in-bio aggregator.
- The popup is sandboxed; exported CSVs are saved by your browser, not uploaded anywhere.
- Cancelling a scan sets an abort flag the service worker checks at every step; in-flight tabs are closed as soon as the current step returns.

### When the DOM changes

These sites rotate CSS-in-JS class names regularly, so the platform scripts match on stable signals (semantic attributes, `aria-label`, `role`, `href` patterns). If a platform redesigns and the matcher starts missing, edit the relevant file in `platforms/` — each platform is isolated and uses the shared `SCE` helper namespace from `utils.js`.

The deep extractor in `background.js` (the function that runs inside each profile tab) is **platform-agnostic** — it does not rely on any specific CSS class, just on the rendered text and the anchor tags. If a platform redesigns, the only piece that needs updating is the content script that finds and clicks the "view more replies" / "show likers" buttons.

---

## 2. `privacy_exposure_check.py` — Staging privacy-enforcement tester

A Playwright-based tool for **staging / test environments only**. It logs in as a low-privilege test account, visits a fixed list of URLs, and reports where a user's email/phone leaks into the DOM or network responses in violation of that user's expected privacy setting.

- ✅ Visits **only** the URLs listed in `config.json` → `targets`, in order.
- 🚫 Never follows links found on a page. No crawling to profiles, posts, or likers discovered along the way. 10 targets → exactly 10 page loads.
- 🚫 Refuses to run against known production domains (built-in guard).
- 🔒 Never logs, prints, or writes an actual email/phone value. Findings carry only a boolean plus which field/endpoint was involved.

### Install

```bash
pip install playwright
playwright install chromium
```

### Configure

Copy `config.example.json` to `config.json` and edit it. Key fields:

- `base_url` — staging host. Must contain a marker like `staging`/`test`/`dev`/`qa`/`localhost`, or be listed in `allow_hosts`, **and** must not match any production pattern, or the tool aborts.
- `test_login` — the low-privilege read-only test account.
- `targets[]` — `{ "url", "type": "post"|"profile", "expected_privacy" }`.
- Expected-privacy mapping for shown users (choose one or both):
  - `users` — `{ "<username>": { "expected_privacy": "private"|"public" } }`.
  - `admin_privacy_endpoint` — a **test-only** endpoint returning
    `{"username": "...", "privacy": "private"}` (queried only if set).
- `selectors` / `login_selectors` — CSS selectors tuned to your site's markup.

### Run

```bash
# Simplest: give it one post URL. It walks the likes + comments and visits
# each interactor's profile to check email/phone privacy enforcement.
python3 privacy_exposure_check.py https://staging.mysite.com/post/test001

# A /path works too (base_url from config is prepended):
python3 privacy_exposure_check.py /post/test001

# Just list who interacted, without visiting their profiles:
python3 privacy_exposure_check.py /post/test001 --list-only

# Cap how many discovered profiles get visited:
python3 privacy_exposure_check.py /post/test001 --max-users 50

# Preview the plan — makes NO requests:
python3 privacy_exposure_check.py /post/test001 --dry-run

# Use the config.json 'targets' list instead of a single URL:
python3 privacy_exposure_check.py --targets-file

# Live run (headless), writes privacy_report.csv and privacy_report.json:
python3 privacy_exposure_check.py --config config.json --out privacy_report

# Watch it in a visible browser:
python3 privacy_exposure_check.py --config config.json --headed
```

### Reusing a session you're already logged into (no credentials)

```bash
# Persistent profile: log in yourself once in the visible window, then continue.
python3 privacy_exposure_check.py /post/test001 \
    --user-data-dir ./.pw-profile --manual-login

# Later runs reuse that profile with no login step:
python3 privacy_exposure_check.py /post/test001 --user-data-dir ./.pw-profile

# Or reuse cookies exported from an already-logged-in session:
python3 privacy_exposure_check.py /post/test001 --storage-state ./session.json
```

### Report columns

`target_url, user_shown, field_checked, expected_visibility, actually_exposed, severity, source, endpoint`

| Severity | Meaning |
| --- | --- |
| `high` | contact field shown despite a **private** setting — the bug you care about |
| `medium` | exposed but expected privacy unknown |
| `info` | exposed and expected visible (working as intended) |
| `ok` | not exposed |

### Safety notes

- Do not remove or weaken the production-domain guard (`assert_not_production`). Add your real production hostnames to `BUILTIN_PROD_PATTERNS` in the script.
- Rate limiting is clamped to 1–2 s between page loads.
- Use only against systems you own or are explicitly authorised to test.

---

## Repository layout

```
scr/
├── README.md                  ← this file
├── privacy_exposure_check.py  ← staging privacy-enforcement tester
├── config.example.json        ← example config for the python tool
├── config.json                ← local config (gitignored in real use)
├── privacy_report.csv         ← sample output
├── privacy_report.json        ← sample output
└── extension/                 ← the browser extension
    ├── manifest.json
    ├── background.js
    ├── popup.html
    ├── popup.js
    ├── icons/
    └── platforms/
        ├── utils.js
        ├── facebook.js
        ├── instagram.js
        ├── twitter.js
        ├── pinterest.js
        ├── quora.js
        ├── tiktok.js
        ├── reddit.js
        └── linkedin.js
```

## License & responsibility

These tools are provided as-is for personal, authorised privacy auditing only.
You are responsible for complying with the Terms of Service of any platform
you point them at, and with applicable law (CFAA, GDPR, computer-misuse
statutes, etc.). Scraping or contacting users who did not consent to be
contacted may violate both.
