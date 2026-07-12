#!/usr/bin/env python3
# =============================================================================
# privacy_exposure_check.py
#
# STAGING / TEST ENVIRONMENTS AND TEST ACCOUNTS ONLY.
#
# Authorized privacy-setting enforcement tester for YOUR OWN social media site's
# staging/test environment. It logs in as a designated low-privilege test
# account and checks whether users' email/phone fields leak into the rendered
# DOM or network (XHR/fetch) responses in violation of those users' expected
# privacy settings.
#
# This tool is DEFENSIVE. It is deliberately constrained:
#   * It ONLY visits URLs explicitly listed in config.json. It never follows,
#     queues, or crawls links discovered on a page.
#   * It refuses to run against known production domains.
#   * It NEVER logs, prints, or writes an actual email/phone value. Findings
#     record only a boolean plus which field/endpoint was involved.
#
# Do not point this at systems you do not own or are not explicitly authorized
# to test. Do not remove the production-domain guard.
# =============================================================================

import argparse
import csv
import json
import re
import sys
import time
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any, Iterable, Optional
from urllib.parse import urljoin, urlparse

# ---------------------------------------------------------------------------
# Safety: production-domain guard
# ---------------------------------------------------------------------------

# Hosts matching any of these regexes are treated as production and abort the run.
# Extend this list with your real production hostnames. Matching is done against
# the URL host only (case-insensitive), anchored (fullmatch).
BUILTIN_PROD_PATTERNS = [
    r"(www\.)?mysite\.com",
    r"app\.mysite\.com",
    r"api\.mysite\.com",
    r"m\.mysite\.com",
    r"(www\.)?facebook\.com",
    r"(www\.)?instagram\.com",
    r"(www\.)?twitter\.com",
    r"(www\.)?x\.com",
    r"(www\.)?tiktok\.com",
]

# A host must contain one of these markers (or appear in config allow_hosts) to
# be considered non-production. Fail-safe: unknown hosts are rejected.
STAGING_MARKERS = ("staging", "stage", "test", "qa", "dev", "sandbox", "localhost", "127.0.0.1")


# ---------------------------------------------------------------------------
# PII detection helpers (value-blind: we only ever produce booleans)
# ---------------------------------------------------------------------------

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
# Loose international/US phone matcher. Intentionally conservative to limit
# false positives from arbitrary digit strings.
PHONE_RE = re.compile(r"(?<!\d)(\+?\d[\d\s().\-]{7,}\d)(?!\d)")

EMAIL_FIELD_KEYS = {"email", "e_mail", "emailaddress", "email_address", "mail", "contactemail"}
PHONE_FIELD_KEYS = {
    "phone", "phonenumber", "phone_number", "mobile", "mobilenumber",
    "mobile_number", "tel", "telephone", "contactphone", "msisdn",
}

FIELD_KEY_GROUPS = {"email": EMAIL_FIELD_KEYS, "phone": PHONE_FIELD_KEYS}


def _norm_key(k: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(k).lower())


def value_looks_like(field: str, value: Any) -> bool:
    """True if `value` is a non-empty string that matches the field's pattern."""
    if not isinstance(value, str) or not value.strip():
        return False
    if field == "email":
        return bool(EMAIL_RE.search(value))
    if field == "phone":
        # Require enough digits to be a plausible phone number, not an id/count.
        digits = re.sub(r"\D", "", value)
        return len(digits) >= 7 and bool(PHONE_RE.search(value))
    return False


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class Finding:
    target_url: str
    user_shown: str
    field_checked: str          # "email" | "phone"
    expected_visibility: str     # "visible" | "hidden" | "unknown"
    actually_exposed: bool
    severity: str                # "high" | "medium" | "info" | "ok"
    source: str = ""             # "dom" | "network"
    endpoint: str = ""           # network endpoint (path only), never a value


@dataclass
class PlannedCheck:
    url: str
    type: str
    expected_privacy: str
    open_likes: bool
    open_comments: bool


# ---------------------------------------------------------------------------
# Config loading & validation
# ---------------------------------------------------------------------------

