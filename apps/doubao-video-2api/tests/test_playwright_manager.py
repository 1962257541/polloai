import asyncio
import json
import os
from pathlib import Path

import pytest

from app.core.config import normalize_doubao_cookie, settings
from app.services.credential_manager import credential_identity
from app.services.playwright_manager import AccountBrowserSession, PlaywrightManager


def test_find_browser_executable_prefers_configured_path(tmp_path, monkeypatch):
    browser = tmp_path / "chrome"
    browser.write_text("", encoding="utf-8")
    monkeypatch.setenv("BROWSER_EXECUTABLE_PATH", str(browser))

    assert PlaywrightManager._find_browser_executable() == str(browser)


def test_find_browser_executable_ignores_missing_configured_path(monkeypatch):
    monkeypatch.setenv("BROWSER_EXECUTABLE_PATH", os.devnull + ".missing")

    detected = PlaywrightManager._find_browser_executable()

    assert detected is None or Path(detected).is_file()


@pytest.fixture(autouse=True)
def reset_playwright_manager_singleton(monkeypatch, tmp_path):
    manager = PlaywrightManager()
    monkeypatch.setattr(settings, "DOUBAO_BROWSER_PROFILE_DIR", str(tmp_path / "profiles"))
    manager._initialized = False
    manager._pool_lock = asyncio.Lock()
    manager._pool_condition = asyncio.Condition(manager._pool_lock)
    manager.sessions = {}
    manager.profile_records = {}
    manager.profile_identities = {}
    manager.playwright = None
    manager.browser = None
    manager._browser_started = False
    manager._browser_idle_shutdown_task = None
    manager._last_browser_activity_at = 0
    manager.context = None
    manager.page = None
    manager.active_identity = None
    manager.has_frontier_sign = False
    manager.ms_token = None
    manager.ms_tokens = {}
    manager.account_device_fingerprints = {}
    manager._cleanup_task = None
    manager.max_active_contexts = 5
    manager.idle_timeout_seconds = 900
    manager.browser_idle_shutdown_seconds = 45
    manager.stale_session_seconds = 300
    manager.static_device_fingerprint = {}
    manager._set_browser_metadata("120.0.0.0")
    yield


def _session(cookie, profile_id, page, *, context=None, fingerprint=None, frontier=False):
    return AccountBrowserSession(
        profile_id=profile_id,
        credential_identity=credential_identity(cookie),
        cookie=cookie,
        context=context or object(),
        page=page,
        has_frontier_sign=frontier,
        device_fingerprint=fingerprint or {},
    )


def test_ms_tokens_are_isolated_by_credential():
    manager = PlaywrightManager()
    first = "sessionid=first"
    second = "sessionid=second"

    manager.update_ms_token("token-first", first)
    manager.update_ms_token("token-second", second)

    assert manager.get_ms_token(first) == "token-first"
    assert manager.get_ms_token(second) == "token-second"
    assert manager.get_ms_token("sessionid=third") is None


def test_refreshed_ms_token_takes_precedence_over_cookie_token():
    manager = PlaywrightManager()
    manager.update_ms_token("cached", "sessionid=first")

    assert manager.get_ms_token("sessionid=first; msToken=from-cookie") == "cached"


def test_request_url_reuses_current_browser_tab_id():
    manager = PlaywrightManager()
    session = _session(
        "sessionid=first",
        "profile-first",
        object(),
    )
    session.web_tab_id = "page-tab-id"

    url, _ = manager._request_url_locked(
        session,
        "https://www.doubao.com/chat/completion",
        session.cookie,
        {"aid": "497858"},
    )

    assert "web_tab_id=page-tab-id" in url


@pytest.mark.asyncio
async def test_same_account_cookie_refresh_reuses_profile_id():
    manager = PlaywrightManager()
    first = "uid_tt=stable-user; sessionid=old-session"
    refreshed = "uid_tt=stable-user; sessionid=new-session"

    first_profile = await manager.register_account(first)
    refreshed_profile = await manager.register_account(refreshed)

    assert first_profile["created"] is True
    assert refreshed_profile["created"] is False
    assert first_profile["profile_id"] == refreshed_profile["profile_id"]


@pytest.mark.asyncio
async def test_same_session_cookie_refresh_reuses_verified_profile_when_uid_changes():
    manager = PlaywrightManager()
    first = "uid_tt=old-user-token; sessionid=stable-session"
    refreshed = "uid_tt=new-user-token; sessionid=stable-session"

    first_profile = await manager.register_account(first)
    refreshed_profile = await manager.register_account(refreshed)

    assert first_profile["created"] is True
    assert refreshed_profile["created"] is False
    assert first_profile["profile_id"] == refreshed_profile["profile_id"]


