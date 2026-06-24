import asyncio
import os
import re
import time
from contextlib import suppress
from datetime import datetime, timedelta, timezone, tzinfo
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from loguru import logger

from app.core.config import normalize_doubao_cookie, settings
from app.services.credential_manager import CredentialManager, credential_identity
from app.services.playwright_manager import PlaywrightManager


CredentialManagerGetter = Callable[[], Optional[CredentialManager]]
CredentialManagerActivator = Callable[[CredentialManager], Awaitable[None]]
PlaywrightManagerGetter = Callable[[], Optional[PlaywrightManager]]

LOGIN_COOKIE_MARKERS = (
    "sessionid",
    "sessionid_ss",
    "sid_tt",
    "sid_guard",
    "uid_tt",
    "uid_tt_ss",
    "passport_user_id",
    "user_unique_id",
    "login_user_id",
)


def _env_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _env_unquote(value: str) -> str:
    text = str(value or "").strip()
    if len(text) >= 2 and text[0] == text[-1] == '"':
        text = text[1:-1]
        return text.replace('\\"', '"').replace("\\\\", "\\")
    return text


def _looks_like_logged_in_doubao_cookie(cookie: str) -> bool:
    lowered = str(cookie or "").lower()
    return any(f"{marker}=" in lowered for marker in LOGIN_COOKIE_MARKERS)


def looks_like_logged_in_doubao_cookie(cookie: str) -> bool:
    return _looks_like_logged_in_doubao_cookie(cookie)