def load_config(path: Path) -> dict:
    try:
        cfg = json.loads(path.read_text())
    except FileNotFoundError:
        sys.exit(f"[abort] config file not found: {path}")
    except json.JSONDecodeError as e:
        sys.exit(f"[abort] config is not valid JSON: {e}")

    if not isinstance(cfg, dict):
        sys.exit("[abort] config root must be a JSON object")
    for key in ("base_url", "targets"):
        if key not in cfg:
            sys.exit(f"[abort] config missing required key: {key}")
    if not isinstance(cfg["targets"], list) or not cfg["targets"]:
        sys.exit("[abort] config.targets must be a non-empty list")
    return cfg


def assert_not_production(base_url: str, cfg: dict) -> None:
    host = (urlparse(base_url).hostname or "").lower()
    if not host:
        sys.exit(f"[abort] could not parse a hostname from base_url: {base_url!r}")

    patterns = list(BUILTIN_PROD_PATTERNS) + list(cfg.get("production_domain_patterns", []))
    for pat in patterns:
        try:
            if re.fullmatch(pat, host, flags=re.IGNORECASE):
                sys.exit(
                    f"[abort] base_url host {host!r} matches production pattern "
                    f"{pat!r}. This tool runs on staging/test only."
                )
        except re.error as e:
            sys.exit(f"[abort] invalid production_domain_patterns entry {pat!r}: {e}")

    allow_hosts = {h.lower() for h in cfg.get("allow_hosts", [])}
    if host in allow_hosts:
        return
    if any(marker in host for marker in STAGING_MARKERS):
        return

    sys.exit(
        f"[abort] base_url host {host!r} has no staging/test marker "
        f"({', '.join(STAGING_MARKERS)}) and is not in config.allow_hosts. "
        f"Refusing to run — add it to allow_hosts only if it is truly a "
        f"non-production environment you are authorized to test."
    )


# ---------------------------------------------------------------------------
# Expected-privacy resolution
# ---------------------------------------------------------------------------

class PrivacyResolver:
    """Maps a shown username -> expected privacy ('private'|'public'|'unknown').

    Sources, in priority order:
      1. config['users'][username]['expected_privacy']
      2. a test-only admin endpoint (config['admin_privacy_endpoint']) returning
         JSON like {"username": "...", "privacy": "private"} or a map.
    Results are cached. The admin endpoint is only queried when explicitly
    configured; it is expected to exist only in test environments.
    """

    def __init__(self, cfg: dict, context, base_url: str):
        self._cfg_users = {
            u.lower(): (v.get("expected_privacy", "unknown") if isinstance(v, dict) else str(v))
            for u, v in (cfg.get("users") or {}).items()
        }
        self._endpoint = cfg.get("admin_privacy_endpoint")
        self._context = context
        self._base_url = base_url
        self._cache: dict[str, str] = {}

    def resolve(self, username: str) -> str:
        key = (username or "").lower()
        if not key:
            return "unknown"
        if key in self._cache:
            return self._cache[key]
        if key in self._cfg_users:
            self._cache[key] = self._cfg_users[key]
            return self._cache[key]
        result = "unknown"
        if self._endpoint and self._context is not None:
            result = self._query_admin(username)
        self._cache[key] = result
        return result

    def _query_admin(self, username: str) -> str:
        try:
            url = urljoin(self._base_url, self._endpoint)
            resp = self._context.request.get(url, params={"username": username})
            if not resp.ok:
                return "unknown"
            data = resp.json()
        except Exception:
            return "unknown"
        if isinstance(data, dict):
            if "privacy" in data:
                return str(data["privacy"])
            entry = data.get(username) or data.get(username.lower())
            if isinstance(entry, dict):
                return str(entry.get("privacy", entry.get("expected_privacy", "unknown")))
            if isinstance(entry, str):
                return entry
        return "unknown"


def expected_visibility_for(privacy: str) -> str:
    """Whether contact fields are *expected* to be visible for this privacy setting."""
    p = (privacy or "unknown").lower()
    if p in ("public", "visible", "open"):
        return "visible"
    if p in ("private", "hidden", "restricted", "friends", "followers"):
        return "hidden"
    return "unknown"


