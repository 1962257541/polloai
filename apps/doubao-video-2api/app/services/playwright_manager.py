import asyncio
import hashlib
import json
import os
import shutil
import sys
import time
import uuid
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional
from urllib.parse import parse_qs, urlencode, urlparse

from loguru import logger
from playwright.async_api import Browser, BrowserContext, ConsoleMessage, Page, TimeoutError, async_playwright
from playwright_stealth import Stealth

from app.core.config import normalize_doubao_cookie, settings
from app.services.credential_manager import credential_identity
from app.services.doubao_challenge_probe import probe_doubao_drag_captcha, probe_has_visible_challenge


PROFILE_VERSION = 1
PROFILE_IDENTITY_KEYS = (
    "uid_tt",
    "uid_tt_ss",
    "passport_user_id",
    "user_unique_id",
    "login_user_id",
    "sessionid",
    "sessionid_ss",
    "sid_tt",
)


def handle_console_message(msg: ConsoleMessage) -> None:
    text = msg.text
    if "Failed to load resource" in text or "net::ERR_FAILED" in text:
        return
    if "WebSocket connection" in text:
        return
    if "Content Security Policy" in text:
        return
    if "Scripts may close only the windows that were opened by them" in text:
        return
    if "Ignoring too frequent calls to print()" in text:
        return
    if "has been blocked by CORS policy" in text and "clarity.ms" in text:
        return
    if "has been blocked by CORS policy" in text and "mon.zijieapi.com/monitor_web/settings/browser-settings" in text:
        return

    log_message = f"[Browser Console] {text}"
    if msg.type.upper() == "ERROR":
        logger.error(log_message)
    elif msg.type.upper() == "WARNING":
        logger.warning(log_message)


