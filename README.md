# privacy_exposure_check.py

**Staging / test environments and test accounts only.** An authorized,
defensive tester for privacy-setting enforcement bugs on your own social media
site: it logs in as a low-privilege test account, visits a fixed list of URLs,
and reports where a user's **email/phone** leaks into the DOM or network
responses in violation of that user's expected privacy setting.

## What it does / does not do

- ✅ Visits **only** the URLs listed in `config.json` → `targets`, in order.
- 🚫 Never follows links found on a page. No crawling to profiles, posts, or
  likers discovered along the way. 10 targets → exactly 10 page loads.
- 🚫 Refuses to run against known production domains (built-in guard).
- 🔒 Never logs, prints, or writes an actual email/phone value. Findings carry
  only a boolean plus which field/endpoint was involved.

## Install

```bash
pip install playwright
playwright install chromium
```

## Configure

Copy `config.example.json` to `config.json` and edit it. Key fields:

- `base_url` — staging host. Must contain a marker like `staging`/`test`/`dev`/
  `qa`/`localhost`, or be listed in `allow_hosts`, **and** must not match any
  production pattern, or the tool aborts.
- `test_login` — the low-privilege read-only test account.
- `targets[]` — `{ "url", "type": "post"|"profile", "expected_privacy" }`.
- Expected-privacy mapping for shown users (choose one or both):
  - `users` — `{ "<username>": { "expected_privacy": "private"|"public" } }`.
  - `admin_privacy_endpoint` — a **test-only** endpoint returning
    `{"username": "...", "privacy": "private"}` (queried only if set).
- `selectors` / `login_selectors` — CSS selectors tuned to your site's markup.
  The defaults are generic guesses; adjust them so user cards, usernames, and
  the likes/comments toggles are found.

## Run

```bash
# Simplest: just give it one post URL. It discovers everyone who interacted with
# that post, walks into each profile, and checks email/phone privacy enforcement.
# Output is value-blind (which field/endpoint leaked, not the value itself).
python3 privacy_exposure_check.py https://staging.mysite.com/post/test001

# A /path works too (base_url from config is prepended):
python3 privacy_exposure_check.py /post/test001

# No URL? It prompts you for one:
python3 privacy_exposure_check.py

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

## Reusing a session you're already logged into (no credentials)

Instead of scripting a login with a stored test password, you can reuse a
browser session where you're already signed in. No password is stored anywhere.

```bash
# Persistent profile: log in yourself once in the visible window, then continue.
# The session is saved in ./.pw-profile and reused on later runs — even headless.
python3 privacy_exposure_check.py /post/test001 \
    --user-data-dir ./.pw-profile --manual-login

# Later runs reuse that profile with no login step:
python3 privacy_exposure_check.py /post/test001 --user-data-dir ./.pw-profile

# Or reuse cookies exported from an already-logged-in session (Playwright
# storage_state JSON):
python3 privacy_exposure_check.py /post/test001 --storage-state ./session.json
```

You can also set these under a `session` block in `config.json`
(`{"session": {"user_data_dir": "./.pw-profile"}}`); CLI flags win over config.
The production-domain guard still applies — this only changes how you
authenticate, not where the tool is allowed to run.

## Report columns

`target_url, user_shown, field_checked, expected_visibility, actually_exposed,
severity, source, endpoint`

Severity: `high` = contact field shown despite a **private** setting (the bug
you care about); `medium` = exposed but expected privacy unknown; `info` =
exposed and expected visible (working as intended); `ok` = not exposed.

## Safety notes

- Do not remove or weaken the production-domain guard (`assert_not_production`).
  Add your real production hostnames to `BUILTIN_PROD_PATTERNS` in the script.
- Rate limiting is clamped to 1–2 s between page loads.
- Use only against systems you own or are explicitly authorized to test.