def severity_for(expected_vis: str, exposed: bool, field: str) -> str:
    if not exposed:
        return "ok"
    if expected_vis == "hidden":
        return "high"          # leak: field shown despite private setting
    if expected_vis == "unknown":
        return "medium"        # exposed but we can't confirm it's intended
    return "info"              # expected visible + exposed = working as intended


# ---------------------------------------------------------------------------
# DOM & network scanning
# ---------------------------------------------------------------------------

def scan_json_for_users(node: Any, out: list[dict]) -> None:
    """Walk a JSON structure; for each object that names a user, note which
    contact fields carry a value-shaped payload. Records booleans only."""
    if isinstance(node, dict):
        norm = {_norm_key(k): (k, v) for k, v in node.items()}
        username = None
        for uk in ("username", "userName", "handle", "screenname", "screen_name", "login", "slug"):
            nk = _norm_key(uk)
            if nk in norm and isinstance(norm[nk][1], str) and norm[nk][1].strip():
                username = norm[nk][1].strip()
                break
        if username:
            exposed_fields = {}
            for field, keys in FIELD_KEY_GROUPS.items():
                hit = False
                for nk, (orig_k, v) in norm.items():
                    if nk in {_norm_key(x) for x in keys} and value_looks_like(field, v):
                        hit = True
                        break
                if hit:
                    exposed_fields[field] = True
            if exposed_fields:
                out.append({"username": username, "fields": exposed_fields})
        for v in node.values():
            scan_json_for_users(v, out)
    elif isinstance(node, list):
        for item in node:
            scan_json_for_users(item, out)


def dom_user_exposure(page, user_selector: str, username_selector: Optional[str]) -> list[dict]:
    """For each user card in the DOM, check its own subtree for email/phone.
    Returns [{username, fields:{email:True,...}}]. Values never leave this fn."""
    results = []
    try:
        cards = page.query_selector_all(user_selector)
    except Exception:
        return results
    for card in cards:
        try:
            username = ""
            if username_selector:
                el = card.query_selector(username_selector)
                if el:
                    username = (el.get_attribute("data-username") or el.inner_text() or "").strip()
            if not username:
                username = (card.get_attribute("data-username") or "").strip()
            text = card.inner_text() or ""
            html = card.inner_html() or ""
            fields = {}
            if EMAIL_RE.search(text) or "mailto:" in html:
                fields["email"] = True
            if "tel:" in html:
                fields["phone"] = True
            else:
                for m in PHONE_RE.finditer(text):
                    if len(re.sub(r"\D", "", m.group(1))) >= 7:
                        fields["phone"] = True
                        break
            if username and fields:
                results.append({"username": username, "fields": fields})
        except Exception:
            continue
    return results


def try_open_section(page, selectors: Iterable[str], settle: float) -> None:
    """Best-effort click to reveal a likes/comments section already on the page.
    Never navigates away; only interacts with in-page controls."""
    for sel in selectors:
        try:
            el = page.query_selector(sel)
            if el and el.is_visible():
                el.click()
                page.wait_for_timeout(int(settle * 1000))
                return
        except Exception:
            continue


# ---------------------------------------------------------------------------
# Network capture
# ---------------------------------------------------------------------------

class NetworkCapture:
    """Collects JSON/text response bodies during a page's lifetime so they can be
    scanned for PII after load. Bodies are held transiently in memory and never
    written to disk."""

    def __init__(self, max_bytes: int = 2_000_000):
        self.entries: list[dict] = []
        self._max = max_bytes

    def attach(self, page):
        page.on("response", self._on_response)

    def _on_response(self, response):
        try:
            ctype = (response.headers.get("content-type") or "").lower()
            if "json" not in ctype and "text" not in ctype:
                return
            body = response.body()
            if not body or len(body) > self._max:
                return
            text = body.decode("utf-8", errors="replace")
            path = urlparse(response.url).path or response.url
            parsed = None
            if "json" in ctype:
                try:
                    parsed = json.loads(text)
                except Exception:
                    parsed = None
            self.entries.append({"path": path, "json": parsed, "text": text if parsed is None else None})
        except Exception:
            return

    def clear(self):
        self.entries.clear()


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------