@dataclass
class AccountBrowserSession:
    profile_id: str
    credential_identity: str
    cookie: str
    context: BrowserContext
    page: Page
    has_frontier_sign: bool
    device_fingerprint: Dict[str, str] = field(default_factory=dict)
    web_tab_id: Optional[str] = None
    last_used_at: float = field(default_factory=time.monotonic)
    in_use: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class PlaywrightManager:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(PlaywrightManager, cls).__new__(cls)
            cls._instance._initialized = False
            cls._instance._ensure_runtime_state()
        return cls._instance

    def _ensure_runtime_state(self) -> None:
        if not hasattr(self, "_pool_lock"):
            self._pool_lock = asyncio.Lock()
            self._pool_condition = asyncio.Condition(self._pool_lock)
        if not hasattr(self, "sessions"):
            self.sessions: Dict[str, AccountBrowserSession] = {}
        if not hasattr(self, "profile_records"):
            self.profile_records: Dict[str, Dict[str, Any]] = {}
        if not hasattr(self, "profile_identities"):
            self.profile_identities: Dict[str, set[str]] = {}
        if not hasattr(self, "ms_tokens"):
            self.ms_tokens: Dict[str, str] = {}
        if not hasattr(self, "account_device_fingerprints"):
            self.account_device_fingerprints: Dict[str, Dict[str, str]] = {}
        if not hasattr(self, "_cleanup_task"):
            self._cleanup_task: Optional[asyncio.Task] = None
        if not hasattr(self, "_browser_idle_shutdown_task"):
            self._browser_idle_shutdown_task: Optional[asyncio.Task] = None
        if not hasattr(self, "_browser_started"):
            self._browser_started = False
        if not hasattr(self, "_last_browser_activity_at"):
            self._last_browser_activity_at = time.monotonic()
        if not hasattr(self, "playwright"):
            self.playwright = None
        if not hasattr(self, "browser"):
            self.browser = None
        if not hasattr(self, "context"):
            self.context: Optional[BrowserContext] = None
        if not hasattr(self, "page"):
            self.page: Optional[Page] = None
        if not hasattr(self, "active_identity"):
            self.active_identity: Optional[str] = None
        if not hasattr(self, "has_frontier_sign"):
            self.has_frontier_sign = False
        if not hasattr(self, "ms_token"):
            self.ms_token: Optional[str] = None
        if not hasattr(self, "browser_version"):
            self._set_browser_metadata("120.0.0.0")

    async def initialize(self, cookies: List[str]) -> None:
        if self._initialized:
            return
        self._ensure_runtime_state()
        async with self._pool_lock:
            if self._initialized:
                return
            if not cookies:
                raise ValueError("Playwright initialization requires at least one Doubao cookie.")

            logger.info("Initializing Playwright account profile pool.")
            self._set_browser_metadata(getattr(self, "browser_version", "120.0.0.0"))
            self.static_device_fingerprint = {
                "device_id": settings.DOUBAO_DEVICE_ID,
                "fp": settings.DOUBAO_FP,
                "web_id": settings.DOUBAO_WEB_ID,
                "tea_uuid": settings.DOUBAO_TEA_UUID,
            }
            self.max_active_contexts = max(1, int(settings.DOUBAO_BROWSER_MAX_ACTIVE_CONTEXTS))
            self.idle_timeout_seconds = max(1.0, float(settings.DOUBAO_BROWSER_IDLE_TIMEOUT_SECONDS))
            self.cleanup_interval_seconds = max(
                1.0,
                float(settings.DOUBAO_BROWSER_CLEANUP_INTERVAL_SECONDS),
            )
            self.browser_idle_shutdown_seconds = max(
                0.0,
                float(settings.DOUBAO_BROWSER_IDLE_SHUTDOWN_SECONDS),
            )
            self.stale_session_seconds = max(
                1.0,
                float(settings.DOUBAO_BROWSER_STALE_SESSION_SECONDS),
            )

            for cookie in cookies:
                self._load_or_create_profile(normalize_doubao_cookie(cookie))

            self._initialized = True
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())
            if not settings.DOUBAO_BROWSER_LAZY_START:
                await self._ensure_browser_started_locked()
            mode = "lazy" if not self._browser_started else ("headless" if self._headless_mode() else "headed")
            logger.success(
                f"Playwright account profile pool initialized in {mode} mode: "
                f"profiles={len(self.profile_records)}, max_active={self.max_active_contexts}, "
                f"idle_timeout={self.idle_timeout_seconds}s, browser_started={self._browser_started}, "
                f"browser_idle_shutdown={self.browser_idle_shutdown_seconds}s, "
                f"stale_session={self.stale_session_seconds}s, "
                f"browser={self.browser_version}."
            )

    def _set_browser_metadata(self, browser_version: str) -> None:
        self.browser_version = str(browser_version or "120.0.0.0")
        self.browser_major = self.browser_version.split(".", 1)[0]
        self.browser_user_agent = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            f"Chrome/{self.browser_version} Safari/537.36"
        )
        self.browser_headers = {
            "User-Agent": self.browser_user_agent,
            "sec-ch-ua": (
                f'"Chromium";v="{self.browser_major}", '
                f'"Google Chrome";v="{self.browser_major}", '
                '"Not/A)Brand";v="99"'
            ),
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
        }
        self.stealth = Stealth(
            navigator_languages_override=("zh-CN", "zh"),
            navigator_platform_override="Win32",
            navigator_user_agent_override=self.browser_user_agent,
            navigator_vendor_override="Google Inc.",
            sec_ch_ua_override=self.browser_headers["sec-ch-ua"],
            webgl_vendor_override="Google Inc. (Intel)",
            webgl_renderer_override=(
                "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 "
                "vs_5_0 ps_5_0, D3D11)"
            ),
            init_scripts_only=True,
        )

    async def _ensure_browser_started_locked(self) -> None:
        self._cancel_browser_idle_shutdown_locked()
        if self._browser_started:
            return
        self.playwright = await async_playwright().start()
        try:
            chrome_path = self._find_browser_executable()
            headless = self._headless_mode()
            launch_options: Dict[str, Any] = {
                "headless": headless,
                "args": [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-blink-features=AutomationControlled",
                    "--disable-background-networking",
                    "--disable-component-update",
                    "--disable-crash-reporter",
                    "--disable-crashpad",
                    "--disable-gpu",
                    "--disable-sync",
                    "--mute-audio",
                    "--window-size=1280,720",
                ],
            }
            if chrome_path:
                launch_options["executable_path"] = chrome_path

            self.browser = await self.playwright.chromium.launch(**launch_options)
            self._browser_started = True
            self._last_browser_activity_at = time.monotonic()
            self._set_browser_metadata(self.browser.version)
            mode = "headless" if headless else "headed"
            logger.info(f"Playwright browser started lazily in {mode} mode: browser={self.browser_version}.")
        except Exception:
            playwright = self.playwright
            self.playwright = None
            self.browser = None
            self._browser_started = False
            if callable(getattr(playwright, "stop", None)):
                await playwright.stop()
            raise

    def _cancel_browser_idle_shutdown_locked(self) -> None:
        task = getattr(self, "_browser_idle_shutdown_task", None)
        if task and not task.done():
            task.cancel()
        self._browser_idle_shutdown_task = None

    def _schedule_browser_idle_shutdown_locked(self) -> None:
        if not self._initialized or not self._browser_started or self.sessions:
            return
        task = getattr(self, "_browser_idle_shutdown_task", None)
        if task and not task.done():
            return
        self._browser_idle_shutdown_task = asyncio.create_task(self._shutdown_browser_after_idle())

    async def _shutdown_browser_after_idle(self) -> None:
        task = asyncio.current_task()
        try:
            delay = max(0.0, float(getattr(self, "browser_idle_shutdown_seconds", 45)))
            await asyncio.sleep(delay)
            async with self._pool_condition:
                if self.sessions or not self._browser_started:
                    return
                await self._stop_browser_locked("idle")
                self._pool_condition.notify_all()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(f"Idle Playwright browser shutdown failed: {exc}")
        finally:
            if getattr(self, "_browser_idle_shutdown_task", None) is task:
                self._browser_idle_shutdown_task = None

    async def _stop_browser_locked(self, reason: str) -> None:
        browser = getattr(self, "browser", None)
        playwright = getattr(self, "playwright", None)
        if callable(getattr(browser, "close", None)):
            with suppress(Exception):
                await browser.close()
        if callable(getattr(playwright, "stop", None)):
            with suppress(Exception):
                await playwright.stop()
        self.browser = None
        self.playwright = None
        self._browser_started = False
        if browser or playwright:
            logger.info(f"Playwright browser stopped after {reason}.")

    async def register_account(self, cookie: str) -> Dict[str, Any]:
        self._ensure_runtime_state()
        normalized = normalize_doubao_cookie(cookie)
        if not normalized:
            raise ValueError("Credential cookie cannot be empty.")
        async with self._pool_condition:
            profile, created = self._load_or_create_profile(normalized)
            return self._public_profile(profile, created=created)

    async def remove_account_profile(self, cookie: str, wait_timeout: float = 30.0) -> bool:
        self._ensure_runtime_state()
        normalized = normalize_doubao_cookie(cookie)
        profile_id = self._profile_id(normalized)
        deadline = time.monotonic() + max(0.0, wait_timeout)
        async with self._pool_condition:
            session = self.sessions.get(profile_id)
            while session and session.in_use > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError("Browser profile is currently in use.")
                try:
                    await asyncio.wait_for(self._pool_condition.wait(), timeout=remaining)
                except asyncio.TimeoutError as exc:
                    raise RuntimeError("Browser profile is currently in use.") from exc
                session = self.sessions.get(profile_id)
            if session:
                await self._close_session_locked(session, remove=True)
            self.profile_records.pop(profile_id, None)
            self._remove_profile_indexes(profile_id)
            profile_dir = self._profile_dir(profile_id)
            if profile_dir.exists():
                shutil.rmtree(profile_dir)
                return True
            return False

    def profile_snapshot(self, cookie: str) -> Dict[str, Any]:
        self._ensure_runtime_state()
        profile_id = self._profile_id(cookie)
        profile = self.profile_records.get(profile_id)
        if not profile:
            profile, _ = self._load_or_create_profile(normalize_doubao_cookie(cookie))
        return self._public_profile(profile)

    def pool_snapshot(self) -> Dict[str, Any]:
        self._ensure_runtime_state()
        profiles = [
            self._public_profile(profile)
            for profile in sorted(
                self.profile_records.values(),
                key=lambda item: item.get("created_at", 0),
            )
        ]
        return {
            "profile_count": len(profiles),
            "active_contexts": len(self.sessions),
            "browser_started": bool(getattr(self, "_browser_started", False)),
            "max_active_contexts": getattr(
                self,
                "max_active_contexts",
                settings.DOUBAO_BROWSER_MAX_ACTIVE_CONTEXTS,
            ),
            "idle_timeout_seconds": getattr(
                self,
                "idle_timeout_seconds",
                settings.DOUBAO_BROWSER_IDLE_TIMEOUT_SECONDS,
            ),
            "browser_idle_shutdown_seconds": getattr(
                self,
                "browser_idle_shutdown_seconds",
                settings.DOUBAO_BROWSER_IDLE_SHUTDOWN_SECONDS,
            ),
            "stale_session_seconds": getattr(
                self,
                "stale_session_seconds",
                settings.DOUBAO_BROWSER_STALE_SESSION_SECONDS,
            ),
            "profiles": profiles,
        }

    async def close_account_session(self, cookie: str) -> bool:
        """Close an idle browser context for a specific account profile."""
        self._ensure_runtime_state()
        normalized = normalize_doubao_cookie(cookie)
        profile_id = self._profile_id(normalized)
        async with self._pool_condition:
            session = self.sessions.get(profile_id)
            if not session or session.in_use > 0:
                return False
            await self._close_session_locked(session, remove=True)
            self._pool_condition.notify_all()
            return True

    def update_ms_token(self, token: str, cookie: Optional[str] = None) -> None:
        self._ensure_runtime_state()
        self.ms_token = token
        if not cookie:
            return
        normalized = normalize_doubao_cookie(cookie)
        identity = credential_identity(normalized)
        self.ms_tokens[identity] = token
        profile, _ = self._load_or_create_profile(normalized)
        profile["ms_token"] = token
        profile["updated_at"] = time.time()
        self._save_profile_metadata(profile)

    def get_ms_token(self, cookie: str) -> Optional[str]:
        self._ensure_runtime_state()
        normalized = normalize_doubao_cookie(cookie)
        identity = credential_identity(normalized)
        if self.ms_tokens.get(identity):
            return self.ms_tokens[identity]
        profile = self.profile_records.get(self._profile_id(normalized))
        if profile:
            token = str(profile.get("ms_token") or "")
            if token:
                return token
        return self._extract_cookie_value(normalized, "msToken")

    async def get_account_device_fingerprint(self, cookie: str) -> Dict[str, str]:
        if not self._initialized:
            raise RuntimeError("PlaywrightManager is not initialized.")
        async with self._account_session(cookie) as session:
            return dict(session.device_fingerprint)

    async def get_browser_cookie_header(self, cookie: Optional[str] = None) -> Optional[str]:
        if not self._initialized:
            raise RuntimeError("PlaywrightManager is not initialized.")
        if cookie:
            async with self._account_session(cookie) as session:
                return await self._cookie_header(session.context)

        async with self._pool_condition:
            if not self.sessions:
                return None
            session = max(self.sessions.values(), key=lambda item: item.last_used_at)
            session.in_use += 1
        try:
            async with session.lock:
                return await self._cookie_header(session.context)
        finally:
            await self._release_session(session)

    async def refresh_account_cookie_header(
        self,
        cookie: str,
        *,
        settle_seconds: float = 2.0,
        timeout_seconds: float = 60.0,
    ) -> Optional[str]:
        if not self._initialized:
            raise RuntimeError("PlaywrightManager is not initialized.")
        normalized = normalize_doubao_cookie(cookie)
        if not normalized:
            raise ValueError("Credential cookie cannot be empty.")
        async with self._account_session(normalized) as session:
            try:
                await session.page.goto(
                    "https://www.doubao.com/chat/",
                    wait_until="load",
                    timeout=max(1.0, float(timeout_seconds or 60.0)) * 1000,
                )
            except TimeoutError as exc:
                raise RuntimeError("Unable to refresh doubao.com chat page for account profile.") from exc
            if settle_seconds > 0:
                await asyncio.sleep(float(settle_seconds))
            return await self._cookie_header(session.context)

    async def get_signed_url(self, base_url: str, cookie: str, base_params: Dict[str, str]) -> Optional[str]:
        if not self._initialized:
            raise RuntimeError("PlaywrightManager is not initialized.")
        try:
            async with self._account_session(cookie) as session:
                return await self._get_signed_url_locked(session, base_url, cookie, base_params)
        except Exception as exc:
            logger.error(f"Playwright signing failed: {exc}", exc_info=True)
            return None

    async def post_json(
        self,
        base_url: str,
        cookie: str,
        base_params: Dict[str, str],
        payload: Dict[str, Any],
        headers: Optional[Dict[str, str]] = None,
        timeout_seconds: Optional[float] = None,
    ) -> Dict[str, Any]:
        if not self._initialized:
            raise RuntimeError("PlaywrightManager is not initialized.")

        async with self._account_session(cookie) as session:
            should_probe_trigger = self._should_probe_chat_completion_trigger(base_url)
            request_url, _ = self._request_url_locked(
                session,
                base_url,
                cookie,
                base_params,
            )

            browser_headers = {
                key: value
                for key, value in (headers or {}).items()
                if key.lower() not in {
                    "cookie",
                    "origin",
                    "referer",
                    "user-agent",
                    "sec-ch-ua",
                    "sec-ch-ua-mobile",
                    "sec-ch-ua-platform",
                    "sec-fetch-dest",
                    "sec-fetch-mode",
                    "sec-fetch-site",
                }
            }
            timeout_value = max(1.0, timeout_seconds or settings.API_REQUEST_TIMEOUT)
            timeout_ms = int(timeout_value * 1000)
            before_probe: Optional[Dict[str, Any]] = None
            challenge_watch_task: Optional[asyncio.Task] = None
            if should_probe_trigger:
                before_probe = await self._capture_chat_completion_trigger_state(
                    session.page,
                    phase="before_fetch",
                )
                challenge_watch_task = asyncio.create_task(
                    self._watch_chat_completion_challenge(
                        session.page,
                        timeout_seconds=min(8.0, timeout_value),
                    )
                )
            try:
                result = await asyncio.wait_for(
                    session.page.evaluate(
                        """async ({url, payload, headers, timeoutMs}) => {
                            const controller = new AbortController();
                            const timer = setTimeout(() => controller.abort(), timeoutMs);
                            try {
                                const response = await window.fetch(url, {
                                    method: "POST",
                                    headers,
                                    body: JSON.stringify(payload),
                                    credentials: "include",
                                    referrer: "https://www.doubao.com/chat/",
                                    signal: controller.signal,
                                });
                                const text = await response.text();
                                return {
                                    status_code: response.status,
                                    headers: Object.fromEntries(response.headers.entries()),
                                    text,
                                    url: response.url,
                                };
                            } finally {
                                clearTimeout(timer);
                            }
                        }""",
                        {
                            "url": request_url,
                            "payload": payload,
                            "headers": browser_headers,
                            "timeoutMs": timeout_ms,
                        },
                    ),
                    timeout=timeout_value + 5,
                )
            except asyncio.TimeoutError as exc:
                if challenge_watch_task:
                    challenge_watch_task.cancel()
                    with suppress(asyncio.CancelledError):
                        await challenge_watch_task
                raise TimeoutError(f"Browser fetch timed out after {timeout_value:g}s.") from exc
            except Exception:
                if challenge_watch_task:
                    challenge_watch_task.cancel()
                    with suppress(asyncio.CancelledError):
                        await challenge_watch_task
                raise
            if not isinstance(result, dict):
                if challenge_watch_task:
                    challenge_watch_task.cancel()
                    with suppress(asyncio.CancelledError):
                        await challenge_watch_task
                raise RuntimeError("Browser fetch returned an unexpected response.")
            if should_probe_trigger:
                verify_like = self._response_looks_like_doubao_verification(result)
                watch_result = await self._finish_challenge_watch(
                    challenge_watch_task,
                    wait_seconds=2.0 if verify_like else 0.2,
                )
                after_probe = await self._capture_chat_completion_trigger_state(
                    session.page,
                    phase="after_fetch",
                    snapshot=verify_like or bool((watch_result or {}).get("visible_challenge_detected")),
                    snapshot_prefix=session.profile_id,
                )
                result["browser_trigger_context"] = {
                    "kind": "chat_completion_fetch",
                    "request_url": self._redact_debug_url(request_url),
                    "page_url": after_probe.get("url") or (before_probe or {}).get("url"),
                    "page_title": after_probe.get("title") or (before_probe or {}).get("title"),
                    "before": before_probe,
                    "watch": watch_result,
                    "after": after_probe,
                    "visible_challenge_detected": bool(
                        (watch_result or {}).get("visible_challenge_detected")
                        or after_probe.get("visible_challenge_detected")
                    ),
                    "solver_compatible": bool(
                        (watch_result or {}).get("solver_compatible")
                        or after_probe.get("solver_compatible")
                    ),
                }
            return result

    def _should_probe_chat_completion_trigger(self, base_url: str) -> bool:
        try:
            parsed = urlparse(base_url)
        except Exception:
            return False
        return parsed.netloc.endswith("doubao.com") and parsed.path.rstrip("/") == "/chat/completion"

    def _redact_debug_url(self, url: str) -> str:
        try:
            parsed = urlparse(url)
            query = parse_qs(parsed.query, keep_blank_values=True)
            redacted: Dict[str, List[str]] = {}
            for key, values in query.items():
                key_lower = key.lower()
                if "token" in key_lower or key_lower in {"a_bogus", "x-bogus"}:
                    redacted[key] = ["[REDACTED]"]
                else:
                    redacted[key] = values
            return parsed._replace(query=urlencode(redacted, doseq=True)).geturl()
        except Exception:
            return url

    def _response_looks_like_doubao_verification(self, result: Dict[str, Any]) -> bool:
        text = str(result.get("text") or "")
        lowered = text.lower()
        return (
            "verify_scene" in lowered
            or "shark_admin" in lowered
            or "710022004" in text
            or "rate limited" in lowered
        )

    async def _capture_chat_completion_trigger_state(
        self,
        page: Page,
        *,
        phase: str,
        snapshot: bool = False,
        snapshot_prefix: str = "",
    ) -> Dict[str, Any]:
        state: Dict[str, Any] = {
            "phase": phase,
            "captured_at": time.time(),
            "url": page.url,
            "title": "",
            "captcha_probe": None,
            "visible_challenge_detected": False,
            "solver_compatible": False,
            "snapshot_path": None,
        }
        with suppress(Exception):
            state["title"] = await page.title()

        probe = await probe_doubao_drag_captcha(page)
        state["captcha_probe"] = probe
        state["visible_challenge_detected"] = probe_has_visible_challenge(probe)
        state["solver_compatible"] = bool(probe.get("solver_compatible"))

        if snapshot:
            with suppress(Exception):
                snapshot_dir = Path(".generated/verification-trigger-snapshots")
                snapshot_dir.mkdir(parents=True, exist_ok=True)
                safe_prefix = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in snapshot_prefix)[:80]
                name_parts = [part for part in (safe_prefix, phase, time.strftime("%Y%m%d-%H%M%S")) if part]
                snapshot_path = snapshot_dir / f"{'-'.join(name_parts)}-{uuid.uuid4().hex[:8]}.png"
                await page.screenshot(path=str(snapshot_path), full_page=False)
                state["snapshot_path"] = str(snapshot_path)
        return state

    async def _watch_chat_completion_challenge(
        self,
        page: Page,
        *,
        timeout_seconds: float,
        interval_seconds: float = 0.25,
    ) -> Dict[str, Any]:
        started_at = time.time()
        result: Dict[str, Any] = {
            "started_at": started_at,
            "completed_at": None,
            "timeout_seconds": timeout_seconds,
            "samples": 0,
            "visible_challenge_detected": False,
            "solver_compatible": False,
            "captcha_probe": None,
        }
        deadline = time.monotonic() + max(0.1, timeout_seconds)
        while time.monotonic() < deadline:
            probe = await probe_doubao_drag_captcha(page)
            result["samples"] = int(result["samples"]) + 1
            result["captcha_probe"] = probe
            if probe_has_visible_challenge(probe):
                result["visible_challenge_detected"] = True
                result["solver_compatible"] = bool(probe.get("solver_compatible"))
                break
            await asyncio.sleep(max(0.05, interval_seconds))
        result["completed_at"] = time.time()
        return result

    async def _finish_challenge_watch(
        self,
        task: Optional[asyncio.Task],
        *,
        wait_seconds: float,
    ) -> Optional[Dict[str, Any]]:
        if task is None:
            return None
        try:
            return await asyncio.wait_for(task, timeout=max(0.0, wait_seconds))
        except asyncio.TimeoutError:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
            return {
                "completed_at": time.time(),
                "cancelled": True,
                "visible_challenge_detected": False,
                "solver_compatible": False,
            }

    @asynccontextmanager
    async def _account_session(self, cookie: str) -> AsyncIterator[AccountBrowserSession]:
        session = await self._acquire_session(cookie)
        try:
            async with session.lock:
                session.last_used_at = time.monotonic()
                self._set_compat_active_session(session)
                yield session
        finally:
            await self._release_session(session)

    async def _acquire_session(self, cookie: str) -> AccountBrowserSession:
        normalized = normalize_doubao_cookie(cookie)
        async with self._pool_condition:
            profile, _ = self._load_or_create_profile(normalized)
            profile_id = profile["profile_id"]
            while True:
                session = self.sessions.get(profile_id)
                if session:
                    if session.cookie != normalized:
                        if session.in_use > 0:
                            await self._pool_condition.wait()
                            continue
                        await self._close_session_locked(session, remove=True)
                        continue
                    session.in_use += 1
                    session.last_used_at = time.monotonic()
                    return session

                if len(self.sessions) < self.max_active_contexts:
                    break

                candidate = self._eviction_candidate()
                if candidate:
                    await self._close_session_locked(candidate, remove=True)
                    continue

                await self._pool_condition.wait()

            await self._ensure_browser_started_locked()
            session = await self._open_account_session_locked(normalized, profile)
            session.in_use = 1
            self.sessions[profile_id] = session
            self._set_compat_active_session(session)
            return session

    async def _release_session(self, session: AccountBrowserSession) -> None:
        async with self._pool_condition:
            session.in_use = max(0, session.in_use - 1)
            session.last_used_at = time.monotonic()
            self._last_browser_activity_at = session.last_used_at
            profile = self.profile_records.get(session.profile_id)
            if profile:
                profile["last_used_at"] = time.time()
                profile["updated_at"] = time.time()
                self._save_profile_metadata(profile)
            self._pool_condition.notify_all()

    async def _open_account_session_locked(
        self,
        cookie: str,
        profile: Dict[str, Any],
    ) -> AccountBrowserSession:
        profile_id = profile["profile_id"]
        storage_path = self._storage_state_path(profile_id)
        context_options: Dict[str, Any] = {
            "user_agent": self.browser_user_agent,
            "viewport": {"width": 1280, "height": 720},
            "screen": {"width": 1280, "height": 720},
            "locale": "zh-CN",
            "timezone_id": "Asia/Shanghai",
            "color_scheme": "light",
            "device_scale_factor": 1,
            "is_mobile": False,
            "has_touch": False,
        }
        if storage_path.is_file():
            context_options["storage_state"] = str(storage_path)

        context = await self.browser.new_context(**context_options)
        await self.stealth.apply_stealth_async(context)
        await context.add_init_script(
            """() => {
                Object.defineProperty(navigator, "webdriver", {get: () => undefined});
                Object.defineProperty(navigator, "platform", {get: () => "Win32"});
                Object.defineProperty(navigator, "language", {get: () => "zh-CN"});
                Object.defineProperty(navigator, "languages", {get: () => ["zh-CN", "zh"]});
            }"""
        )
        cookie_list = self._cookie_list(cookie)
        if not cookie_list:
            await context.close()
            raise ValueError("Invalid cookie format, unable to initialize account browser profile.")
        await context.add_cookies(cookie_list)

        page = await context.new_page()
        page.on("console", handle_console_message)
        await self._apply_user_agent_metadata(page, context)

        active_identity = credential_identity(cookie)
        observed_fingerprint: Dict[str, str] = dict(profile.get("device_fingerprint") or {})
        observed_web_tab_id: Optional[str] = None

        def _handle_request(request) -> None:
            nonlocal observed_web_tab_id
            try:
                query = parse_qs(urlparse(request.url).query)
                for key in ("device_id", "fp", "web_id", "tea_uuid"):
                    values = query.get(key)
                    if values and values[0] and not observed_fingerprint.get(key):
                        observed_fingerprint[key] = values[0]
                tab_ids = query.get("web_tab_id")
                if tab_ids and tab_ids[0]:
                    observed_web_tab_id = tab_ids[0]
            except Exception:
                return

        async def _handle_response(response) -> None:
            try:
                token = response.headers.get("x-ms-token")
                if token and token != self.get_ms_token(cookie):
                    self.update_ms_token(token, cookie)
                    await context.add_cookies(
                        [{"name": "msToken", "value": token, "domain": ".doubao.com", "path": "/"}]
                    )
                    logger.success(f"Captured refreshed msToken for browser profile {profile_id}.")
            except Exception as exc:
                logger.warning(f"Unable to inspect response headers for msToken: {exc}")

        page.on("request", _handle_request)
        page.on("response", _handle_response)
        try:
            await page.goto("https://www.doubao.com/chat/", wait_until="load", timeout=60000)
        except TimeoutError as exc:
            await context.close()
            raise RuntimeError("Unable to load doubao.com chat page for account profile.") from exc

        has_frontier_sign = False
        try:
            await page.wait_for_function(
                "() => typeof window.byted_acrawler?.frontierSign === 'function'",
                timeout=1500,
            )
            has_frontier_sign = True
        except TimeoutError:
            logger.info(f"Profile {profile_id} will use browser security fetch signing.")

        browser_cookies = {
            item["name"]: item["value"]
            for item in await context.cookies("https://www.doubao.com")
            if item.get("name") and item.get("value")
        }
        cookie_fp = browser_cookies.get("s_v_web_id")
        if cookie_fp:
            observed_fingerprint["fp"] = cookie_fp

        profile["device_fingerprint"] = observed_fingerprint
        profile["last_opened_at"] = time.time()
        profile["updated_at"] = time.time()
        self.account_device_fingerprints[active_identity] = observed_fingerprint
        profile_token = str(profile.get("ms_token") or "")
        if profile_token:
            self.ms_tokens[active_identity] = profile_token
        self._save_profile_metadata(profile)

        logger.success(
            f"Opened browser profile {profile_id}: "
            f"restored={storage_path.is_file()}, fingerprint_fields="
            f"{','.join(sorted(observed_fingerprint)) or 'none'}."
        )
        return AccountBrowserSession(
            profile_id=profile_id,
            credential_identity=active_identity,
            cookie=cookie,
            context=context,
            page=page,
            has_frontier_sign=has_frontier_sign,
            device_fingerprint=observed_fingerprint,
            web_tab_id=observed_web_tab_id,
        )

    async def _get_signed_url_locked(
        self,
        session: AccountBrowserSession,
        base_url: str,
        cookie: str,
        base_params: Dict[str, str],
    ) -> Optional[str]:
        url_with_params, final_query_string = self._request_url_locked(
            session,
            base_url,
            cookie,
            base_params,
        )

        if not session.has_frontier_sign:
            sdk_signed_url = await self._sign_with_security_fetch(session.page, url_with_params)
            if sdk_signed_url:
                logger.success(f"Resolved a_bogus through browser profile {session.profile_id}.")
                return sdk_signed_url
            logger.warning(
                f"Browser profile {session.profile_id} did not produce a_bogus; "
                "using the unsigned request URL."
            )
            return url_with_params

        signature_obj = await session.page.evaluate(
            "query => window.byted_acrawler.frontierSign(query)",
            final_query_string,
        )
        if isinstance(signature_obj, dict) and ("a_bogus" in signature_obj or "X-Bogus" in signature_obj):
            bogus_value = signature_obj.get("a_bogus") or signature_obj.get("X-Bogus")
            return f"{url_with_params}&a_bogus={bogus_value}"
        return None

    def _request_url_locked(
        self,
        session: AccountBrowserSession,
        base_url: str,
        cookie: str,
        base_params: Dict[str, str],
    ) -> tuple[str, str]:
        final_params = base_params.copy()
        final_params.update(self.static_device_fingerprint)
        final_params.update(session.device_fingerprint)
        final_params["web_tab_id"] = session.web_tab_id or str(uuid.uuid4())
        account_ms_token = self.get_ms_token(cookie)
        if account_ms_token:
            final_params["msToken"] = account_ms_token

        sorted_params = dict(sorted((key, value) for key, value in final_params.items() if value is not None))
        final_query_string = urlencode(sorted_params)
        url_with_params = f"{base_url}?{final_query_string}"
        return url_with_params, final_query_string

    async def _sign_with_security_fetch(self, page: Page, url: str) -> Optional[str]:
        captured_url: Optional[str] = None
        target_tab_id = self._query_param(url, "web_tab_id")

        async def capture_route(route, request) -> None:
            nonlocal captured_url
            if target_tab_id and target_tab_id in request.url and request.url.startswith("https://www.doubao.com/"):
                captured_url = request.url
                await route.abort()
                return
            await route.continue_()

        await page.route("**/*", capture_route)
        try:
            await page.evaluate(
                """async url => {
                    try {
                        await window.fetch(url, {
                            method: "POST",
                            headers: {"content-type": "application/json"},
                            body: "{}",
                        });
                    } catch (_) {}
                }""",
                url,
            )
            for _ in range(20):
                if captured_url:
                    break
                await asyncio.sleep(0.05)
        finally:
            await page.unroute("**/*", capture_route)

        if captured_url and ("a_bogus=" in captured_url or "X-Bogus=" in captured_url):
            return captured_url
        return None

    async def _cleanup_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(self.cleanup_interval_seconds)
                async with self._pool_condition:
                    stale = self._sessions_ready_for_cleanup_locked(time.monotonic())
                    for session, reason in stale:
                        if reason == "stale_in_use":
                            logger.warning(
                                f"Closing stale browser profile {session.profile_id}: "
                                f"in_use={session.in_use}, idle_for="
                                f"{time.monotonic() - session.last_used_at:.1f}s."
                            )
                            session.in_use = 0
                        await self._close_session_locked(session, remove=True)
                    if stale:
                        self._pool_condition.notify_all()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(f"Browser profile cleanup loop stopped unexpectedly: {exc}")

    def _eviction_candidate(self) -> Optional[AccountBrowserSession]:
        idle = [session for session in self.sessions.values() if session.in_use == 0]
        return min(idle, key=lambda item: item.last_used_at) if idle else None

    def _sessions_ready_for_cleanup_locked(self, now: float) -> list[tuple[AccountBrowserSession, str]]:
        idle_timeout = float(getattr(self, "idle_timeout_seconds", settings.DOUBAO_BROWSER_IDLE_TIMEOUT_SECONDS))
        stale_timeout = float(getattr(self, "stale_session_seconds", settings.DOUBAO_BROWSER_STALE_SESSION_SECONDS))
        stale: list[tuple[AccountBrowserSession, str]] = []
        for session in list(self.sessions.values()):
            idle_for = now - session.last_used_at
            if session.in_use == 0 and idle_for >= idle_timeout:
                stale.append((session, "idle"))
                continue
            if session.in_use > 0 and idle_for >= stale_timeout and not session.lock.locked():
                stale.append((session, "stale_in_use"))
        return stale

    async def _close_session_locked(
        self,
        session: AccountBrowserSession,
        *,
        remove: bool,
    ) -> None:
        profile = self.profile_records.get(session.profile_id)
        storage_path = self._storage_state_path(session.profile_id)
        storage_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            await session.context.storage_state(path=str(storage_path))
            if profile:
                profile["last_storage_state_at"] = time.time()
        except Exception as exc:
            logger.warning(f"Unable to persist browser profile {session.profile_id}: {exc}")

        if profile:
            profile["device_fingerprint"] = session.device_fingerprint
            profile["last_used_at"] = time.time()
            profile["updated_at"] = time.time()
            token = self.ms_tokens.get(session.credential_identity)
            if token:
                profile["ms_token"] = token
            self._save_profile_metadata(profile)

        with suppress(Exception):
            await session.context.close()
        if remove:
            self.sessions.pop(session.profile_id, None)
        if self.active_identity == session.credential_identity:
            self.context = None
            self.page = None
            self.active_identity = None
            self.has_frontier_sign = False
        self._last_browser_activity_at = time.monotonic()
        self._schedule_browser_idle_shutdown_locked()
        logger.info(f"Closed browser profile {session.profile_id} and persisted storage state.")

    async def _apply_user_agent_metadata(self, page: Page, context: BrowserContext) -> None:
        try:
            session = await context.new_cdp_session(page)
            await session.send(
                "Network.setUserAgentOverride",
                {
                    "userAgent": self.browser_user_agent,
                    "acceptLanguage": "zh-CN,zh;q=0.9,en;q=0.8",
                    "platform": "Win32",
                    "userAgentMetadata": {
                        "brands": [
                            {"brand": "Chromium", "version": self.browser_major},
                            {"brand": "Google Chrome", "version": self.browser_major},
                            {"brand": "Not/A)Brand", "version": "99"},
                        ],
                        "fullVersionList": [
                            {"brand": "Chromium", "version": self.browser_version},
                            {"brand": "Google Chrome", "version": self.browser_version},
                            {"brand": "Not/A)Brand", "version": "99.0.0.0"},
                        ],
                        "platform": "Windows",
                        "platformVersion": "10.0.0",
                        "architecture": "x86",
                        "model": "",
                        "mobile": False,
                        "bitness": "64",
                        "wow64": False,
                    },
                },
            )
        except Exception as exc:
            logger.warning(f"Unable to apply Chromium user-agent metadata override: {exc}")

    async def close(self) -> None:
        if not self._initialized:
            return
        self._cancel_browser_idle_shutdown_locked()
        cleanup_task = self._cleanup_task
        self._cleanup_task = None
        if cleanup_task:
            cleanup_task.cancel()
            with suppress(asyncio.CancelledError):
                await cleanup_task

        async with self._pool_condition:
            for session in list(self.sessions.values()):
                await self._close_session_locked(session, remove=True)
            self._cancel_browser_idle_shutdown_locked()
            await self._stop_browser_locked("service shutdown")
            self._initialized = False
            self._pool_condition.notify_all()
            logger.info("Playwright account profile pool closed.")

    def _load_or_create_profile(self, cookie: str) -> tuple[Dict[str, Any], bool]:
        normalized = normalize_doubao_cookie(cookie)
        profile_id = self._profile_id(normalized)
        existing = self.profile_records.get(profile_id)
        if existing:
            self._index_profile(existing, normalized)
            return existing, False

        profile_dir = self._profile_dir(profile_id)
        profile_dir.mkdir(parents=True, exist_ok=True)
        metadata_path = profile_dir / "profile.json"
        record: Dict[str, Any] = {}
        if metadata_path.is_file():
            try:
                loaded = json.loads(metadata_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    record = loaded
            except (OSError, ValueError) as exc:
                logger.warning(f"Unable to load browser profile metadata {profile_id}: {exc}")

        now = time.time()
        created = not bool(record)
        record.update(
            {
                "version": PROFILE_VERSION,
                "profile_id": profile_id,
                "account_key_hash": self._profile_account_hash(normalized),
                "created_at": record.get("created_at") or now,
                "updated_at": now,
                "device_fingerprint": dict(record.get("device_fingerprint") or {}),
            }
        )
        cookie_fp = self._extract_cookie_value(normalized, "s_v_web_id")
        if cookie_fp:
            record["device_fingerprint"]["fp"] = cookie_fp
        cookie_ms_token = self._extract_cookie_value(normalized, "msToken")
        if cookie_ms_token and not record.get("ms_token"):
            record["ms_token"] = cookie_ms_token

        self.profile_records[profile_id] = record
        self._index_profile(record, normalized)
        self._save_profile_metadata(record)
        return record, created

    def _index_profile(self, profile: Dict[str, Any], cookie: str) -> None:
        identity = credential_identity(cookie)
        self.profile_identities.setdefault(profile["profile_id"], set()).add(identity)
        fingerprint = dict(profile.get("device_fingerprint") or {})
        if fingerprint:
            self.account_device_fingerprints[identity] = fingerprint
        token = str(profile.get("ms_token") or "")
        if token:
            self.ms_tokens[identity] = token

    def _remove_profile_indexes(self, profile_id: str) -> None:
        for identity in self.profile_identities.pop(profile_id, set()):
            self.account_device_fingerprints.pop(identity, None)
            self.ms_tokens.pop(identity, None)

    def _save_profile_metadata(self, profile: Dict[str, Any]) -> None:
        profile_id = profile["profile_id"]
        profile_dir = self._profile_dir(profile_id)
        profile_dir.mkdir(parents=True, exist_ok=True)
        metadata_path = profile_dir / "profile.json"
        temp_path = profile_dir / "profile.json.tmp"
        safe_profile = {
            key: value
            for key, value in profile.items()
            if key
            in {
                "version",
                "profile_id",
                "account_key_hash",
                "created_at",
                "updated_at",
                "last_opened_at",
                "last_used_at",
                "last_storage_state_at",
                "device_fingerprint",
                "ms_token",
            }
        }
        temp_path.write_text(
            json.dumps(safe_profile, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temp_path, metadata_path)

    def _public_profile(self, profile: Dict[str, Any], *, created: bool = False) -> Dict[str, Any]:
        profile_id = profile["profile_id"]
        session = self.sessions.get(profile_id)
        return {
            "profile_id": profile_id,
            "created": created,
            "status": "active" if session else "dormant",
            "in_use": session.in_use if session else 0,
            "has_storage_state": self._storage_state_path(profile_id).is_file(),
            "fingerprint_fields": sorted((profile.get("device_fingerprint") or {}).keys()),
            "created_at": profile.get("created_at"),
            "updated_at": profile.get("updated_at"),
            "last_opened_at": profile.get("last_opened_at"),
            "last_used_at": profile.get("last_used_at"),
        }

    def _set_compat_active_session(self, session: AccountBrowserSession) -> None:
        self.context = session.context
        self.page = session.page
        self.active_identity = session.credential_identity
        self.has_frontier_sign = session.has_frontier_sign

    def _profile_id(self, cookie: str) -> str:
        identity = credential_identity(normalize_doubao_cookie(cookie))
        if identity:
            for profile_id, identities in self.profile_identities.items():
                if identity in identities and profile_id in self.profile_records:
                    return profile_id
        account_key = self._profile_account_key(cookie)
        return hashlib.sha256(account_key.encode("utf-8")).hexdigest()[:24]

    def _profile_account_hash(self, cookie: str) -> str:
        return hashlib.sha256(self._profile_account_key(cookie).encode("utf-8")).hexdigest()

    @classmethod
    def _profile_account_key(cls, cookie: str) -> str:
        pairs = cls._cookie_pairs(cookie)
        for key in PROFILE_IDENTITY_KEYS:
            value = pairs.get(key)
            if value:
                return f"{key}={value}"
        return credential_identity(normalize_doubao_cookie(cookie))

    @staticmethod
    def _cookie_pairs(cookie: str) -> Dict[str, str]:
        pairs: Dict[str, str] = {}
        for part in normalize_doubao_cookie(cookie).split(";"):
            if "=" not in part:
                continue
            name, value = part.split("=", 1)
            name = name.strip().strip("\"'").lower()
            value = value.strip().strip("\"'")
            if name:
                pairs[name] = value
        return pairs

    @classmethod
    def _cookie_list(cls, cookie: str) -> List[Dict[str, str]]:
        return [
            {"name": name, "value": value, "domain": ".doubao.com", "path": "/"}
            for name, value in cls._cookie_pairs(cookie).items()
            if name and not name.upper().startswith("DOUBAO_COOKIE_")
        ]

    @classmethod
    def _extract_cookie_value(cls, cookie: str, name: str) -> Optional[str]:
        return cls._cookie_pairs(cookie).get(name.lower())

    @staticmethod
    def _query_param(url: str, name: str) -> Optional[str]:
        marker = f"{name}="
        for part in url.split("?", 1)[-1].split("&"):
            if part.startswith(marker):
                return part[len(marker):]
        return None

    @staticmethod
    async def _cookie_header(context: BrowserContext) -> Optional[str]:
        cookies = await context.cookies("https://www.doubao.com")
        pairs = [
            f"{cookie['name']}={cookie['value']}"
            for cookie in cookies
            if cookie.get("name") and cookie.get("value") is not None
        ]
        return "; ".join(pairs) if pairs else None

    @staticmethod
    def _profile_root() -> Path:
        return Path(settings.DOUBAO_BROWSER_PROFILE_DIR)

    @classmethod
    def _profile_dir(cls, profile_id: str) -> Path:
        return cls._profile_root() / profile_id

    @classmethod
    def _storage_state_path(cls, profile_id: str) -> Path:
        return cls._profile_dir(profile_id) / "storage-state.json"

    @staticmethod
    def _headless_mode() -> bool:
        configured = os.environ.get("PERSONAL_BROWSER_HEADLESS")
        if configured is None:
            return True
        headless = configured.strip().lower() not in {"0", "false", "no", "off"}
        if not headless and sys.platform.startswith("linux") and not os.environ.get("DISPLAY"):
            logger.warning("Headed browser requested without DISPLAY; falling back to headless mode.")
            return True
        return headless

    @staticmethod
    def _find_browser_executable() -> Optional[str]:
        configured = os.environ.get("BROWSER_EXECUTABLE_PATH")
        if configured and Path(configured).is_file():
            return configured
        candidates = [
            Path("/usr/bin/google-chrome-unstable"),
            Path("/usr/bin/google-chrome-beta"),
            Path("/usr/bin/google-chrome"),
            Path("/usr/bin/google-chrome-stable"),
            Path("/usr/bin/chromium"),
            Path("/usr/bin/chromium-browser"),
            Path(os.environ.get("PROGRAMFILES", "")) / "Google/Chrome/Application/chrome.exe",
            Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google/Chrome/Application/chrome.exe",
            Path(os.environ.get("PROGRAMFILES", "")) / "Microsoft/Edge/Application/msedge.exe",
            Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Microsoft/Edge/Application/msedge.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/Edge/Application/msedge.exe",
        ]
        for candidate in candidates:
            if candidate.is_file():
                return str(candidate)
        return None