@pytest.mark.asyncio
async def test_initialize_defers_browser_launch_by_default(monkeypatch):
    monkeypatch.setattr(settings, "DOUBAO_BROWSER_LAZY_START", True)
    manager = PlaywrightManager()

    await manager.initialize(["sessionid=first"])
    snapshot = manager.pool_snapshot()

    assert manager._initialized is True
    assert manager._browser_started is False
    assert manager.browser is None
    assert snapshot["browser_started"] is False
    assert snapshot["active_contexts"] == 0
    assert snapshot["browser_idle_shutdown_seconds"] == 45
    assert snapshot["stale_session_seconds"] == 300

    await manager.close()


@pytest.mark.asyncio
async def test_profile_metadata_does_not_store_raw_cookie():
    manager = PlaywrightManager()
    cookie = "uid_tt=stable-user; sessionid=secret-session; msToken=rotating-token"

    profile = await manager.register_account(cookie)
    metadata_path = Path(settings.DOUBAO_BROWSER_PROFILE_DIR) / profile["profile_id"] / "profile.json"
    metadata = metadata_path.read_text(encoding="utf-8")

    assert "secret-session" not in metadata
    assert "uid_tt=stable-user" not in metadata
    assert json.loads(metadata)["profile_id"] == profile["profile_id"]


class _FakeRequest:
    def __init__(self, url):
        self.url = url


class _FakeRoute:
    async def abort(self):
        return None

    async def continue_(self):
        return None


class _SecuritySdkPage:
    def __init__(self):
        self.handler = None

    async def route(self, pattern, handler):
        self.handler = handler

    async def unroute(self, pattern, handler):
        assert handler is self.handler

    async def evaluate(self, script, url):
        signed = f"{url}&msToken=browser-token&a_bogus=signed-value"
        await self.handler(_FakeRoute(), _FakeRequest(signed))


@pytest.mark.asyncio
async def test_security_sdk_fallback_returns_intercepted_signed_url():
    manager = PlaywrightManager()
    cookie = "sessionid=first"
    profile = await manager.register_account(cookie)
    page = _SecuritySdkPage()
    manager.sessions[profile["profile_id"]] = _session(cookie, profile["profile_id"], page)
    manager._initialized = True

    signed = await manager.get_signed_url(
        "https://www.doubao.com/chat/completion",
        cookie,
        {"aid": "497858"},
    )

    assert "a_bogus=signed-value" in signed
    assert "msToken=browser-token" in signed


@pytest.mark.asyncio
async def test_account_fingerprint_overrides_global_fingerprint():
    manager = PlaywrightManager()
    cookie = "sessionid=first; s_v_web_id=account-fp"
    profile = await manager.register_account(cookie)
    manager.static_device_fingerprint = {
        "device_id": "global-device",
        "fp": "global-fp",
        "web_id": "global-web",
        "tea_uuid": "global-tea",
    }
    manager.sessions[profile["profile_id"]] = _session(
        cookie,
        profile["profile_id"],
        _SecuritySdkPage(),
        fingerprint={
            "device_id": "account-device",
            "fp": "account-fp",
            "web_id": "account-web",
            "tea_uuid": "account-tea",
        },
    )
    manager._initialized = True

    signed = await manager.get_signed_url(
        "https://www.doubao.com/chat/completion",
        cookie,
        {"aid": "497858"},
    )

    assert "device_id=account-device" in signed
    assert "fp=account-fp" in signed
    assert "web_id=account-web" in signed
    assert "tea_uuid=account-tea" in signed
    assert "global-fp" not in signed


def test_nested_cookie_env_assignment_is_unwrapped():
    raw = 'DOUBAO_COOKIE_1="locale=zh; sessionid_ss=session; uid_tt_ss=user; ttwid=device"'

    assert normalize_doubao_cookie(raw) == (
        "locale=zh; sessionid_ss=session; uid_tt_ss=user; ttwid=device"
    )
    assert [item["name"] for item in PlaywrightManager._cookie_list(raw)] == [
        "locale",
        "sessionid_ss",
        "uid_tt_ss",
        "ttwid",
    ]