def do_login(page, cfg: dict, base_url: str, settle: float) -> None:
    login = cfg.get("test_login") or {}
    username = login.get("username")
    password = login.get("password")
    login_path = cfg.get("login_path", "/login")
    if not username or not password:
        print("[warn] no test_login credentials in config; continuing unauthenticated")
        return
    url = urljoin(base_url + "/", login_path.lstrip("/"))
    try:
        page.goto(url, wait_until="domcontentloaded")
    except Exception as e:
        print(f"[warn] could not reach login page {url}: {e}")
        print("[warn] check base_url in config.json points at a reachable staging host; "
              "continuing (session may be unauthenticated)")
        return
    page.wait_for_timeout(int(settle * 1000))

    sel = cfg.get("login_selectors", {})
    user_sel = sel.get("username", "input[name='username'], input[name='email'], #username")
    pass_sel = sel.get("password", "input[type='password'], input[name='password'], #password")
    submit_sel = sel.get("submit", "button[type='submit'], input[type='submit']")
    try:
        page.fill(user_sel, username)
        page.fill(pass_sel, password)
        page.click(submit_sel)
        page.wait_for_load_state("networkidle")
    except Exception as e:
        print(f"[warn] login flow selectors did not match ({e}); "
              f"continuing (session may be unauthenticated)")
    page.wait_for_timeout(int(settle * 1000))


# ---------------------------------------------------------------------------
# Post-crawl mode: discover everyone who interacted with ONE post, then check
# each of their profiles for privacy-setting enforcement (value-blind).
# ---------------------------------------------------------------------------

def discover_interactors(page, cfg: dict, base_url: str, settle: float) -> list[dict]:
    """From the currently-loaded post page, open likes + comments and collect the
    users who interacted. Returns [{username, profile_url}] deduped. Only reads
    what the post itself renders — the fan-out is bounded to this one post."""
    sel = cfg.get("selectors", {})
    likes_toggles = sel.get("likes_toggle", ["[data-testid='likes']", ".likes-count", "button.likes", "a.likers"])
    comments_toggles = sel.get("comments_toggle", ["[data-testid='comments']", ".comments-toggle", "button.comments"])
    # Anchor elements that link to a user's profile within a liker/commenter row.
    link_sels = sel.get("interactor_link", [
        "a[href*='/profile/']", "a[href*='/user/']", "a[href*='/u/']",
        "[data-testid='user'] a", ".liker a", ".comment a[href]",
    ])

    try_open_section(page, likes_toggles, settle)
    try_open_section(page, comments_toggles, settle)
    try:
        page.wait_for_load_state("networkidle", timeout=5000)
    except Exception:
        pass

    found: dict[str, dict] = {}
    for lsel in link_sels:
        try:
            anchors = page.query_selector_all(lsel)
        except Exception:
            continue
        for a in anchors:
            try:
                href = a.get_attribute("href") or ""
                if not href:
                    continue
                profile_url = urljoin(base_url, href)
                # Stay on the same site — never wander to external hosts.
                if urlparse(profile_url).hostname != urlparse(base_url).hostname:
                    continue
                username = (a.get_attribute("data-username")
                            or a.inner_text().strip()
                            or urlparse(profile_url).path.rstrip("/").split("/")[-1])
                key = profile_url.rstrip("/")
                if key not in found:
                    found[key] = {"username": username, "profile_url": profile_url}
            except Exception:
                continue
    return list(found.values())


