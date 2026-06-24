import asyncio
import hashlib
import json
import re
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional
from urllib.parse import unquote

from loguru import logger

from app.core.config import normalize_doubao_cookie, settings


PRIMARY_COOKIE_IDENTITY_KEYS = ("sessionid", "sessionid_ss", "sid_tt", "sid_guard")
SECONDARY_COOKIE_IDENTITY_KEYS = ("uid_tt", "uid_tt_ss", "passport_user_id", "user_unique_id", "login_user_id")
VOLATILE_COOKIE_KEYS = {
    "mstoken",
    "msToken".lower(),
    "s_v_web_id",
    "web_id",
    "tea_uuid",
    "ttwid",
}
LOGIN_EXPIRED_MARKERS = (
    "x-tt-agw-login=0",
    "did not recognize the request as logged in",
    "refresh doubao_cookie",
    "login invalid",
    "login expired",
    "not logged in",
    "not login",
    "session expired",
    "unauthorized",
    "http 401",
    "status 401",
    "auth expired",
    "authentication expired",
    "登录态已失效",
    "登录已过期",
    "请重新登录",
    "未登录",
)
QUOTA_EXHAUSTED_MARKERS = (
    "quota exhausted",
    "quota is exhausted",
    "insufficient quota",
    "daily limit",
    "generation limit",
    "daily generation limit",
    "free generation limit",
    "insufficient credits",
    "not enough credits",
    "credit exhausted",
    "credits exhausted",
    "balance exhausted",
    "balance is insufficient",
    "no credit",
    "no credits",
    "\u751f\u6210\u6b21\u6570\u5df2\u7ecf\u8fbe\u5230\u4e0a\u9650",
    "\u751f\u6210\u6b21\u6570\u5df2\u8fbe\u5230\u4e0a\u9650",
    "\u4eca\u5929\u7684\u751f\u6210\u6b21\u6570\u5df2\u7ecf\u8fbe\u5230\u4e0a\u9650",
    "\u4eca\u65e5\u751f\u6210\u6b21\u6570\u5df2\u7ecf\u8fbe\u5230\u4e0a\u9650",
    "\u660e\u5929\u518d\u6765\u514d\u8d39\u751f\u6210",
    "额度不足",
    "额度已用完",
    "额度耗尽",
    "没有额度",
    "无可用额度",
    "余额不足",
    "点数不足",
    "生成次数已经达到上限",
    "生成次数已达到上限",
    "今天的生成次数已经达到上限",
    "今日生成次数已经达到上限",
    "明天再来免费生成",
    "剩余 0",
    "剩余0",
)
QUOTA_FAILURE_CONTEXT_MARKERS = (
    "quota",
    "credit",
    "balance",
    "generation",
    "额度",
    "余额",
    "点数",
    "生成次数",
)
CURRENT_TASK_QUOTA_PROGRESS_MARKERS = (
    "\u5c06\u6d88\u8017",
    "\u9884\u8ba1\u7b49\u5f85",
    "\u89c6\u9891\u751f\u6210\u597d\u540e",
    "\u8fd9\u5c31\u4e3a\u60a8\u751f\u6210\u89c6\u9891",
    "\u8bf7\u7a0d\u7b49",
    "\u53ca\u65f6\u901a\u77e5",
    "\u4eca\u65e5\u5269\u4f59",
    "will consume",
    "please wait",
)
QUOTA_EXPLICIT_FAILURE_MARKERS = (
    "insufficient",
    "exhausted",
    "not enough",
    "limit reached",
    "daily limit",
    "generation limit",
    "\u65e0\u6cd5\u751f\u6210",
    "\u4e0d\u80fd\u751f\u6210",
    "\u4e0d\u8db3",
    "\u8fbe\u5230\u4e0a\u9650",
    "\u5df2\u7ecf\u8fbe\u5230\u4e0a\u9650",
    "\u5df2\u8fbe\u5230\u4e0a\u9650",
)
VERIFICATION_REQUIRED_MARKERS = (
    "710022004",
    "verify_scene",
    "browser verification",
    "requires browser verification",
    "rate limited",
    "doubao_message_web",
)
QUOTA_ZERO_RE = re.compile(
    r"(?:remaining|remain|balance|credit|credits|quota|剩余|可用|余额|额度|点数)[^0-9]{0,24}0(?:\.0+)?\b",
    re.I,
)
VIDEO_QUOTA_RESET_UTC_OFFSET_SECONDS = 8 * 60 * 60
NON_BLOCKING_QUOTA_STATUSES = {"unknown", "unsupported", "error", "reported"}
ADVISORY_QUOTA_SOURCES = {"benefit_credit_advisory"}
LEGACY_ADVISORY_QUOTA_ERRORS = {"Doubao quota remaining is 0."}
VIDEO_HISTORY_NO_SIGNAL_MARKER = "No current-day video quota signal"