class DoubaoCookieAutoRefresher:
    def __init__(
        self,
        *,
        credential_manager_getter: CredentialManagerGetter,
        credential_manager_activator: Optional[CredentialManagerActivator] = None,
        playwright_manager_getter: Optional[PlaywrightManagerGetter] = None,
    ) -> None:
        self._credential_manager_getter = credential_manager_getter
        self._credential_manager_activator = credential_manager_activator
        self._playwright_manager_getter = playwright_manager_getter
        self._task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()
        self._next_run_at: Optional[float] = None
        self._last_result: Optional[dict[str, Any]] = None
        self._last_error: Optional[str] = None

    async def start(self) -> None:
        if not settings.DOUBAO_COOKIE_AUTO_REFRESH_ENABLED:
            logger.info("Doubao cookie auto refresh is disabled.")
            return
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._run_loop())
        logger.info(
            "Doubao cookie auto refresh scheduled daily at "
            f"{settings.DOUBAO_COOKIE_AUTO_REFRESH_HOUR:02d}:"
            f"{settings.DOUBAO_COOKIE_AUTO_REFRESH_MINUTE:02d} "
            f"{settings.DOUBAO_COOKIE_AUTO_REFRESH_TIMEZONE}."
        )

    async def close(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task

    def status(self) -> dict[str, Any]:
        return {
            "enabled": bool(settings.DOUBAO_COOKIE_AUTO_REFRESH_ENABLED),
            "running": bool(self._task and not self._task.done()),
            "in_progress": self._lock.locked(),
            "timezone": settings.DOUBAO_COOKIE_AUTO_REFRESH_TIMEZONE,
            "scheduled_hour": settings.DOUBAO_COOKIE_AUTO_REFRESH_HOUR,
            "scheduled_minute": settings.DOUBAO_COOKIE_AUTO_REFRESH_MINUTE,
            "next_run_at": self._next_run_at,
            "last_error": self._last_error,
            "last_result": self._last_result,
        }

    async def refresh_all(self, *, reason: str = "manual", force: bool = False) -> dict[str, Any]:
        if not force and not settings.DOUBAO_COOKIE_AUTO_REFRESH_ENABLED:
            result = self._base_result(reason)
            result.update({"status": "disabled", "message": "Doubao cookie auto refresh is disabled."})
            self._last_result = result
            return result

        async with self._lock:
            result = self._base_result(reason)
            try:
                manager = self._resolve_credential_manager()
                if not manager:
                    result.update(
                        {
                            "status": "skipped",
                            "message": "No Doubao credentials are configured.",
                            "accounts": [],
                        }
                    )
                    return self._remember_result(result)

                if self._credential_manager_activator:
                    await self._credential_manager_activator(manager)

                account_snapshots = list((manager.snapshot().get("accounts") or []))
                if not account_snapshots:
                    result.update({"status": "skipped", "message": "Account pool is empty.", "accounts": []})
                    return self._remember_result(result)

                cookies_by_index: dict[int, str] = {}
                for account in account_snapshots:
                    index = int(account.get("index", -1))
                    if index < 0:
                        continue
                    cookies_by_index[index] = await manager.get_cookie(index)

                playwright = self._resolve_playwright_manager()
                await self._ensure_playwright_initialized(playwright, list(cookies_by_index.values()))

                account_results = []
                for account in account_snapshots:
                    index = int(account.get("index", -1))
                    cookie = cookies_by_index.get(index)
                    if index < 0 or not cookie:
                        continue
                    account_results.append(
                        await self._refresh_account(manager, playwright, account, cookie)
                    )

                updated = sum(1 for item in account_results if item.get("action") == "updated")
                unchanged = sum(1 for item in account_results if item.get("action") == "unchanged")
                failed = sum(1 for item in account_results if item.get("status") == "error")
                result.update(
                    {
                        "status": "ok" if failed == 0 else "partial",
                        "account_count": len(account_results),
                        "updated_count": updated,
                        "unchanged_count": unchanged,
                        "failed_count": failed,
                        "accounts": account_results,
                    }
                )
                if self._credential_manager_activator:
                    await self._credential_manager_activator(manager)
                return self._remember_result(result)
            except Exception as exc:
                result.update({"status": "error", "error": str(exc)})
                self._last_error = str(exc)
                self._last_result = result
                logger.error(f"Doubao cookie refresh failed: {exc}", exc_info=True)
                return result
            finally:
                result["finished_at"] = time.time()

    async def _run_loop(self) -> None:
        while True:
            next_run = self._next_run_datetime()
            self._next_run_at = next_run.timestamp()
            delay = max(1.0, self._next_run_at - time.time())
            try:
                await asyncio.sleep(delay)
                await self.refresh_all(reason="scheduled")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._last_error = str(exc)
                logger.warning(f"Scheduled Doubao cookie refresh failed: {exc}")
                await asyncio.sleep(60)

    def _next_run_datetime(self) -> datetime:
        tz = self._timezone()
        now = datetime.now(tz)
        target = now.replace(
            hour=settings.DOUBAO_COOKIE_AUTO_REFRESH_HOUR,
            minute=settings.DOUBAO_COOKIE_AUTO_REFRESH_MINUTE,
            second=0,
            microsecond=0,
        )
        if target <= now:
            target += timedelta(days=1)
        return target

    @staticmethod
    def _timezone() -> tzinfo:
        try:
            return ZoneInfo(settings.DOUBAO_COOKIE_AUTO_REFRESH_TIMEZONE or "Asia/Shanghai")
        except ZoneInfoNotFoundError:
            if (settings.DOUBAO_COOKIE_AUTO_REFRESH_TIMEZONE or "").lower() in {
                "asia/shanghai",
                "prc",
                "cst",
            }:
                logger.warning("Asia/Shanghai timezone data is missing; using fixed UTC+08:00.")
                return timezone(timedelta(hours=8), "Asia/Shanghai")
            logger.warning(
                "Invalid DOUBAO_COOKIE_AUTO_REFRESH_TIMEZONE="
                f"{settings.DOUBAO_COOKIE_AUTO_REFRESH_TIMEZONE!r}; falling back to UTC."
            )
            return timezone.utc

    def _resolve_credential_manager(self) -> Optional[CredentialManager]:
        manager = self._credential_manager_getter()
        if manager:
            return manager
        if settings.DOUBAO_COOKIES:
            return CredentialManager.from_settings()
        return None

    def _resolve_playwright_manager(self) -> PlaywrightManager:
        if self._playwright_manager_getter:
            manager = self._playwright_manager_getter()
            if manager:
                return manager
        return PlaywrightManager()

    async def _ensure_playwright_initialized(self, playwright: PlaywrightManager, cookies: list[str]) -> None:
        active_cookies = [normalize_doubao_cookie(cookie) for cookie in cookies if normalize_doubao_cookie(cookie)]
        if not active_cookies:
            raise RuntimeError("No Doubao cookies are available for browser refresh.")
        if not getattr(playwright, "_initialized", False):
            await playwright.initialize(active_cookies)

    async def _refresh_account(
        self,
        manager: CredentialManager,
        playwright: PlaywrightManager,
        account: dict[str, Any],
        old_cookie: str,
    ) -> dict[str, Any]:
        index = int(account.get("index", -1))
        fingerprint = account.get("fingerprint")
        result: dict[str, Any] = {
            "index": index,
            "fingerprint": fingerprint,
            "status": "ok",
            "action": "unchanged",
        }
        try:
            fresh_cookie = normalize_doubao_cookie(
                await playwright.refresh_account_cookie_header(
                    old_cookie,
                    settle_seconds=settings.DOUBAO_COOKIE_AUTO_REFRESH_SETTLE_SECONDS,
                    timeout_seconds=settings.DOUBAO_COOKIE_AUTO_REFRESH_TIMEOUT_SECONDS,
                )
            )
            if not fresh_cookie:
                raise RuntimeError("Browser did not return any Doubao cookies.")
            if not _looks_like_logged_in_doubao_cookie(fresh_cookie):
                raise RuntimeError("Browser cookies do not contain a logged-in Doubao session.")

            old_normalized = normalize_doubao_cookie(old_cookie)
            result["cookie_length"] = len(fresh_cookie)
            if fresh_cookie == old_normalized:
                return result

            await manager.update_account_cookie(index, fresh_cookie)
            await playwright.register_account(fresh_cookie)
            with suppress(Exception):
                await playwright.close_account_session(old_normalized)

            env_index = None
            if settings.DOUBAO_COOKIE_AUTO_REFRESH_PERSIST:
                env_index = self._replace_or_append_env_cookie(old_normalized, fresh_cookie, account)
            self._replace_settings_cookie(old_normalized, fresh_cookie)

            result.update({"action": "updated", "env_index": env_index})
            logger.info(
                "Refreshed Doubao cookie for credential "
                f"index={index}, fingerprint={fingerprint}, env_index={env_index}."
            )
            return result
        except Exception as exc:
            result.update({"status": "error", "error": str(exc)})
            logger.warning(f"Doubao cookie refresh failed for index={index}, fingerprint={fingerprint}: {exc}")
            return result

    def _replace_settings_cookie(self, old_cookie: str, new_cookie: str) -> Optional[int]:
        old_identity = credential_identity(old_cookie)
        for index, cookie in enumerate(settings.DOUBAO_COOKIES):
            if credential_identity(cookie) == old_identity:
                settings.DOUBAO_COOKIES[index] = new_cookie
                return index
        return None

    def _replace_or_append_env_cookie(
        self,
        old_cookie: str,
        new_cookie: str,
        account: dict[str, Any],
    ) -> int:
        env_path = Path(".env")
        text = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
        old_identity = credential_identity(old_cookie)
        new_identity = credential_identity(new_cookie)
        lines = text.splitlines(keepends=True)
        cookie_line_re = re.compile(r"^(\s*DOUBAO_COOKIE_(\d+)\s*=\s*)(.*?)(\r?\n)?$")
        existing_new_index: Optional[int] = None

        for line_number, line in enumerate(lines):
            match = cookie_line_re.match(line)
            if not match:
                continue
            line_identity = credential_identity(_env_unquote(match.group(3)))
            if line_identity == new_identity:
                existing_new_index = int(match.group(2))
            if line_identity != old_identity:
                continue
            lines[line_number] = f"{match.group(1)}{_env_quote(new_cookie)}{match.group(4) or ''}"
            env_path.write_text("".join(lines), encoding="utf-8")
            return int(match.group(2))

        if existing_new_index is not None:
            return existing_new_index
        return self._append_env_cookie(env_path, text, new_cookie, account)

    def _append_env_cookie(
        self,
        env_path: Path,
        text: str,
        cookie: str,
        account: dict[str, Any],
    ) -> int:
        used_indexes = {
            int(match.group(1))
            for match in re.finditer(r"(?m)^\s*DOUBAO_COOKIE_(\d+)\s*=", text)
        }
        index = 1
        while index in used_indexes or os.getenv(f"DOUBAO_COOKIE_{index}"):
            index += 1

        disabled = str(account.get("status") or "").lower() in {"disabled", "login_required"}
        weight = max(1, int(account.get("weight") or settings.DOUBAO_ACCOUNT_DEFAULT_WEIGHT))
        max_concurrency = max(
            1,
            int(account.get("max_concurrency") or settings.DOUBAO_ACCOUNT_MAX_CONCURRENCY),
        )
        prefix = "" if not text or text.endswith(("\n", "\r")) else "\n"
        block = "\n".join(
            [
                f"DOUBAO_COOKIE_{index}={_env_quote(cookie)}",
                f"DOUBAO_COOKIE_WEIGHT_{index}={weight}",
                f"DOUBAO_COOKIE_MAX_CONCURRENCY_{index}={max_concurrency}",
                f"DOUBAO_COOKIE_DISABLED_{index}={'true' if disabled else 'false'}",
                "",
            ]
        )
        env_path.write_text(f"{text}{prefix}{block}", encoding="utf-8")
        return index

    def _base_result(self, reason: str) -> dict[str, Any]:
        return {
            "object": "doubao_cookie_refresh",
            "reason": reason,
            "started_at": time.time(),
            "timezone": settings.DOUBAO_COOKIE_AUTO_REFRESH_TIMEZONE,
            "scheduled_hour": settings.DOUBAO_COOKIE_AUTO_REFRESH_HOUR,
            "scheduled_minute": settings.DOUBAO_COOKIE_AUTO_REFRESH_MINUTE,
        }

    def _remember_result(self, result: dict[str, Any]) -> dict[str, Any]:
        result.setdefault("finished_at", time.time())
        self._last_error = result.get("error")
        self._last_result = result
        return result