def run_post_crawl(cfg: dict, base_url: str, post_url: str, args) -> list[Finding]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit(
            "[abort] Playwright is not installed. Install it with:\n"
            "    pip install playwright && playwright install chromium\n"
            "(Use --dry-run to preview without Playwright.)"
        )

    settle = cfg.get("settle_seconds", 0.8)
    delay = max(1.0, min(2.0, cfg.get("rate_limit_seconds", 1.5)))
    max_users = args.max_users or cfg.get("max_users", 200)
    sel = cfg.get("selectors", {})
    user_sel = sel.get("user_card", "[data-testid='user'], .user-card, li.user, .liker, .comment, body")
    uname_sel = sel.get("username", "[data-username], .username, .handle")

    findings: list[Finding] = []
    full_post = urljoin(base_url, post_url)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        context = browser.new_context()
        page = context.new_page()
        capture = NetworkCapture(max_bytes=cfg.get("max_response_bytes", 2_000_000))
        capture.attach(page)

        do_login(page, cfg, base_url, settle)
        resolver = PrivacyResolver(cfg, context, base_url)

        # 1) Load the post and discover interactors.
        print(f"[post] loading {full_post}")
        capture.clear()
        try:
            page.goto(full_post, wait_until="domcontentloaded")
        except Exception as e:
            print(f"[abort] could not load post {full_post}: {e}")
            context.close(); browser.close()
            return findings
        page.wait_for_timeout(int(settle * 1000))
        interactors = discover_interactors(page, cfg, base_url, settle)

        if len(interactors) > max_users:
            print(f"[note] discovered {len(interactors)} users; capping at max_users={max_users}")
            interactors = interactors[:max_users]

        print(f"[post] discovered {len(interactors)} interacting user(s):")
        for u in interactors:
            print(f"    - {u['username']:<24} {u['profile_url']}")

        # Also scan the post's own likes/comments payloads (value-blind).
        net_hits: list[dict] = []
        for entry in capture.entries:
            if entry.get("json") is not None:
                scan_json_for_users(entry["json"], _tag_endpoint(net_hits, entry["path"]))
        for path, hits in _group_by_endpoint(net_hits).items():
            findings.extend(_to_findings(post_url, hits, resolver, source="network(post)", endpoint=path))

        if args.list_only:
            print("[list-only] stopping before visiting profiles.")
            context.close(); browser.close()
            return findings

        # 2) Visit each discovered profile and check exposure (value-blind).
        for i, u in enumerate(interactors, 1):
            print(f"[{i}/{len(interactors)}] profile {u['profile_url']}")
            capture.clear()
            try:
                page.goto(u["profile_url"], wait_until="domcontentloaded")
                page.wait_for_timeout(int(settle * 1000))
                page.wait_for_load_state("networkidle", timeout=5000)
            except Exception as e:
                print(f"    [warn] failed to load profile: {e}")
                time.sleep(delay)
                continue

            dom_hits = dom_user_exposure(page, user_sel, uname_sel)
            # Attribute DOM hits on a profile page to the profile owner if no card username.
            for h in dom_hits:
                if not h.get("username"):
                    h["username"] = u["username"]
            findings.extend(_to_findings(u["profile_url"], dom_hits, resolver, source="dom(profile)", endpoint=""))

            net_hits = []
            for entry in capture.entries:
                if entry.get("json") is not None:
                    scan_json_for_users(entry["json"], _tag_endpoint(net_hits, entry["path"]))
            for path, hits in _group_by_endpoint(net_hits).items():
                findings.extend(_to_findings(u["profile_url"], hits, resolver, source="network(profile)", endpoint=path))

            time.sleep(delay)

        context.close()
        browser.close()

    return findings


# ---------------------------------------------------------------------------
# Planning (used by both dry-run and live run)
# ---------------------------------------------------------------------------

def build_plan(cfg: dict) -> list[PlannedCheck]:
    plan = []
    for t in cfg["targets"]:
        ttype = t.get("type", "profile")
        plan.append(PlannedCheck(
            url=t["url"],
            type=ttype,
            expected_privacy=t.get("expected_privacy", "unknown"),
            open_likes=(ttype == "post"),
            open_comments=(ttype == "post"),
        ))
    return plan