@pytest.mark.asyncio
async def test_cookie_refresh_reopens_only_the_matching_profile(monkeypatch):
    manager = PlaywrightManager()
    old_cookie = "uid_tt=stable-user; sessionid=old"
    new_cookie = "uid_tt=stable-user; sessionid=new"
    profile = await manager.register_account(old_cookie)
    old_session = _session(old_cookie, profile["profile_id"], object())
    manager.sessions[profile["profile_id"]] = old_session
    manager._initialized = True
    closed = []

    async def close_session(session, *, remove):
        closed.append(session.cookie)
        if remove:
            manager.sessions.pop(session.profile_id, None)

    async def open_session(cookie, record):
        return _session(cookie, record["profile_id"], object())

    async def ensure_browser_started():
        manager._browser_started = True

    monkeypatch.setattr(manager, "_ensure_browser_started_locked", ensure_browser_started)
    monkeypatch.setattr(manager, "_close_session_locked", close_session)
    monkeypatch.setattr(manager, "_open_account_session_locked", open_session)

    selected = await manager._acquire_session(new_cookie)
    await manager._release_session(selected)

    assert closed == [old_cookie]
    assert selected.cookie == new_cookie
    assert manager.sessions[profile["profile_id"]] is selected


@pytest.mark.asyncio
async def test_context_limit_evicts_least_recent_idle_profile(monkeypatch):
    manager = PlaywrightManager()
    first = "sessionid=first"
    second = "sessionid=second"
    first_profile = await manager.register_account(first)
    second_profile = await manager.register_account(second)
    old_session = _session(first, first_profile["profile_id"], object())
    old_session.last_used_at = 1
    manager.sessions[first_profile["profile_id"]] = old_session
    manager.max_active_contexts = 1
    manager._initialized = True
    closed = []

    async def close_session(session, *, remove):
        closed.append(session.profile_id)
        if remove:
            manager.sessions.pop(session.profile_id, None)

    async def open_session(cookie, record):
        return _session(cookie, record["profile_id"], object())

    async def ensure_browser_started():
        manager._browser_started = True

    monkeypatch.setattr(manager, "_ensure_browser_started_locked", ensure_browser_started)
    monkeypatch.setattr(manager, "_close_session_locked", close_session)
    monkeypatch.setattr(manager, "_open_account_session_locked", open_session)

    selected = await manager._acquire_session(second)
    await manager._release_session(selected)

    assert closed == [first_profile["profile_id"]]
    assert selected.profile_id == second_profile["profile_id"]
    assert len(manager.sessions) == 1


class _PersistentContext:
    def __init__(self):
        self.closed = False

    async def storage_state(self, path):
        Path(path).write_text('{"cookies": [], "origins": []}', encoding="utf-8")

    async def close(self):
        self.closed = True


class _ClosableBrowser:
    def __init__(self):
        self.closed = False

    async def close(self):
        self.closed = True


class _StoppablePlaywright:
    def __init__(self):
        self.stopped = False

    async def stop(self):
        self.stopped = True


@pytest.mark.asyncio
async def test_closing_context_persists_storage_state():
    manager = PlaywrightManager()
    cookie = "sessionid=first"
    profile = await manager.register_account(cookie)
    context = _PersistentContext()
    session = _session(cookie, profile["profile_id"], object(), context=context)
    manager.sessions[profile["profile_id"]] = session

    await manager._close_session_locked(session, remove=True)

    storage_path = (
        Path(settings.DOUBAO_BROWSER_PROFILE_DIR)
        / profile["profile_id"]
        / "storage-state.json"
    )
    assert storage_path.is_file()
    assert context.closed is True
    assert profile["profile_id"] not in manager.sessions


@pytest.mark.asyncio
async def test_idle_browser_shutdown_stops_driver_after_last_session_closes():
    manager = PlaywrightManager()
    cookie = "sessionid=first"
    profile = await manager.register_account(cookie)
    context = _PersistentContext()
    session = _session(cookie, profile["profile_id"], object(), context=context)
    browser = _ClosableBrowser()
    playwright = _StoppablePlaywright()
    manager.sessions[profile["profile_id"]] = session
    manager.browser = browser
    manager.playwright = playwright
    manager._initialized = True
    manager._browser_started = True
    manager.browser_idle_shutdown_seconds = 0

    await manager._close_session_locked(session, remove=True)
    for _ in range(10):
        if not manager._browser_started:
            break
        await asyncio.sleep(0.01)

    assert browser.closed is True
    assert playwright.stopped is True
    assert manager._browser_started is False
    assert manager.browser is None
    assert manager.playwright is None