def video_quota_day(timestamp: float) -> int:
    return int((float(timestamp) + VIDEO_QUOTA_RESET_UTC_OFFSET_SECONDS) // 86400)


def next_video_quota_reset_at(timestamp: Optional[float] = None) -> float:
    now = time.time() if timestamp is None else float(timestamp)
    return float((video_quota_day(now) + 1) * 86400 - VIDEO_QUOTA_RESET_UTC_OFFSET_SECONDS)


def _cookie_pairs(cookie: str) -> Dict[str, str]:
    pairs: Dict[str, str] = {}
    for item in (cookie or "").split(";"):
        if "=" not in item:
            continue
        key, value = item.split("=", 1)
        key = key.strip().lower()
        value = value.strip().strip('"')
        if key:
            pairs[key] = unquote(value)
    return pairs


def credential_identity(credential: str) -> str:
    text = (credential or "").strip()
    if not text:
        return ""

    if text.lower().startswith("bearer "):
        return f"bearer:{text[7:].strip()}"

    pairs = _cookie_pairs(text)
    if not pairs:
        return f"raw:{text}"

    for key in PRIMARY_COOKIE_IDENTITY_KEYS:
        value = pairs.get(key)
        if value:
            return f"cookie:{key}={value}"

    secondary = [(key, pairs[key]) for key in SECONDARY_COOKIE_IDENTITY_KEYS if pairs.get(key)]
    if secondary:
        return "cookie:" + "|".join(f"{key}={value}" for key, value in secondary)

    stable_pairs = [
        (key, value)
        for key, value in sorted(pairs.items())
        if key not in VOLATILE_COOKIE_KEYS and value
    ]
    if stable_pairs:
        return "cookie:" + "|".join(f"{key}={value}" for key, value in stable_pairs)

    return f"raw:{text}"


def is_login_expired_error(exc_or_text: Optional[object]) -> bool:
    text = _error_text(exc_or_text)
    if not text:
        return False
    lowered = text.lower()
    return any(marker in lowered for marker in LOGIN_EXPIRED_MARKERS)


def is_quota_exhausted_error(exc_or_text: Optional[object]) -> bool:
    text = _error_text(exc_or_text)
    if not text:
        return False
    lowered = text.lower()
    if is_current_task_quota_progress_text(text):
        return False
    if any(marker in lowered for marker in QUOTA_EXHAUSTED_MARKERS):
        return True
    if any(marker in lowered for marker in QUOTA_FAILURE_CONTEXT_MARKERS) and (
        "insufficient" in lowered
        or "exhausted" in lowered
        or "not enough" in lowered
        or "无法生成" in lowered
        or "不能生成" in lowered
        or "达到上限" in lowered
        or "limit reached" in lowered
    ):
        return True
    return bool(QUOTA_ZERO_RE.search(text))


def is_current_task_quota_progress_text(exc_or_text: Optional[object]) -> bool:
    text = _error_text(exc_or_text)
    if not text:
        return False
    lowered = text.lower()
    has_progress = any(marker in lowered or marker in text for marker in CURRENT_TASK_QUOTA_PROGRESS_MARKERS)
    if not has_progress:
        return False
    return not any(marker in lowered or marker in text for marker in QUOTA_EXPLICIT_FAILURE_MARKERS)


def is_verification_required_error(exc_or_text: Optional[object]) -> bool:
    text = _error_text(exc_or_text)
    if not text:
        return False
    lowered = text.lower()
    return any(marker in lowered for marker in VERIFICATION_REQUIRED_MARKERS)


def _error_text(exc_or_text: Optional[object]) -> str:
    if exc_or_text is None:
        return ""
    if isinstance(exc_or_text, BaseException):
        text = str(exc_or_text)
        cause = getattr(exc_or_text, "__cause__", None)
        context = getattr(exc_or_text, "__context__", None)
        if cause:
            text = f"{text} {cause}"
        if context and context is not cause:
            text = f"{text} {context}"
        return text
    return str(exc_or_text)


def _verification_context(exc_or_text: Optional[object]) -> Optional[Dict[str, Any]]:
    if not isinstance(exc_or_text, BaseException):
        return None
    context = getattr(exc_or_text, "verification_context", None)
    if not isinstance(context, dict):
        return None
    cleaned: Dict[str, Any] = {}
    for key, value in context.items():
        if value is None:
            continue
        text = str(value)
        cleaned[str(key)] = text[:2000]
    return cleaned or None


@dataclass
class CredentialState:
    index: int
    cookie: str
    weight: int = 1
    max_concurrency: int = 1
    disabled: bool = False
    disabled_reason: Optional[str] = None
    in_flight: int = 0
    success_count: int = 0
    failure_count: int = 0
    consecutive_failures: int = 0
    cooldown_until: float = 0
    last_used_at: Optional[float] = None
    last_success_at: Optional[float] = None
    last_failure_at: Optional[float] = None
    last_error: Optional[str] = None
    quota_total: Optional[float] = None
    quota_remaining: Optional[float] = None
    quota_used: Optional[float] = None
    quota_unit: str = field(default_factory=lambda: settings.DOUBAO_QUOTA_UNIT)
    quota_source: Optional[str] = None
    quota_updated_at: Optional[float] = None
    quota_reset_at: Optional[float] = None
    quota_status: str = "unknown"
    last_quota_delta: Optional[float] = None
    last_quota_error: Optional[str] = None
    verification_required: bool = False
    verification_required_at: Optional[float] = None
    verification_error: Optional[str] = None
    verification_context: Optional[Dict[str, Any]] = None
    fingerprint: str = field(init=False)

    def __post_init__(self) -> None:
        self.weight = max(1, int(self.weight or 1))
        self.max_concurrency = max(1, int(self.max_concurrency or 1))
        self.fingerprint = hashlib.sha256(credential_identity(self.cookie).encode("utf-8")).hexdigest()[:12]

    @property
    def available_capacity(self) -> int:
        return max(self.max_concurrency - self.in_flight, 0)

    def is_available(self, now: Optional[float] = None) -> bool:
        now = time.monotonic() if now is None else now
        return (
            not self.disabled
            and not self.verification_required
            and self.quota_allows_use()
            and self.cooldown_until <= now
            and self.available_capacity > 0
        )

    def quota_allows_use(self, required: float = 0) -> bool:
        required = max(0.0, float(required or 0))
        if self.quota_status == "exhausted":
            return False
        if required > 0:
            return (
                self.quota_status in {"available", "estimated"}
                and self.quota_remaining is not None
                and self.quota_remaining >= required
            )
        if self.quota_status in NON_BLOCKING_QUOTA_STATUSES:
            return True
        if self.quota_remaining is None:
            return True
        return self.quota_remaining > 0

    def quota_allows_provisional_video_use(self, required: float = 0, now: Optional[float] = None) -> bool:
        required = max(0.0, float(required or 0))
        if required <= 0:
            return self.quota_allows_use(required)
        if self.quota_source != "video_history":
            return False
        quota_error = str(self.last_quota_error or "")
        if self.quota_status == "unknown":
            expected_error = VIDEO_HISTORY_NO_SIGNAL_MARKER in quota_error
        elif self.quota_status == "pending_refresh":
            expected_error = "timed out" in quota_error.lower()
        else:
            return False
        if not expected_error:
            return False
        if self.quota_updated_at is None:
            return False
        try:
            return video_quota_day(float(self.quota_updated_at)) == video_quota_day(time.time() if now is None else now)
        except (TypeError, ValueError):
            return False

    def public_snapshot(self) -> Dict[str, object]:
        now = time.monotonic()
        wall_now = time.time()
        cooldown_remaining = max(0, self.cooldown_until - now)
        quota_reset_remaining = (
            max(0.0, float(self.quota_reset_at) - wall_now)
            if self.quota_reset_at is not None
            else None
        )
        if self.disabled and self.disabled_reason == "login_expired":
            status = "login_required"
        elif self.disabled:
            status = "disabled"
        elif not self.quota_allows_use():
            status = "quota_exhausted"
        elif self.verification_required:
            status = "verification_required"
        elif cooldown_remaining > 0:
            status = "cooling_down"
        elif self.available_capacity <= 0:
            status = "busy"
        else:
            status = "available"

        return {
            "index": self.index,
            "fingerprint": self.fingerprint,
            "status": status,
            "disabled_reason": self.disabled_reason,
            "weight": self.weight,
            "max_concurrency": self.max_concurrency,
            "in_flight": self.in_flight,
            "success_count": self.success_count,
            "failure_count": self.failure_count,
            "consecutive_failures": self.consecutive_failures,
            "cooldown_remaining_seconds": round(cooldown_remaining, 3),
            "last_used_at": self.last_used_at,
            "last_success_at": self.last_success_at,
            "last_failure_at": self.last_failure_at,
            "last_error": self.last_error,
            "requires_verification": self.verification_required,
            "verification_required_at": self.verification_required_at,
            "verification_error": self.verification_error,
            "verification_context": self.verification_context,
            "quota": {
                "total": self.quota_total,
                "remaining": self.quota_remaining,
                "used": self.quota_used,
                "unit": self.quota_unit,
                "source": self.quota_source,
                "updated_at": self.quota_updated_at,
                "reset_at": self.quota_reset_at,
                "reset_remaining_seconds": (
                    round(quota_reset_remaining, 3)
                    if quota_reset_remaining is not None
                    else None
                ),
                "status": self.quota_status,
                "last_delta": self.last_quota_delta,
                "last_error": self.last_quota_error,
                "video_eligible": self.quota_allows_use(1),
            },
        }


@dataclass
class CredentialLease:
    manager: "CredentialManager"
    state: CredentialState
    released: bool = False
    failed: bool = False
    neutral: bool = False

    @property
    def cookie(self) -> str:
        return self.state.cookie

    @property
    def index(self) -> int:
        return self.state.index

    @property
    def fingerprint(self) -> str:
        return self.state.fingerprint

    def mark_success(self) -> None:
        if not self.released and not self.failed and not self.neutral:
            self.manager.report_success(self.state.index)

    def mark_neutral(self) -> None:
        if not self.released and not self.failed:
            self.neutral = True

    def mark_failure(self, exc: Optional[BaseException] = None) -> None:
        if not self.released and not self.failed:
            self.failed = True
            self.manager.report_failure(self.state.index, exc)

    async def __aenter__(self) -> "CredentialLease":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if exc is not None and not self.failed:
            self.mark_failure(exc)
        await self.release()

    async def release(self) -> None:
        if not self.released:
            self.released = True
            await self.manager.release(self.state.index)


class CredentialManager:
    _shared: Optional["CredentialManager"] = None
    _shared_key: Optional[tuple] = None

    def __init__(
        self,
        credentials: List[str],
        weights: Optional[List[int]] = None,
        max_concurrency: Optional[List[int]] = None,
        disabled: Optional[List[bool]] = None,
        global_concurrency: int = 0,
        failure_threshold: int = 3,
        cooldown_seconds: float = 300,
        acquire_timeout: float = 30,
    ):
        if not credentials:
            raise ValueError("credential list cannot be empty.")

        self.credentials: List[str] = []
        self.failure_threshold = max(1, int(failure_threshold or 1))
        self.cooldown_seconds = max(0.0, float(cooldown_seconds or 0))
        self.acquire_timeout = max(0.1, float(acquire_timeout or 30))
        self.global_concurrency = max(0, int(global_concurrency or 0))
        self.global_in_flight = 0
        self._cursor = 0
        self._condition = asyncio.Condition()
        self._legacy_lock = None
        self._disabled_store_path = Path(settings.DOUBAO_DISABLED_CREDENTIAL_STORE_PATH)
        self._quota_store_path = Path(settings.DOUBAO_VIDEO_QUOTA_STORE_PATH)
        persisted_disabled = self._load_persisted_disabled()
        persisted_quotas = self._load_persisted_quotas()

        weights = weights or []
        max_concurrency = max_concurrency or []
        disabled = disabled or []
        self._identity_indexes: Dict[str, int] = {}
        self._states: List[CredentialState] = []
        for source_index, raw_cookie in enumerate(credentials):
            cookie = normalize_doubao_cookie(raw_cookie)
            if not cookie:
                continue
            identity = credential_identity(cookie)
            if identity in self._identity_indexes:
                logger.warning(
                    "Duplicate credential skipped: "
                    f"source_index={source_index}, existing_index={self._identity_indexes[identity]}"
                )
                continue

            index = len(self._states)
            disabled_from_config = disabled[source_index] if source_index < len(disabled) else False
            disabled_record = persisted_disabled.get(identity)
            if disabled_record and self._persisted_quota_disable_expired(disabled_record):
                persisted_disabled.pop(identity, None)
                disabled_record = None
            state = CredentialState(
                index=index,
                cookie=cookie,
                weight=weights[source_index] if source_index < len(weights) else settings.DOUBAO_ACCOUNT_DEFAULT_WEIGHT,
                max_concurrency=(
                    max_concurrency[source_index]
                    if source_index < len(max_concurrency)
                    else settings.DOUBAO_ACCOUNT_MAX_CONCURRENCY
                ),
                disabled=disabled_from_config or identity in persisted_disabled,
            )
            if disabled_record:
                state.disabled_reason = str(disabled_record.get("reason") or "manual")
                state.last_error = disabled_record.get("error")
                if disabled_record.get("reason") == "quota_exhausted":
                    state.quota_status = "exhausted"
                    state.quota_remaining = 0
                    state.quota_updated_at = disabled_record.get("disabled_at")
                    state.quota_reset_at = self._number_or_none(disabled_record.get("reset_at")) or (
                        next_video_quota_reset_at(state.quota_updated_at)
                        if state.quota_updated_at is not None
                        else next_video_quota_reset_at()
                    )
                    state.last_quota_error = disabled_record.get("error")
            elif disabled_from_config:
                state.disabled_reason = "manual"
            quota_record = persisted_quotas.get(identity)
            if quota_record and self._persisted_quota_expired(quota_record):
                persisted_quotas.pop(identity, None)
                quota_record = None
            if quota_record and not (
                disabled_record and disabled_record.get("reason") == "quota_exhausted"
            ):
                state.quota_total = self._number_or_none(quota_record.get("total"))
                state.quota_remaining = self._number_or_none(quota_record.get("remaining"))
                state.quota_used = self._number_or_none(quota_record.get("used"))
                state.quota_unit = str(quota_record.get("unit") or state.quota_unit)
                state.quota_source = str(quota_record.get("source") or "persisted")
                state.quota_updated_at = self._number_or_none(quota_record.get("updated_at"))
                state.quota_reset_at = self._number_or_none(quota_record.get("reset_at"))
                state.quota_status = str(quota_record.get("status") or "unknown")
                if state.quota_status == "exhausted" and state.quota_reset_at is None:
                    state.quota_reset_at = next_video_quota_reset_at(state.quota_updated_at)
                state.last_quota_delta = self._number_or_none(quota_record.get("last_delta"))
                state.last_quota_error = quota_record.get("error")
            self.credentials.append(cookie)
            self._states.append(state)
            self._identity_indexes[identity] = index

        if not self._states:
            raise ValueError("credential list cannot be empty.")

        self._weighted_indexes = [
            state.index
            for state in self._states
            for _ in range(state.weight)
        ]
        self._save_persisted_disabled(persisted_disabled)
        self._save_persisted_quotas(persisted_quotas)

        logger.info(
            "Credential manager initialized: "
            f"accounts={len(self._states)}, source_credentials={len(credentials)}, "
            f"global_concurrency={self.global_concurrency or 'unlimited'}, "
            f"failure_threshold={self.failure_threshold}, cooldown_seconds={self.cooldown_seconds}"
        )

    @property
    def active_credentials(self) -> List[str]:
        self._reset_expired_video_quotas_locked()
        active = [state.cookie for state in self._states if not state.disabled and state.quota_allows_use()]
        return active or list(self.credentials)

    @classmethod
    def from_settings(cls) -> "CredentialManager":
        return cls(
            credentials=settings.DOUBAO_COOKIES,
            weights=settings.DOUBAO_COOKIE_WEIGHTS,
            max_concurrency=settings.DOUBAO_COOKIE_MAX_CONCURRENCY,
            disabled=settings.DOUBAO_COOKIE_DISABLED,
            global_concurrency=settings.DOUBAO_ACCOUNT_GLOBAL_CONCURRENCY,
            failure_threshold=settings.DOUBAO_ACCOUNT_FAILURE_THRESHOLD,
            cooldown_seconds=settings.DOUBAO_ACCOUNT_COOLDOWN_SECONDS,
            acquire_timeout=settings.DOUBAO_ACCOUNT_ACQUIRE_TIMEOUT,
        )

    @classmethod
    def shared(cls) -> "CredentialManager":
        key = (
            tuple(settings.DOUBAO_COOKIES),
            tuple(settings.DOUBAO_COOKIE_WEIGHTS),
            tuple(settings.DOUBAO_COOKIE_MAX_CONCURRENCY),
            tuple(settings.DOUBAO_COOKIE_DISABLED),
            settings.DOUBAO_ACCOUNT_GLOBAL_CONCURRENCY,
            settings.DOUBAO_ACCOUNT_FAILURE_THRESHOLD,
            settings.DOUBAO_ACCOUNT_COOLDOWN_SECONDS,
            settings.DOUBAO_ACCOUNT_ACQUIRE_TIMEOUT,
        )
        if cls._shared is None or cls._shared_key != key:
            cls._shared = cls.from_settings()
            cls._shared_key = key
        return cls._shared

    async def acquire_lease(self, timeout: Optional[float] = None) -> CredentialLease:
        return await self.acquire_lease_for_quota(0, timeout=timeout)

    async def acquire_lease_for_quota(
        self,
        required_quota: float = 0,
        timeout: Optional[float] = None,
        allow_unknown: bool = False,
    ) -> CredentialLease:
        timeout = self.acquire_timeout if timeout is None else max(0.1, timeout)
        deadline = time.monotonic() + timeout
        required_quota = max(0.0, float(required_quota or 0))

        async with self._condition:
            self._reset_expired_video_quotas_locked()
            while True:
                state = self._select_available_locked(
                    required_quota=required_quota,
                    allow_unknown=allow_unknown,
                )
                if state:
                    state.in_flight += 1
                    state.last_used_at = time.time()
                    self.global_in_flight += 1
                    logger.debug(
                        f"Acquired credential index={state.index} fingerprint={state.fingerprint} "
                        f"in_flight={state.in_flight}/{state.max_concurrency}"
                    )
                    return CredentialLease(self, state)

                if required_quota > 0 and not any(
                    not state.disabled
                    and self._quota_allows_acquire_locked(
                        state,
                        required_quota=required_quota,
                        allow_unknown=allow_unknown,
                    )
                    for state in self._states
                ):
                    raise TimeoutError(
                        "No Doubao account has confirmed enough video quota. "
                        "Refresh account video quota before submitting a video task."
                    )

                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(
                        "No available Doubao credential. All accounts are busy, disabled, cooling down, or short on video quota."
                    )
                delay = self._next_ready_delay_locked()
                wait_time = remaining if delay is None else min(remaining, delay)
                try:
                    await asyncio.wait_for(self._condition.wait(), timeout=wait_time)
                except asyncio.TimeoutError:
                    if time.monotonic() < deadline:
                        continue
                    raise TimeoutError(
                        "No available Doubao credential. All accounts are busy, disabled, cooling down, or short on video quota."
                    ) from None

    @asynccontextmanager
    async def acquire(self, timeout: Optional[float] = None) -> AsyncIterator[CredentialLease]:
        lease = await self.acquire_lease(timeout)
        try:
            yield lease
        except Exception as exc:
            lease.mark_failure(exc)
            raise
        else:
            lease.mark_success()
        finally:
            await lease.release()

    @asynccontextmanager
    async def acquire_for_quota(
        self,
        required_quota: float = 0,
        timeout: Optional[float] = None,
        allow_unknown: bool = False,
    ) -> AsyncIterator[CredentialLease]:
        lease = await self.acquire_lease_for_quota(
            required_quota,
            timeout=timeout,
            allow_unknown=allow_unknown,
        )
        try:
            yield lease
        except Exception as exc:
            lease.mark_failure(exc)
            raise
        else:
            lease.mark_success()
        finally:
            await lease.release()

    async def release(self, index: int) -> None:
        async with self._condition:
            state = self._states[index]
            state.in_flight = max(0, state.in_flight - 1)
            self.global_in_flight = max(0, self.global_in_flight - 1)
            self._condition.notify_all()

    def report_success(self, index: int) -> None:
        state = self._states[index]
        state.success_count += 1
        state.consecutive_failures = 0
        state.last_success_at = time.time()
        state.last_error = None
        state.verification_required = False
        state.verification_required_at = None
        state.verification_error = None
        state.verification_context = None

    def report_failure(self, index: int, exc: Optional[BaseException] = None) -> None:
        state = self._states[index]
        error_text = _error_text(exc)
        verification_context = _verification_context(exc)
        login_expired = is_login_expired_error(error_text)
        quota_exhausted = is_quota_exhausted_error(error_text)
        verification_required = is_verification_required_error(error_text)
        state.failure_count += 1
        state.consecutive_failures += 1
        state.last_failure_at = time.time()
        state.last_error = error_text or None
        if login_expired or quota_exhausted:
            reason = "login_expired" if login_expired else "quota_exhausted"
            if quota_exhausted:
                state.quota_source = "upstream_error"
            self._disable_state_for_hard_failure(state, reason, error_text)
            return
        if verification_required:
            state.verification_required = True
            state.verification_required_at = time.time()
            state.verification_error = error_text or None
            state.verification_context = verification_context
            state.cooldown_until = time.monotonic() + self.cooldown_seconds
            logger.warning(
                f"Credential index={state.index} fingerprint={state.fingerprint} requires manual "
                f"browser verification and entered cooldown for {self.cooldown_seconds}s."
            )
            return
        if state.consecutive_failures >= self.failure_threshold:
            state.cooldown_until = time.monotonic() + self.cooldown_seconds
            logger.warning(
                f"Credential index={state.index} fingerprint={state.fingerprint} entered cooldown "
                f"for {self.cooldown_seconds}s after {state.consecutive_failures} consecutive failures."
            )

    def disable(self, index: int) -> None:
        state = self._states[index]
        state.disabled = True
        self._persist_disabled_state(state, "manual", state.last_error)

    def enable(self, index: int) -> None:
        state = self._states[index]
        if not state.quota_allows_use():
            state.disabled = True
            self._persist_disabled_state(state, "quota_exhausted", state.last_quota_error)
            return
        state.disabled = False
        state.disabled_reason = None
        state.cooldown_until = 0
        state.consecutive_failures = 0
        state.verification_required = False
        state.verification_required_at = None
        state.verification_error = None
        state.verification_context = None
        self._remove_persisted_disabled(state)

    async def update_account(
        self,
        index: int,
        weight: Optional[int] = None,
        max_concurrency: Optional[int] = None,
        disabled: Optional[bool] = None,
    ) -> Dict[str, object]:
        async with self._condition:
            state = self._get_state(index)
            if weight is not None:
                state.weight = max(1, int(weight))
                self._rebuild_weighted_indexes()
            if max_concurrency is not None:
                state.max_concurrency = max(1, int(max_concurrency))
            if disabled is not None:
                state.disabled = bool(disabled)
                if not state.disabled:
                    if state.quota_allows_use():
                        state.disabled_reason = None
                        state.cooldown_until = 0
                        state.verification_required = False
                        state.verification_required_at = None
                        state.verification_error = None
                        state.verification_context = None
                        self._remove_persisted_disabled(state)
                    else:
                        state.disabled = True
                        self._persist_disabled_state(state, "quota_exhausted", state.last_quota_error)
                else:
                    self._persist_disabled_state(state, "manual", state.last_error)
            self._condition.notify_all()
            return state.public_snapshot()

    async def disable_for_login_expired(self, index: int, error: str) -> Dict[str, object]:
        async with self._condition:
            state = self._get_state(index)
            self._record_failure_locked(state, error)
            self._disable_state_for_hard_failure(state, "login_expired", error)
            self._condition.notify_all()
            return state.public_snapshot()

    async def disable_for_quota_exhausted(
        self,
        index: int,
        error: str,
        *,
        source: Optional[str] = None,
    ) -> Dict[str, object]:
        async with self._condition:
            state = self._get_state(index)
            self._record_failure_locked(state, error)
            state.quota_remaining = 0
            state.quota_status = "exhausted"
            state.quota_source = source or state.quota_source
            state.quota_updated_at = time.time()
            state.last_quota_error = error
            self._disable_state_for_hard_failure(state, "quota_exhausted", error)
            self._persist_quota_state(state)
            self._condition.notify_all()
            return state.public_snapshot()

    async def reset_expired_video_quotas(self) -> List[int]:
        """Reset quota state when Doubao's Beijing-time daily quota rolls over."""
        async with self._condition:
            reset_indexes = self._reset_expired_video_quotas_locked()
            if reset_indexes:
                self._condition.notify_all()
        return reset_indexes

    async def add_account(
        self,
        cookie: str,
        weight: int = 1,
        max_concurrency: int = 1,
        disabled: bool = False,
    ) -> Dict[str, object]:
        cookie = normalize_doubao_cookie(cookie)
        if not cookie:
            raise ValueError("credential cookie cannot be empty.")
        if any(separator in cookie for separator in ("\r", "\n")):
            raise ValueError("credential cookie cannot contain line breaks.")

        async with self._condition:
            if self._credential_exists_locked(cookie):
                raise ValueError("credential cookie already exists.")

            index = len(self._states)
            state = CredentialState(
                index=index,
                cookie=cookie,
                weight=max(1, int(weight or 1)),
                max_concurrency=max(1, int(max_concurrency or 1)),
                disabled=bool(disabled),
            )
            self.credentials.append(cookie)
            self._states.append(state)
            self._identity_indexes[credential_identity(cookie)] = index
            if not state.disabled:
                self._remove_persisted_disabled(state)
            else:
                self._persist_disabled_state(state, "manual", state.last_error)
            self._rebuild_weighted_indexes()
            self._condition.notify_all()
            logger.info(f"Credential index={index} fingerprint={state.fingerprint} added to account pool.")
            return state.public_snapshot()

    async def update_account_cookie(self, index: int, cookie: str) -> Dict[str, object]:
        cookie = normalize_doubao_cookie(cookie)
        if not cookie:
            raise ValueError("credential cookie cannot be empty.")
        if any(separator in cookie for separator in ("\r", "\n")):
            raise ValueError("credential cookie cannot contain line breaks.")

        async with self._condition:
            state = self._get_state(index)
            old_identity = credential_identity(state.cookie)
            new_identity = credential_identity(cookie)
            existing_index = self._identity_indexes.get(new_identity)
            if existing_index is not None and existing_index != index:
                raise ValueError("credential cookie already exists.")

            state.cookie = cookie
            self.credentials[index] = cookie
            if old_identity != new_identity:
                self._identity_indexes.pop(old_identity, None)
                self._identity_indexes[new_identity] = index
            if state.disabled and state.disabled_reason == "login_expired" and state.quota_allows_use():
                state.disabled = False
                state.disabled_reason = None
                state.cooldown_until = 0
                state.consecutive_failures = 0
                state.last_error = None
                state.verification_required = False
                state.verification_required_at = None
                state.verification_error = None
                state.verification_context = None
                self._remove_persisted_disabled(state)
            self._condition.notify_all()
            logger.info(f"Credential index={index} fingerprint={state.fingerprint} cookie refreshed.")
            return state.public_snapshot()

    async def remove_account(self, index: int) -> Dict[str, object]:
        async with self._condition:
            state = self._get_state(index)
            if state.in_flight > 0:
                raise RuntimeError("credential is currently in use.")
            removed = state.public_snapshot()
            identity = credential_identity(state.cookie)
            self._remove_persisted_disabled(state)
            self._remove_persisted_quota(state)
            del self._states[index]
            del self.credentials[index]
            self._identity_indexes.pop(identity, None)
            self._identity_indexes = {}
            for new_index, item in enumerate(self._states):
                item.index = new_index
                self._identity_indexes[credential_identity(item.cookie)] = new_index
            self._rebuild_weighted_indexes()
            self.global_in_flight = sum(item.in_flight for item in self._states)
            self._condition.notify_all()
            logger.info(
                f"Credential index={index} fingerprint={state.fingerprint} removed from account pool."
            )
            return removed

    async def update_pool_config(
        self,
        global_concurrency: Optional[int] = None,
        failure_threshold: Optional[int] = None,
        cooldown_seconds: Optional[float] = None,
        acquire_timeout: Optional[float] = None,
    ) -> Dict[str, object]:
        async with self._condition:
            if global_concurrency is not None:
                self.global_concurrency = max(0, int(global_concurrency))
            if failure_threshold is not None:
                self.failure_threshold = max(1, int(failure_threshold))
            if cooldown_seconds is not None:
                self.cooldown_seconds = max(0.0, float(cooldown_seconds))
            if acquire_timeout is not None:
                self.acquire_timeout = max(0.1, float(acquire_timeout))
            self._condition.notify_all()
            return self.snapshot()

    async def clear_cooldown(self, index: int) -> Dict[str, object]:
        async with self._condition:
            state = self._get_state(index)
            state.cooldown_until = 0
            self._condition.notify_all()
            return state.public_snapshot()

    async def reset_health(self, index: int) -> Dict[str, object]:
        async with self._condition:
            state = self._get_state(index)
            state.success_count = 0
            state.failure_count = 0
            state.consecutive_failures = 0
            state.cooldown_until = 0
            state.last_success_at = None
            state.last_failure_at = None
            state.last_error = None
            state.verification_required = False
            state.verification_required_at = None
            state.verification_error = None
            state.verification_context = None
            self._condition.notify_all()
            return state.public_snapshot()

    async def health_check(self, index: int) -> Dict[str, object]:
        async with self._condition:
            state = self._get_state(index)
            snapshot = state.public_snapshot()
            healthy = snapshot["status"] in {"available", "busy"}
            return {
                "index": state.index,
                "fingerprint": state.fingerprint,
                "healthy": healthy,
                "status": snapshot["status"],
                "reason": None if healthy else snapshot["last_error"] or snapshot["status"],
                "checked_at": time.time(),
                "account": snapshot,
            }

    async def update_quota(
        self,
        index: int,
        *,
        total: Optional[float] = None,
        remaining: Optional[float] = None,
        used: Optional[float] = None,
        unit: Optional[str] = None,
        source: Optional[str] = None,
        status: str = "available",
        error: Optional[str] = None,
    ) -> Dict[str, object]:
        async with self._condition:
            state = self._get_state(index)
            now = time.time()
            incoming_remaining = self._number_or_none(remaining)
            if (
                source == "video_history"
                and incoming_remaining is not None
                and state.quota_remaining is not None
                and incoming_remaining > state.quota_remaining
                and state.quota_updated_at is not None
                and self._video_quota_day(state.quota_updated_at) == self._video_quota_day(now)
            ):
                logger.info(
                    f"Ignoring stale same-day video history quota increase for credential index={state.index}: "
                    f"current={state.quota_remaining:g}, history={incoming_remaining:g}."
                )
                return state.public_snapshot()
            state.quota_total = self._number_or_none(total)
            state.quota_remaining = incoming_remaining
            state.quota_used = self._number_or_none(used)
            if state.quota_total is not None and state.quota_remaining is not None and state.quota_used is None:
                state.quota_used = max(state.quota_total - state.quota_remaining, 0)
            if state.quota_total is not None and state.quota_used is not None and state.quota_remaining is None:
                state.quota_remaining = max(state.quota_total - state.quota_used, 0)
            if unit:
                state.quota_unit = unit
            state.quota_source = source
            state.quota_status = status
            if status in {"available", "estimated", "exhausted", "pending_refresh"}:
                state.quota_reset_at = next_video_quota_reset_at(now)
            else:
                state.quota_reset_at = None
            if state.quota_remaining is not None and state.quota_remaining <= 0 and status == "available":
                error = error or "Doubao quota remaining is 0."
                state.quota_status = "exhausted"
                self._disable_state_for_hard_failure(
                    state,
                    "quota_exhausted",
                    error,
                )
            elif (
                status == "available"
                and state.quota_remaining is not None
                and state.quota_remaining > 0
                and state.disabled
                and state.disabled_reason == "quota_exhausted"
            ):
                state.disabled = False
                state.disabled_reason = None
                state.cooldown_until = 0
                state.consecutive_failures = 0
                state.last_error = None
                self._remove_persisted_disabled(state)
            state.quota_updated_at = now
            state.last_quota_delta = None
            state.last_quota_error = error
            self._persist_quota_state(state)
            self._condition.notify_all()
            return state.public_snapshot()

    async def mark_quota_error(self, index: int, error: str, source: Optional[str] = None) -> Dict[str, object]:
        async with self._condition:
            state = self._get_state(index)
            now = time.time()
            preserve_pending = state.quota_status == "pending_refresh"
            state.quota_source = source or state.quota_source
            state.quota_updated_at = now
            state.last_quota_error = error
            if is_login_expired_error(error) or is_quota_exhausted_error(error):
                self._record_failure_locked(state, error)
                reason = "login_expired" if is_login_expired_error(error) else "quota_exhausted"
                self._disable_state_for_hard_failure(state, reason, error)
                if reason == "login_expired":
                    state.quota_status = "error"
                    state.quota_reset_at = None
            elif preserve_pending:
                state.quota_status = "pending_refresh"
                state.quota_reset_at = next_video_quota_reset_at(now)
                self._persist_quota_state(state)
            else:
                state.quota_status = "error"
                state.quota_reset_at = None
            if state.quota_status not in {"available", "estimated", "exhausted", "pending_refresh"}:
                self._remove_persisted_quota(state)
            self._condition.notify_all()
            return state.public_snapshot()

    async def consume_quota(
        self,
        index: int,
        amount: float,
        *,
        source: str = "local",
        reason: Optional[str] = None,
    ) -> Dict[str, object]:
        amount = max(0.0, float(amount or 0))
        async with self._condition:
            state = self._get_state(index)
            now = time.time()
            state.last_quota_delta = amount
            state.quota_source = source
            state.quota_updated_at = now
            state.quota_reset_at = next_video_quota_reset_at(now)
            if state.quota_remaining is not None:
                state.quota_remaining = max(state.quota_remaining - amount, 0)
            if state.quota_used is not None:
                state.quota_used += amount
            elif state.quota_total is not None and state.quota_remaining is not None:
                state.quota_used = max(state.quota_total - state.quota_remaining, 0)
            elif amount:
                state.quota_used = amount
            state.quota_status = "estimated" if amount else state.quota_status
            state.last_quota_error = None if amount else state.last_quota_error
            if state.quota_remaining is not None and state.quota_remaining <= 0 and amount:
                state.quota_status = "exhausted"
                state.last_quota_error = "Doubao quota remaining reached 0 after local consumption estimate."
                self._disable_state_for_hard_failure(state, "quota_exhausted", state.last_quota_error)
            if reason:
                logger.info(
                    f"Credential index={state.index} fingerprint={state.fingerprint} consumed "
                    f"{amount:g} {state.quota_unit} for {reason}."
                )
            self._persist_quota_state(state)
            self._condition.notify_all()
            return state.public_snapshot()

    async def record_quota_usage_without_balance(
        self,
        index: int,
        amount: float,
        *,
        source: str = "local_estimate",
        reason: Optional[str] = None,
    ) -> Dict[str, object]:
        amount = max(0.0, float(amount or 0))
        async with self._condition:
            state = self._get_state(index)
            now = time.time()
            state.last_quota_delta = amount
            state.quota_source = source
            state.quota_updated_at = now
            state.quota_reset_at = next_video_quota_reset_at(now)
            state.quota_used = (state.quota_used or 0) + amount
            state.quota_status = "pending_refresh"
            state.last_quota_error = (
                "Video usage was recorded, but Doubao did not report the remaining video quota."
            )
            if reason:
                logger.info(
                    f"Credential index={state.index} fingerprint={state.fingerprint} recorded "
                    f"{amount:g} {state.quota_unit} for {reason}; remaining quota needs refresh."
                )
            self._persist_quota_state(state)
            self._condition.notify_all()
            return state.public_snapshot()

    def snapshot(self) -> Dict[str, object]:
        self._reset_expired_video_quotas_locked()
        return {
            "account_count": len(self._states),
            "global_concurrency": self.global_concurrency,
            "global_in_flight": self.global_in_flight,
            "failure_threshold": self.failure_threshold,
            "cooldown_seconds": self.cooldown_seconds,
            "acquire_timeout": self.acquire_timeout,
            "accounts": [state.public_snapshot() for state in self._states],
        }

    async def get_cookie(self, index: int) -> str:
        async with self._condition:
            return self._get_state(index).cookie

    def contains_credential(self, cookie: str) -> bool:
        return self._credential_exists_locked(cookie)

    def get_credential(self) -> str:
        self._reset_expired_video_quotas_locked()
        state = self._select_legacy()
        logger.debug(f"Legacy credential poll selected index={state.index}")
        return state.cookie

    def _select_available_locked(
        self,
        required_quota: float = 0,
        allow_unknown: bool = False,
    ) -> Optional[CredentialState]:
        now = time.monotonic()
        if self.global_concurrency and self.global_in_flight >= self.global_concurrency:
            return None

        total = len(self._weighted_indexes)
        if total == 0:
            return None

        for offset in range(total):
            position = (self._cursor + offset) % total
            state = self._states[self._weighted_indexes[position]]
            quota_allowed = self._quota_allows_acquire_locked(
                state,
                required_quota=required_quota,
                allow_unknown=allow_unknown,
            )
            if state.is_available(now) and quota_allowed:
                self._cursor = (position + 1) % total
                return state
        return None

    def _quota_allows_acquire_locked(
        self,
        state: CredentialState,
        *,
        required_quota: float = 0,
        allow_unknown: bool = False,
    ) -> bool:
        if state.quota_allows_use(required_quota):
            return True
        if not allow_unknown:
            return False
        if state.quota_allows_provisional_video_use(required_quota):
            return True
        if state.quota_status not in NON_BLOCKING_QUOTA_STATUSES:
            return False
        return any(
            other is not state and other.quota_status == "pending_refresh"
            for other in self._states
        )

    def _next_ready_delay_locked(self) -> Optional[float]:
        now = time.monotonic()
        delays = [
            state.cooldown_until - now
            for state in self._states
            if not state.disabled and state.cooldown_until > now
        ]
        if not delays:
            return None
        return max(0.05, min(delays))

    def _get_state(self, index: int) -> CredentialState:
        if index < 0 or index >= len(self._states):
            raise IndexError(f"credential index out of range: {index}")
        return self._states[index]

    def _credential_exists_locked(self, cookie: str) -> bool:
        return credential_identity(cookie) in self._identity_indexes

    def _record_failure_locked(self, state: CredentialState, error: Optional[str]) -> None:
        state.failure_count += 1
        state.consecutive_failures += 1
        state.last_failure_at = time.time()
        state.last_error = error or None

    def _disable_state_for_hard_failure(self, state: CredentialState, reason: str, error: Optional[str]) -> None:
        now = time.time()
        state.disabled = True
        state.disabled_reason = reason
        state.cooldown_until = 0
        state.verification_required = False
        state.verification_required_at = None
        state.verification_error = None
        state.verification_context = None
        if reason == "quota_exhausted":
            reset_at = next_video_quota_reset_at(now)
            state.quota_status = "exhausted"
            state.quota_remaining = 0
            state.last_quota_error = error or state.last_quota_error
            state.quota_updated_at = now
            state.quota_reset_at = reset_at
            state.cooldown_until = time.monotonic() + max(0.0, reset_at - now)
            self._persist_quota_state(state)
        self._persist_disabled_state(state, reason, error)
        logger.warning(
            f"Credential index={state.index} fingerprint={state.fingerprint} disabled automatically "
            f"because {reason}: {error or 'no details'}"
        )

    @staticmethod
    def _video_quota_day(timestamp: float) -> int:
        return video_quota_day(timestamp)

    @staticmethod
    def next_video_quota_reset_at(timestamp: Optional[float] = None) -> float:
        return next_video_quota_reset_at(timestamp)

    def _reset_expired_video_quotas_locked(self, now: Optional[float] = None) -> List[int]:
        now = time.time() if now is None else float(now)
        current_day = self._video_quota_day(now)
        reset_indexes: List[int] = []
        for state in self._states:
            quota_expired = False
            if state.quota_reset_at is not None and float(state.quota_reset_at) <= now:
                quota_expired = True
            elif state.quota_updated_at is not None:
                try:
                    quota_expired = self._video_quota_day(float(state.quota_updated_at)) < current_day
                except (TypeError, ValueError):
                    quota_expired = False

            quota_disable_expired = False
            if state.disabled and state.disabled_reason == "quota_exhausted":
                quota_disable_expired = self._persisted_quota_disable_expired(
                    {
                        "reason": "quota_exhausted",
                        "source": state.quota_source,
                        "error": state.last_quota_error or state.last_error,
                        "disabled_at": state.quota_updated_at,
                        "reset_at": state.quota_reset_at,
                    }
                )
            if not quota_expired and not quota_disable_expired:
                continue

            state.quota_total = None
            state.quota_remaining = None
            state.quota_used = None
            state.quota_status = "unknown"
            state.quota_source = "daily_reset"
            state.quota_updated_at = now
            state.quota_reset_at = None
            state.last_quota_delta = None
            state.last_quota_error = None
            self._remove_persisted_quota(state)
            if state.disabled and state.disabled_reason == "quota_exhausted":
                state.disabled = False
                state.disabled_reason = None
                state.cooldown_until = 0
                state.consecutive_failures = 0
                state.last_error = None
                self._remove_persisted_disabled(state)
            reset_indexes.append(state.index)

        if reset_indexes:
            logger.info(
                "Reset expired daily video quota state for credential indexes="
                f"{reset_indexes}."
            )
        return reset_indexes

    def _persisted_quota_disable_expired(self, record: Dict[str, object]) -> bool:
        if record.get("reason") != "quota_exhausted":
            return False
        source = str(record.get("source") or "")
        error = str(record.get("error") or "")
        if source in ADVISORY_QUOTA_SOURCES:
            return True
        if not source and error in LEGACY_ADVISORY_QUOTA_ERRORS:
            return True
        if is_current_task_quota_progress_text(error):
            return True
        reset_at = record.get("reset_at")
        if reset_at is not None:
            try:
                return float(reset_at) <= time.time()
            except (TypeError, ValueError):
                pass
        disabled_at = record.get("disabled_at")
        if disabled_at is None:
            return False
        try:
            disabled_day = self._video_quota_day(float(disabled_at))
        except (TypeError, ValueError):
            return False
        return disabled_day < self._video_quota_day(time.time())

    def _persisted_quota_expired(self, record: Dict[str, object]) -> bool:
        reset_at = record.get("reset_at")
        if reset_at is not None:
            try:
                return float(reset_at) <= time.time()
            except (TypeError, ValueError):
                return True
        updated_at = record.get("updated_at")
        if updated_at is None:
            return True
        try:
            updated_day = self._video_quota_day(float(updated_at))
        except (TypeError, ValueError):
            return True
        return updated_day < self._video_quota_day(time.time())

    def _load_persisted_disabled(self) -> Dict[str, Dict[str, object]]:
        try:
            payload = json.loads(self._disabled_store_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning(f"Unable to read disabled credential store: {self._disabled_store_path}: {exc}")
            return {}
        records = payload.get("credentials") if isinstance(payload, dict) else payload
        if not isinstance(records, list):
            return {}
        result: Dict[str, Dict[str, object]] = {}
        for record in records:
            if isinstance(record, dict) and record.get("identity"):
                result[str(record["identity"])] = record
        return result

    def _save_persisted_disabled(self, records: Dict[str, Dict[str, object]]) -> None:
        try:
            self._disabled_store_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"credentials": list(records.values())}
            self._disabled_store_path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError as exc:
            logger.warning(f"Unable to write disabled credential store: {self._disabled_store_path}: {exc}")

    def _persist_disabled_state(self, state: CredentialState, reason: str, error: Optional[str]) -> None:
        state.disabled_reason = reason
        records = self._load_persisted_disabled()
        identity = credential_identity(state.cookie)
        records[identity] = {
            "identity": identity,
            "fingerprint": state.fingerprint,
            "reason": reason,
            "error": error,
            "source": state.quota_source,
            "disabled_at": time.time(),
            "reset_at": state.quota_reset_at if reason == "quota_exhausted" else None,
        }
        self._save_persisted_disabled(records)

    def _remove_persisted_disabled(self, state: CredentialState) -> None:
        records = self._load_persisted_disabled()
        identity = credential_identity(state.cookie)
        if identity in records:
            records.pop(identity, None)
            self._save_persisted_disabled(records)

    def _load_persisted_quotas(self) -> Dict[str, Dict[str, object]]:
        try:
            payload = json.loads(self._quota_store_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning(f"Unable to read video quota store: {self._quota_store_path}: {exc}")
            return {}
        records = payload.get("credentials") if isinstance(payload, dict) else payload
        if not isinstance(records, list):
            return {}
        return {
            str(record["identity"]): record
            for record in records
            if isinstance(record, dict) and record.get("identity")
        }

    def _save_persisted_quotas(self, records: Dict[str, Dict[str, object]]) -> None:
        try:
            self._quota_store_path.parent.mkdir(parents=True, exist_ok=True)
            self._quota_store_path.write_text(
                json.dumps({"credentials": list(records.values())}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError as exc:
            logger.warning(f"Unable to write video quota store: {self._quota_store_path}: {exc}")

    def _persist_quota_state(self, state: CredentialState) -> None:
        records = self._load_persisted_quotas()
        identity = credential_identity(state.cookie)
        persist_unknown_no_signal = (
            state.quota_status == "unknown"
            and state.quota_source == "video_history"
            and VIDEO_HISTORY_NO_SIGNAL_MARKER in str(state.last_quota_error or "")
            and state.quota_updated_at is not None
        )
        if state.quota_status not in {"available", "estimated", "exhausted", "pending_refresh"} and not persist_unknown_no_signal:
            if identity in records:
                records.pop(identity, None)
                self._save_persisted_quotas(records)
            return
        records[identity] = {
            "identity": identity,
            "fingerprint": state.fingerprint,
            "total": state.quota_total,
            "remaining": state.quota_remaining,
            "used": state.quota_used,
            "unit": state.quota_unit,
            "source": state.quota_source,
            "updated_at": state.quota_updated_at,
            "reset_at": state.quota_reset_at,
            "status": state.quota_status,
            "last_delta": state.last_quota_delta,
            "error": state.last_quota_error,
        }
        self._save_persisted_quotas(records)

    def _remove_persisted_quota(self, state: CredentialState) -> None:
        records = self._load_persisted_quotas()
        identity = credential_identity(state.cookie)
        if identity in records:
            records.pop(identity, None)
            self._save_persisted_quotas(records)

    @staticmethod
    def _number_or_none(value: Optional[float]) -> Optional[float]:
        if value is None:
            return None
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return None
        if parsed.is_integer():
            return int(parsed)
        return parsed

    def _rebuild_weighted_indexes(self) -> None:
        self._weighted_indexes = [
            state.index
            for state in self._states
            for _ in range(max(1, state.weight))
        ]
        if self._weighted_indexes:
            self._cursor %= len(self._weighted_indexes)
        else:
            self._cursor = 0

    def _select_legacy(self) -> CredentialState:
        now = time.monotonic()
        total = len(self._weighted_indexes)
        for offset in range(total):
            position = (self._cursor + offset) % total
            state = self._states[self._weighted_indexes[position]]
            if not state.disabled and state.quota_allows_use() and state.cooldown_until <= now:
                self._cursor = (position + 1) % total
                state.last_used_at = time.time()
                return state

        state = self._states[self._weighted_indexes[self._cursor % total]]
        self._cursor = (self._cursor + 1) % total
        state.last_used_at = time.time()
        return state