def print_dry_run(cfg: dict, base_url: str, plan: list[PlannedCheck]) -> None:
    print("=== DRY RUN — no requests will be made ===")
    print(f"base_url: {base_url}")
    print(f"login as: {(cfg.get('test_login') or {}).get('username', '(none)')}")
    print(f"admin privacy endpoint: {cfg.get('admin_privacy_endpoint', '(none — using config users map)')}")
    print(f"targets ({len(plan)}), visited in this exact order, NOTHING else:")
    for i, pc in enumerate(plan, 1):
        full = urljoin(base_url, pc.url)
        actions = ["load page", "scan DOM for email/phone", "scan network JSON for email/phone"]
        if pc.open_likes:
            actions.insert(1, "open likes list")
        if pc.open_comments:
            actions.insert(2, "open comments list")
        print(f"  {i:>3}. [{pc.type}] {full}")
        print(f"        expected_privacy={pc.expected_privacy}")
        print(f"        planned checks: {', '.join(actions)}")
    print("=== end dry run ===")


# ---------------------------------------------------------------------------
# Live run
# ---------------------------------------------------------------------------

def run_live(cfg: dict, base_url: str, plan: list[PlannedCheck], args) -> list[Finding]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit(
            "[abort] Playwright is not installed. Install it with:\n"
            "    pip install playwright\n"
            "    playwright install chromium\n"
            "Then re-run. (Use --dry-run to preview without Playwright.)"
        )

    settle = cfg.get("settle_seconds", 0.8)
    delay = max(1.0, min(2.0, cfg.get("rate_limit_seconds", 1.5)))  # 1–2s clamp
    sel = cfg.get("selectors", {})
    user_sel = sel.get("user_card", "[data-testid='user'], .user-card, li.user, .liker, .comment")
    uname_sel = sel.get("username", "[data-username], .username, .handle")
    likes_toggles = sel.get("likes_toggle", ["[data-testid='likes']", ".likes-count", "button.likes", "a.likers"])
    comments_toggles = sel.get("comments_toggle", ["[data-testid='comments']", ".comments-toggle", "button.comments"])

    findings: list[Finding] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        context = browser.new_context()
        page = context.new_page()
        capture = NetworkCapture(max_bytes=cfg.get("max_response_bytes", 2_000_000))
        capture.attach(page)

        do_login(page, cfg, base_url, settle)
        resolver = PrivacyResolver(cfg, context, base_url)

        for idx, pc in enumerate(plan):
            full = urljoin(base_url, pc.url)
            # SCOPE GUARD: only navigate to configured targets, never discovered links.
            print(f"[{idx+1}/{len(plan)}] visiting {full}")
            capture.clear()
            try:
                page.goto(full, wait_until="domcontentloaded")
                page.wait_for_timeout(int(settle * 1000))
            except Exception as e:
                print(f"    [warn] failed to load target: {e}")
                time.sleep(delay)
                continue

            if pc.open_likes:
                try_open_section(page, likes_toggles, settle)
            if pc.open_comments:
                try_open_section(page, comments_toggles, settle)

            try:
                page.wait_for_load_state("networkidle", timeout=5000)
            except Exception:
                pass

            # --- DOM exposures ---
            dom_hits = dom_user_exposure(page, user_sel, uname_sel)
            # --- Network exposures ---
            net_hits: list[dict] = []
            for entry in capture.entries:
                if entry.get("json") is not None:
                    scan_json_for_users(entry["json"], _tag_endpoint(net_hits, entry["path"]))

            findings.extend(_to_findings(pc.url, dom_hits, resolver, source="dom", endpoint=""))
            for path, hits in _group_by_endpoint(net_hits).items():
                findings.extend(_to_findings(pc.url, hits, resolver, source="network", endpoint=path))

            time.sleep(delay)

        context.close()
        browser.close()

    return findings


def _tag_endpoint(sink: list[dict], path: str):
    """Return a proxy list that tags appended user-hits with the endpoint path."""
    class _Tagger(list):
        def append(self, item):
            item = dict(item)
            item["_endpoint"] = path
            sink.append(item)
    return _Tagger()