@pytest.mark.asyncio
async def test_cleanup_identifies_stale_unlocked_in_use_session():
    manager = PlaywrightManager()
    stale_cookie = "sessionid=stale"
    locked_cookie = "sessionid=locked"
    idle_cookie = "sessionid=idle"
    stale_profile = await manager.register_account(stale_cookie)
    locked_profile = await manager.register_account(locked_cookie)
    idle_profile = await manager.register_account(idle_cookie)
    now = 1000.0
    manager.idle_timeout_seconds = 120
    manager.stale_session_seconds = 300

    stale_session = _session(stale_cookie, stale_profile["profile_id"], object())
    stale_session.in_use = 1
    stale_session.last_used_at = now - 301
    locked_session = _session(locked_cookie, locked_profile["profile_id"], object())
    locked_session.in_use = 1
    locked_session.last_used_at = now - 301
    await locked_session.lock.acquire()
    idle_session = _session(idle_cookie, idle_profile["profile_id"], object())
    idle_session.in_use = 0
    idle_session.last_used_at = now - 121
    manager.sessions = {
        stale_profile["profile_id"]: stale_session,
        locked_profile["profile_id"]: locked_session,
        idle_profile["profile_id"]: idle_session,
    }

    try:
        cleanup = manager._sessions_ready_for_cleanup_locked(now)
    finally:
        locked_session.lock.release()

    assert cleanup == [(stale_session, "stale_in_use"), (idle_session, "idle")]


@pytest.mark.asyncio
async def test_close_account_session_closes_only_idle_matching_profile():
    manager = PlaywrightManager()
    first = "sessionid=first"
    second = "sessionid=second"
    first_profile = await manager.register_account(first)
    second_profile = await manager.register_account(second)
    first_context = _PersistentContext()
    second_context = _PersistentContext()
    manager.sessions[first_profile["profile_id"]] = _session(
        first,
        first_profile["profile_id"],
        object(),
        context=first_context,
    )
    manager.sessions[second_profile["profile_id"]] = _session(
        second,
        second_profile["profile_id"],
        object(),
        context=second_context,
    )
    manager._initialized = True

    closed = await manager.close_account_session(first)

    assert closed is True
    assert first_context.closed is True
    assert second_context.closed is False
    assert first_profile["profile_id"] not in manager.sessions
    assert second_profile["profile_id"] in manager.sessions


@pytest.mark.asyncio
async def test_close_account_session_skips_in_use_profile():
    manager = PlaywrightManager()
    cookie = "sessionid=first"
    profile = await manager.register_account(cookie)
    context = _PersistentContext()
    session = _session(cookie, profile["profile_id"], object(), context=context)
    session.in_use = 1
    manager.sessions[profile["profile_id"]] = session
    manager._initialized = True

    closed = await manager.close_account_session(cookie)

    assert closed is False
    assert context.closed is False
    assert profile["profile_id"] in manager.sessions


class _EmptyLocator:
    @property
    def first(self):
        return self

    async def count(self):
        return 0

    async def is_visible(self):
        return False

    async def text_content(self):
        return ""

    def locator(self, selector):
        return self


class _EmptyFrame:
    def locator(self, selector):
        return _EmptyLocator()


class _BrowserPostPage:
    def __init__(self):
        self.arguments = []
        self.url = "https://www.doubao.com/chat/"

    async def evaluate(self, script, argument):
        self.arguments.append(argument)
        if isinstance(argument, str):
            return {"a_bogus": "signed-value"}
        return {
            "status_code": 200,
            "headers": {"content-type": "text/event-stream"},
            "text": "data: [DONE]",
            "url": argument["url"],
        }

    async def title(self):
        return "Doubao"

    def locator(self, selector):
        return _EmptyLocator()

    def frame_locator(self, selector):
        return _EmptyFrame()

    async def screenshot(self, path, full_page=False):
        Path(path).write_bytes(b"fake")


@pytest.mark.asyncio
async def test_browser_post_removes_headers_owned_by_browser():
    manager = PlaywrightManager()
    cookie = "sessionid=first"
    profile = await manager.register_account(cookie)
    page = _BrowserPostPage()
    manager.sessions[profile["profile_id"]] = _session(
        cookie,
        profile["profile_id"],
        page,
        frontier=True,
    )
    manager._initialized = True

    result = await manager.post_json(
        "https://www.doubao.com/chat/completion",
        cookie,
        {"aid": "497858"},
        {"prompt": "test"},
        headers={
            "Content-Type": "application/json",
            "Cookie": "sessionid=first",
            "User-Agent": "fake",
            "sec-ch-ua": "fake",
            "agw-js-conv": "str, str",
        },
    )

    fetch_args = page.arguments[-1]
    assert result["status_code"] == 200
    assert result["browser_trigger_context"]["visible_challenge_detected"] is False
    assert result["browser_trigger_context"]["request_url"].startswith("https://www.doubao.com/chat/completion?")
    assert "aid=497858" in fetch_args["url"]
    assert "a_bogus=" not in fetch_args["url"]
    assert fetch_args["headers"] == {
        "Content-Type": "application/json",
        "agw-js-conv": "str, str",
    }