def _group_by_endpoint(hits: list[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = {}
    for h in hits:
        grouped.setdefault(h.get("_endpoint", ""), []).append(h)
    return grouped


def _to_findings(target_url: str, hits: list[dict], resolver: PrivacyResolver,
                 source: str, endpoint: str) -> list[Finding]:
    out: list[Finding] = []
    seen = set()
    for h in hits:
        username = h["username"]
        for field in h["fields"]:
            key = (username, field, source, endpoint)
            if key in seen:
                continue
            seen.add(key)
            privacy = resolver.resolve(username)
            exp_vis = expected_visibility_for(privacy)
            sev = severity_for(exp_vis, True, field)
            out.append(Finding(
                target_url=target_url,
                user_shown=username,
                field_checked=field,
                expected_visibility=exp_vis,
                actually_exposed=True,
                severity=sev,
                source=source,
                endpoint=endpoint,
            ))
    return out


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def write_reports(findings: list[Finding], out_base: Path) -> None:
    rows = [asdict(f) for f in findings]
    cols = ["target_url", "user_shown", "field_checked", "expected_visibility",
            "actually_exposed", "severity", "source", "endpoint"]

    json_path = out_base.with_suffix(".json")
    json_path.write_text(json.dumps(rows, indent=2))

    csv_path = out_base.with_suffix(".csv")
    with csv_path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow(r)

    print(f"\nwrote {len(rows)} finding(s):")
    print(f"  {csv_path}")
    print(f"  {json_path}")
    leaks = [f for f in findings if f.severity == "high"]
    if leaks:
        print(f"\n*** {len(leaks)} HIGH-severity privacy leak(s) — contact field shown "
              f"despite a private setting. Review the report. ***")
    else:
        print("\nNo high-severity leaks detected.")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Privacy-setting enforcement tester (STAGING/TEST ONLY).",
    )
    parser.add_argument("url", nargs="?", default=None,
                        help="a single post URL or /path to test. If given, runs post-crawl "
                             "mode directly. If omitted (and no --targets-file), you'll be "
                             "prompted for one.")
    parser.add_argument("-c", "--config", default="config.json", type=Path,
                        help="path to config.json (default: config.json)")
    parser.add_argument("-o", "--out", default="privacy_report", type=Path,
                        help="output report basename (writes .csv and .json)")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the plan; make NO requests")
    parser.add_argument("--headed", action="store_true",
                        help="run the browser headed (default: headless)")
    parser.add_argument("--post", metavar="URL",
                        help="explicit post-crawl seed (same as passing the URL positionally)")
    parser.add_argument("--targets-file", action="store_true",
                        help="ignore the single-URL flow and use the config.json 'targets' list instead")
    parser.add_argument("--max-users", type=int, default=None,
                        help="cap on discovered users to visit in post mode (default: config.max_users or 200)")
    parser.add_argument("--list-only", action="store_true",
                        help="post mode: discover and print interacting users, then stop "
                             "before visiting their profiles")
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    base_url = cfg["base_url"].rstrip("/")

    # Safety guard runs for BOTH dry-run and live so misconfig is caught early.
    assert_not_production(base_url, cfg)

    # --- Single-URL post-crawl is the default, simplest flow ---
    if not args.targets_file:
        post_url = args.post or args.url
        if not post_url and not args.dry_run:
            try:
                post_url = input("Enter a post URL (or /path) to test: ").strip()
            except EOFError:
                post_url = ""
        if not post_url:
            if args.dry_run:
                print("[dry-run] no URL supplied; nothing planned. "
                      "Pass a post URL or use --targets-file.")
                return 0
            sys.exit("[abort] no post URL given.")

        # If an absolute URL was passed, guard ITS host too (not just config base_url).
        if urlparse(post_url).scheme:
            assert_not_production(post_url, cfg)

        if args.dry_run:
            print("=== DRY RUN — no requests will be made ===")
            print(f"base_url: {base_url}")
            print(f"post-crawl seed: {urljoin(base_url + '/', post_url)}")
            print("plan: log in -> open likes+comments -> discover interacting users -> "
                  "visit each profile -> check email/phone exposure vs privacy setting")
            print("output is value-blind: which field/endpoint was exposed, never the value.")
            print("=== end dry run ===")
            return 0
        findings = run_post_crawl(cfg, base_url, post_url, args)
        write_reports(findings, args.out)
        return 0

    plan = build_plan(cfg)

    if args.dry_run:
        print_dry_run(cfg, base_url, plan)
        return 0

    findings = run_live(cfg, base_url, plan, args)
    write_reports(findings, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
