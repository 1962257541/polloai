# /app/core/config.py
import os
import re
import uuid
from pathlib import Path
from dotenv import dotenv_values
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import model_validator
from typing import Any, Optional, List, Dict
from urllib.parse import unquote

from app.core.account_store import load_account_records, normalize_backend


COOKIE_ENV_WRAPPER_RE = re.compile(
    r"^\s*DOUBAO_COOKIE_\d+\s*=\s*([\"']?)(.*)\1\s*$",
    re.I | re.S,
)
PRIMARY_COOKIE_IDENTITY_KEYS = ("sessionid", "sessionid_ss", "sid_tt", "sid_guard")
SECONDARY_COOKIE_IDENTITY_KEYS = ("uid_tt", "uid_tt_ss", "passport_user_id", "user_unique_id", "login_user_id")
VOLATILE_COOKIE_KEYS = {"mstoken", "s_v_web_id", "web_id", "tea_uuid", "ttwid"}


def _persist_path(name: str) -> str:
    return str(Path(os.getenv("DOUBAO_PERSIST_DIR", ".generated")) / name)


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


def _cookie_identity(cookie: str) -> str:
    pairs = _cookie_pairs(cookie)
    if not pairs:
        return f"raw:{cookie}" if cookie else ""
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
    return f"raw:{cookie}"


def normalize_doubao_cookie(value: Any) -> str:
    text = str(value or "").strip()
    match = COOKIE_ENV_WRAPPER_RE.match(text)
    if match:
        text = match.group(2).strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"\"", "'"}:
        text = text[1:-1].strip()
    return text

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding='utf-8',
        extra="ignore"
    )

    APP_NAME: str = "doubao-2api"
    APP_VERSION: str = "1.0.0"
    DESCRIPTION: str = "一个将 doubao.com 转换为兼容 OpenAI 格式 API 的高性能代理，内置 a_bogus 签名解决方案。"

    # --- 核心安全与部署配置 ---
    API_MASTER_KEY: Optional[str] = "1"
    NGINX_PORT: int = 8088
    ENABLE_CHAT_PROVIDER: bool = True
    DATABASE_URL: Optional[str] = None
    
    # --- Doubao 凭证 ---
    DOUBAO_COOKIES: List[str] = []
    DOUBAO_COOKIE_WEIGHTS: List[int] = []
    DOUBAO_COOKIE_MAX_CONCURRENCY: List[int] = []
    DOUBAO_COOKIE_DISABLED: List[bool] = []
    DOUBAO_ACCOUNT_DEFAULT_WEIGHT: int = 1
    DOUBAO_ACCOUNT_MAX_CONCURRENCY: int = 1
    DOUBAO_ACCOUNT_GLOBAL_CONCURRENCY: int = 0
    DOUBAO_ACCOUNT_FAILURE_THRESHOLD: int = 3
    DOUBAO_ACCOUNT_COOLDOWN_SECONDS: float = 300
    DOUBAO_ACCOUNT_ACQUIRE_TIMEOUT: float = 30
    DOUBAO_PERSIST_DIR: str = os.getenv("DOUBAO_PERSIST_DIR", ".generated")
    DOUBAO_ACCOUNT_STORE_PATH: str = _persist_path("accounts.json")
    DOUBAO_ACCOUNT_STORE_BACKEND: str = "auto"
    DOUBAO_ACCOUNT_STORE_DB_KEY: str = "doubao-video-2api.account-pool.accounts"
    DOUBAO_DISABLED_CREDENTIAL_STORE_PATH: str = _persist_path("disabled_credentials.json")
    DOUBAO_VIDEO_QUOTA_STORE_PATH: str = _persist_path("video_quotas.json")
    DOUBAO_QUOTA_ENDPOINT: Optional[str] = "https://www.doubao.com/commerce/benefit_supply/credit/get_credit_num_optional_tasks"
    DOUBAO_QUOTA_METHOD: str = "POST"
    DOUBAO_QUOTA_SIGNED: bool = True
    DOUBAO_QUOTA_REQUEST_BODY: Dict[str, Any] = {"need_tasks": False}
    DOUBAO_QUOTA_TOTAL_PATH: Optional[str] = None
    DOUBAO_QUOTA_REMAINING_PATH: Optional[str] = None
    DOUBAO_QUOTA_USED_PATH: Optional[str] = None
    DOUBAO_QUOTA_UNIT: str = "video credits"
    DOUBAO_CHAT_QUOTA_COST: float = 0
    DOUBAO_VIDEO_QUOTA_COST: float = 2
    VIDEO_PUBLIC_BASE_URL: Optional[str] = None
    VIDEO_RELATIVE_CONTENT_URLS: bool = True

    # --- 核心变更: 静态设备指纹配置 ---
    # 从您提供的有效请求中提取的静态设备指纹，这比动态嗅探稳定得多
    # 如果未来失效，只需从浏览器抓取新的请求并更新此处的值
    DOUBAO_DEVICE_ID: Optional[str] = None
    DOUBAO_FP: Optional[str] = None
    DOUBAO_TEA_UUID: Optional[str] = None
    DOUBAO_WEB_ID: Optional[str] = None
    DOUBAO_BROWSER_PROFILE_DIR: str = _persist_path("browser-profiles")
    DOUBAO_BROWSER_MAX_ACTIVE_CONTEXTS: int = 5
    DOUBAO_BROWSER_IDLE_TIMEOUT_SECONDS: float = 120
    DOUBAO_BROWSER_CLEANUP_INTERVAL_SECONDS: float = 60
    DOUBAO_BROWSER_LAZY_START: bool = True
    DOUBAO_BROWSER_IDLE_SHUTDOWN_SECONDS: float = 45
    DOUBAO_BROWSER_STALE_SESSION_SECONDS: float = 300
    DOUBAO_COOKIE_AUTO_REFRESH_ENABLED: bool = True
    DOUBAO_COOKIE_AUTO_REFRESH_TIMEZONE: str = "Asia/Shanghai"
    DOUBAO_COOKIE_AUTO_REFRESH_HOUR: int = 0
    DOUBAO_COOKIE_AUTO_REFRESH_MINUTE: int = 0
    DOUBAO_COOKIE_AUTO_REFRESH_SETTLE_SECONDS: float = 5
    DOUBAO_COOKIE_AUTO_REFRESH_TIMEOUT_SECONDS: float = 90
    DOUBAO_COOKIE_AUTO_REFRESH_PERSIST: bool = True
    DOUBAO_CAPTCHA_AUTO_SOLVE: bool = True
    DOUBAO_VIDEO_SUBMIT_CONCURRENCY: int = 15
    DOUBAO_FRONTEND_SUBMIT_CONCURRENCY: int = 5
    DOUBAO_FRONTEND_RESULT_WAIT_CONCURRENCY: int = 20
    DOUBAO_VERIFICATION_LIGHT_WAIT_SNAPSHOT_INTERVAL_SECONDS: float = 30
    DOUBAO_CAPTCHA_SOLVER_BACKEND: str = "openai"
    DOUBAO_CAPTCHA_SOLVER_BASE_URL: Optional[str] = None
    DOUBAO_CAPTCHA_SOLVER_API_KEY: Optional[str] = None
    DOUBAO_CAPTCHA_SOLVER_MODEL: Optional[str] = None
    DOUBAO_CAPTCHA_ZHENXUN_MODEL: Optional[str] = None
    DOUBAO_CAPTCHA_ZHENXUN_IMPORT_PATH: Optional[str] = None
    DOUBAO_CAPTCHA_ZHENXUN_PLUGIN_MODULE: str = "ai_creation.engines.doubao.captcha_solver"
    DOUBAO_CAPTCHA_SOLVER_TIMEOUT_SECONDS: float = 45
    DOUBAO_CAPTCHA_SOLVER_RETRIES: int = 2

    # --- 上游 API 配置 ---
    API_REQUEST_TIMEOUT: int = 180

    # --- Video API configuration ---
    VIDEO_PROVIDER: str = "doubao_web"
    VIDEO_OUTPUT_DIR: str = _persist_path("videos")
    DOUBAO_COOKIE_PLUGIN_CONFIG_PATH: str = _persist_path("doubao_cookie_plugin.json")
    API_KEY_STORE_PATH: str = _persist_path("api_keys.json")
    DOUBAO_VERIFICATION_SNAPSHOT_DIR: str = _persist_path("verification-snapshots")
    DOUBAO_VERIFICATION_TRIGGER_SNAPSHOT_DIR: str = _persist_path("verification-trigger-snapshots")
    DOUBAO_CONTEXT_TEMPLATE_DIR: str = _persist_path("context-templates")
    VIDEO_TASK_DELAY_SECONDS: float = 0.25
    VIDEO_TASK_RETENTION_SECONDS: float = 3600
    VIDEO_TASK_MAX_RETAINED: int = 500
    VIDEO_TASK_CLEANUP_INTERVAL_SECONDS: float = 300
    DEFAULT_VIDEO_MODEL: str = "doubao-seedance-2-0"
    DOUBAO_VIDEO_WATERMARK: bool = False
    MOCK_VIDEO_MODEL_MAPPING: Dict[str, str] = {
        "doubao-seedance-2-0": "seedance_v2.0",
        "doubao-video-mock": "mock",
    }
    VIDEO_MODEL_MAPPING: Dict[str, str] = {
        "doubao-seedance-2-0": "seedance_v2.0",
    }
    DEFAULT_VIDEO_RATIO: str = "16:9"
    DEFAULT_VIDEO_RESOLUTION: str = "720p"
    VIDEO_DURATION_OPTIONS: List[int] = [10, 5]
    VIDEO_LONG_FORM_ENABLED: bool = True
    VIDEO_LONG_FORM_MAX_DURATION_SECONDS: int = 30
    VIDEO_LONG_FORM_SEGMENT_SECONDS: int = 10
    VIDEO_LONG_FORM_CONCAT_TIMEOUT_SECONDS: int = 600
    VIDEO_LONG_FORM_PUBLIC_DURATION_OPTIONS: List[int] = [5, 10, 15, 20, 25, 30]
    VIDEO_RATIO_MAPPING: Dict[str, Dict[str, Any]] = {
        "16:9": {
            "ratio": "16:9",
            "label": "16:9 landscape",
            "sizes": {
                "720p": {"width": 1280, "height": 720, "size": "1280x720"},
                "1080p": {"width": 1920, "height": 1080, "size": "1920x1080"},
            },
        },
        "9:16": {
            "ratio": "9:16",
            "label": "9:16 portrait",
            "sizes": {
                "720p": {"width": 720, "height": 1280, "size": "720x1280"},
                "1080p": {"width": 1080, "height": 1920, "size": "1080x1920"},
            },
        },
        "1:1": {
            "ratio": "1:1",
            "label": "1:1 square",
            "sizes": {
                "720p": {"width": 1024, "height": 1024, "size": "1024x1024"},
                "1080p": {"width": 1080, "height": 1080, "size": "1080x1080"},
            },
        },
    }
    VIDEO_RESOLUTION_MAPPING: Dict[str, str] = {
        "720p": "720p",
        "1080p": "1080p",
    }
    DOUBAO_VIDEO_BOT_ID: str = "7338286299411103781"
    DOUBAO_VIDEO_SKILL_TYPE: int = 17
    DOUBAO_VIDEO_ABILITY_TYPE: int = 17
    DOUBAO_VIDEO_PC_VERSION: str = "3.23.1"
    DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT: int = 8
    DOUBAO_VIDEO_VERIFICATION_RETRY_LIMIT: int = 3
    DOUBAO_VIDEO_TASK_TIMEOUT_SECONDS: int = 900
    DOUBAO_VIDEO_QUOTA_AUTO_REFRESH: bool = True
    DOUBAO_VIDEO_QUOTA_INITIAL_REFRESH: bool = True
    DOUBAO_VIDEO_QUOTA_REFRESH_CONCURRENCY: int = 1
    DOUBAO_VIDEO_QUOTA_REFRESH_INTERVAL_SECONDS: float = 30
    DOUBAO_VIDEO_QUOTA_REFRESH_BATCH_SIZE: int = 1
    DOUBAO_VIDEO_QUOTA_REFRESH_MIN_AVAILABLE_ACCOUNTS: int = 3
    DOUBAO_VIDEO_QUOTA_UNKNOWN_REFRESH_INTERVAL_SECONDS: float = 600
    DOUBAO_VIDEO_QUOTA_REFRESH_TIMEOUT_SECONDS: float = 30
    DOUBAO_VIDEO_QUOTA_HISTORY_CONVERSATIONS: int = 50
    DOUBAO_VIDEO_QUOTA_MAX_AGE_SECONDS: float = 300
    DOUBAO_VIDEO_ALLOW_UNKNOWN_QUOTA_ON_GENERATE: bool = False
    DOUBAO_VIDEO_TRANSPORT: str = "browser"
    DOUBAO_VIDEO_CHANNEL: str = "bing_sem"
    
    # --- 会话管理 ---
    SESSION_CACHE_TTL: int = 3600

    # --- 模型配置 ---
    DEFAULT_MODEL: str = "doubao-pro-chat"
    MODEL_MAPPING: Dict[str, str] = {
        "doubao-pro-chat": "7338286299411103781", # 默认模型 Bot ID
    }

    @model_validator(mode='after')
    def validate_settings(self) -> 'Settings':
        self.DOUBAO_COOKIES = [
            normalized
            for item in self.DOUBAO_COOKIES
            if (normalized := normalize_doubao_cookie(item))
        ]
        # 从环境变量 DOUBAO_COOKIE_1, DOUBAO_COOKIE_2, ... 加载 cookies
        env_values = dotenv_values(".env")
        cookie_indexes = {
            int(match.group(1))
            for source in (env_values, os.environ)
            for key in source.keys()
            if (match := re.fullmatch(r"DOUBAO_COOKIE_(\d+)", str(key)))
        }
        for i in sorted(cookie_indexes):
            cookie_str = os.getenv(f"DOUBAO_COOKIE_{i}") or env_values.get(f"DOUBAO_COOKIE_{i}")
            if cookie_str:
                cookie_str = normalize_doubao_cookie(cookie_str)
                if cookie_str not in self.DOUBAO_COOKIES:
                    self.DOUBAO_COOKIES.append(cookie_str)
                    weight = os.getenv(f"DOUBAO_COOKIE_WEIGHT_{i}") or env_values.get(f"DOUBAO_COOKIE_WEIGHT_{i}")
                    concurrency = (
                        os.getenv(f"DOUBAO_COOKIE_MAX_CONCURRENCY_{i}")
                        or env_values.get(f"DOUBAO_COOKIE_MAX_CONCURRENCY_{i}")
                    )
                    disabled = os.getenv(f"DOUBAO_COOKIE_DISABLED_{i}") or env_values.get(f"DOUBAO_COOKIE_DISABLED_{i}")

                    self.DOUBAO_COOKIE_WEIGHTS.append(self._positive_int(weight, self.DOUBAO_ACCOUNT_DEFAULT_WEIGHT))
                    self.DOUBAO_COOKIE_MAX_CONCURRENCY.append(
                        self._positive_int(concurrency, self.DOUBAO_ACCOUNT_MAX_CONCURRENCY)
                    )
                    self.DOUBAO_COOKIE_DISABLED.append(self._truthy(disabled))
        
        # --- 核心变更: 验证设备指纹是否已配置 ---
        self.load_persisted_accounts()

        if self.ENABLE_CHAT_PROVIDER and not all([self.DOUBAO_DEVICE_ID, self.DOUBAO_FP, self.DOUBAO_TEA_UUID, self.DOUBAO_WEB_ID]):
            raise ValueError("必须在 .env 文件中配置完整的设备指纹参数 (DOUBAO_DEVICE_ID, DOUBAO_FP, DOUBAO_TEA_UUID, DOUBAO_WEB_ID)")
        if self.VIDEO_PROVIDER not in {"mock", "doubao_web"}:
            raise ValueError("VIDEO_PROVIDER currently supports 'mock' or 'doubao_web'.")
        self.DOUBAO_ACCOUNT_STORE_BACKEND = normalize_backend(self.DOUBAO_ACCOUNT_STORE_BACKEND)
        self.DOUBAO_QUOTA_METHOD = str(self.DOUBAO_QUOTA_METHOD or "GET").upper()
        if self.DOUBAO_QUOTA_METHOD not in {"GET", "POST"}:
            raise ValueError("DOUBAO_QUOTA_METHOD currently supports 'GET' or 'POST'.")
        self.DOUBAO_CHAT_QUOTA_COST = self._non_negative_float(self.DOUBAO_CHAT_QUOTA_COST, 0)
        self.DOUBAO_VIDEO_QUOTA_COST = self._non_negative_float(self.DOUBAO_VIDEO_QUOTA_COST, 2)
        if self.VIDEO_PUBLIC_BASE_URL is not None:
            self.VIDEO_PUBLIC_BASE_URL = str(self.VIDEO_PUBLIC_BASE_URL).strip().rstrip("/") or None
        self.VIDEO_TASK_RETENTION_SECONDS = self._positive_float(
            self.VIDEO_TASK_RETENTION_SECONDS,
            3600,
        )
        self.VIDEO_TASK_MAX_RETAINED = self._positive_int(
            self.VIDEO_TASK_MAX_RETAINED,
            500,
        )
        self.VIDEO_TASK_CLEANUP_INTERVAL_SECONDS = self._positive_float(
            self.VIDEO_TASK_CLEANUP_INTERVAL_SECONDS,
            300,
        )
        self.DOUBAO_BROWSER_MAX_ACTIVE_CONTEXTS = self._positive_int(
            self.DOUBAO_BROWSER_MAX_ACTIVE_CONTEXTS,
            5,
        )
        self.DOUBAO_BROWSER_IDLE_TIMEOUT_SECONDS = self._positive_float(
            self.DOUBAO_BROWSER_IDLE_TIMEOUT_SECONDS,
            120,
        )
        self.DOUBAO_BROWSER_CLEANUP_INTERVAL_SECONDS = self._positive_float(
            self.DOUBAO_BROWSER_CLEANUP_INTERVAL_SECONDS,
            60,
        )
        self.DOUBAO_BROWSER_IDLE_SHUTDOWN_SECONDS = self._non_negative_float(
            self.DOUBAO_BROWSER_IDLE_SHUTDOWN_SECONDS,
            45,
        )
        self.DOUBAO_BROWSER_STALE_SESSION_SECONDS = self._positive_float(
            self.DOUBAO_BROWSER_STALE_SESSION_SECONDS,
            300,
        )
        self.DOUBAO_COOKIE_AUTO_REFRESH_HOUR = min(
            23,
            max(0, self._non_negative_int(self.DOUBAO_COOKIE_AUTO_REFRESH_HOUR, 0)),
        )
        self.DOUBAO_COOKIE_AUTO_REFRESH_MINUTE = min(
            59,
            max(0, self._non_negative_int(self.DOUBAO_COOKIE_AUTO_REFRESH_MINUTE, 0)),
        )
        self.DOUBAO_COOKIE_AUTO_REFRESH_SETTLE_SECONDS = self._non_negative_float(
            self.DOUBAO_COOKIE_AUTO_REFRESH_SETTLE_SECONDS,
            5,
        )
        self.DOUBAO_COOKIE_AUTO_REFRESH_TIMEOUT_SECONDS = self._positive_float(
            self.DOUBAO_COOKIE_AUTO_REFRESH_TIMEOUT_SECONDS,
            90,
        )
        self.DOUBAO_VIDEO_SUBMIT_CONCURRENCY = self._positive_int(
            self.DOUBAO_VIDEO_SUBMIT_CONCURRENCY,
            15,
        )
        self.DOUBAO_FRONTEND_SUBMIT_CONCURRENCY = self._positive_int(
            self.DOUBAO_FRONTEND_SUBMIT_CONCURRENCY,
            5,
        )
        self.DOUBAO_FRONTEND_RESULT_WAIT_CONCURRENCY = self._positive_int(
            self.DOUBAO_FRONTEND_RESULT_WAIT_CONCURRENCY,
            20,
        )
        self.DOUBAO_VERIFICATION_LIGHT_WAIT_SNAPSHOT_INTERVAL_SECONDS = self._positive_float(
            self.DOUBAO_VERIFICATION_LIGHT_WAIT_SNAPSHOT_INTERVAL_SECONDS,
            30,
        )
        self.DOUBAO_CAPTCHA_SOLVER_BACKEND = str(
            self.DOUBAO_CAPTCHA_SOLVER_BACKEND or "openai"
        ).strip().lower()
        self.DOUBAO_CAPTCHA_SOLVER_TIMEOUT_SECONDS = self._positive_float(
            self.DOUBAO_CAPTCHA_SOLVER_TIMEOUT_SECONDS,
            45,
        )
        self.DOUBAO_CAPTCHA_SOLVER_RETRIES = self._positive_int(
            self.DOUBAO_CAPTCHA_SOLVER_RETRIES,
            2,
        )
        self.DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT = self._positive_int(
            self.DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT,
            8,
        )
        self.DOUBAO_VIDEO_VERIFICATION_RETRY_LIMIT = self._positive_int(
            self.DOUBAO_VIDEO_VERIFICATION_RETRY_LIMIT,
            3,
        )
        self.DOUBAO_VIDEO_TASK_TIMEOUT_SECONDS = self._positive_int(
            self.DOUBAO_VIDEO_TASK_TIMEOUT_SECONDS,
            900,
        )
        self.DOUBAO_VIDEO_QUOTA_REFRESH_CONCURRENCY = self._positive_int(
            self.DOUBAO_VIDEO_QUOTA_REFRESH_CONCURRENCY,
            1,
        )
        self.DOUBAO_VIDEO_QUOTA_REFRESH_INTERVAL_SECONDS = self._positive_float(
            self.DOUBAO_VIDEO_QUOTA_REFRESH_INTERVAL_SECONDS,
            30,
        )
        self.DOUBAO_VIDEO_QUOTA_REFRESH_BATCH_SIZE = self._positive_int(
            self.DOUBAO_VIDEO_QUOTA_REFRESH_BATCH_SIZE,
            1,
        )
        self.DOUBAO_VIDEO_QUOTA_REFRESH_MIN_AVAILABLE_ACCOUNTS = self._positive_int(
            self.DOUBAO_VIDEO_QUOTA_REFRESH_MIN_AVAILABLE_ACCOUNTS,
            3,
        )
        self.DOUBAO_VIDEO_QUOTA_UNKNOWN_REFRESH_INTERVAL_SECONDS = self._positive_float(
            self.DOUBAO_VIDEO_QUOTA_UNKNOWN_REFRESH_INTERVAL_SECONDS,
            600,
        )
        self.DOUBAO_VIDEO_QUOTA_REFRESH_TIMEOUT_SECONDS = self._positive_float(
            self.DOUBAO_VIDEO_QUOTA_REFRESH_TIMEOUT_SECONDS,
            30,
        )
        self.DOUBAO_VIDEO_QUOTA_HISTORY_CONVERSATIONS = self._positive_int(
            self.DOUBAO_VIDEO_QUOTA_HISTORY_CONVERSATIONS,
            20,
        )
        self.DOUBAO_VIDEO_QUOTA_MAX_AGE_SECONDS = self._positive_float(
            self.DOUBAO_VIDEO_QUOTA_MAX_AGE_SECONDS,
            300,
        )
        self.DOUBAO_VIDEO_TRANSPORT = str(self.DOUBAO_VIDEO_TRANSPORT or "browser").strip().lower()
        if self.DOUBAO_VIDEO_TRANSPORT not in {"httpx", "browser"}:
            raise ValueError("DOUBAO_VIDEO_TRANSPORT currently supports 'httpx' or 'browser'.")
        self.VIDEO_DURATION_OPTIONS = sorted(
            {self._positive_int(item, 10) for item in self.VIDEO_DURATION_OPTIONS},
            reverse=True,
        )
        self.VIDEO_LONG_FORM_MAX_DURATION_SECONDS = self._positive_int(
            self.VIDEO_LONG_FORM_MAX_DURATION_SECONDS,
            30,
        )
        self.VIDEO_LONG_FORM_SEGMENT_SECONDS = self._positive_int(
            self.VIDEO_LONG_FORM_SEGMENT_SECONDS,
            max(self.VIDEO_DURATION_OPTIONS),
        )
        self.VIDEO_LONG_FORM_CONCAT_TIMEOUT_SECONDS = self._positive_int(
            self.VIDEO_LONG_FORM_CONCAT_TIMEOUT_SECONDS,
            600,
        )
        self.VIDEO_LONG_FORM_PUBLIC_DURATION_OPTIONS = sorted(
            {
                self._positive_int(item, max(self.VIDEO_DURATION_OPTIONS))
                for item in self.VIDEO_LONG_FORM_PUBLIC_DURATION_OPTIONS
                if self._positive_int(item, max(self.VIDEO_DURATION_OPTIONS))
                <= self.VIDEO_LONG_FORM_MAX_DURATION_SECONDS
            }
        )
        if self.VIDEO_LONG_FORM_SEGMENT_SECONDS not in self.VIDEO_DURATION_OPTIONS:
            raise ValueError("VIDEO_LONG_FORM_SEGMENT_SECONDS must be one of VIDEO_DURATION_OPTIONS.")

        if self.VIDEO_PROVIDER == "doubao_web" and not all([self.DOUBAO_DEVICE_ID, self.DOUBAO_FP, self.DOUBAO_TEA_UUID, self.DOUBAO_WEB_ID]):
            raise ValueError("VIDEO_PROVIDER=doubao_web requires DOUBAO_DEVICE_ID, DOUBAO_FP, DOUBAO_TEA_UUID, and DOUBAO_WEB_ID.")

        return self

    @staticmethod
    def _positive_int(value: Any, default: int) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            parsed = default
        return max(1, parsed)

    @staticmethod
    def _non_negative_float(value: Any, default: float) -> float:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            parsed = default
        return max(0.0, parsed)

    @staticmethod
    def _non_negative_int(value: Any, default: int) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            parsed = default
        return max(0, parsed)

    @staticmethod
    def _positive_float(value: Any, default: float) -> float:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            parsed = default
        return max(1.0, parsed)

    def load_persisted_accounts(self) -> None:
        records = load_account_records(
            file_path=self.DOUBAO_ACCOUNT_STORE_PATH,
            backend=self.DOUBAO_ACCOUNT_STORE_BACKEND,
            database_url=self.DATABASE_URL,
            store_key=self.DOUBAO_ACCOUNT_STORE_DB_KEY,
        )

        seen = {normalize_doubao_cookie(cookie) for cookie in self.DOUBAO_COOKIES}
        identity_indexes = {
            identity: index
            for index, cookie in enumerate(self.DOUBAO_COOKIES)
            if (identity := _cookie_identity(normalize_doubao_cookie(cookie)))
        }
        for record in records:
            if not isinstance(record, dict):
                continue
            cookie = normalize_doubao_cookie(record.get("cookie") or record.get("credential"))
            if not cookie:
                continue
            identity = str(record.get("identity") or _cookie_identity(cookie)).strip()
            weight = self._positive_int(record.get("weight"), self.DOUBAO_ACCOUNT_DEFAULT_WEIGHT)
            max_concurrency = self._positive_int(
                record.get("max_concurrency"),
                self.DOUBAO_ACCOUNT_MAX_CONCURRENCY,
            )
            disabled = self._truthy(record.get("disabled"))
            if identity and identity in identity_indexes:
                index = identity_indexes[identity]
                self.DOUBAO_COOKIES[index] = cookie
                if index < len(self.DOUBAO_COOKIE_WEIGHTS):
                    self.DOUBAO_COOKIE_WEIGHTS[index] = weight
                if index < len(self.DOUBAO_COOKIE_MAX_CONCURRENCY):
                    self.DOUBAO_COOKIE_MAX_CONCURRENCY[index] = max_concurrency
                if index < len(self.DOUBAO_COOKIE_DISABLED):
                    self.DOUBAO_COOKIE_DISABLED[index] = disabled
                seen.add(cookie)
                continue
            if cookie in seen:
                continue
            seen.add(cookie)
            if identity:
                identity_indexes[identity] = len(self.DOUBAO_COOKIES)
            self.DOUBAO_COOKIES.append(cookie)
            self.DOUBAO_COOKIE_WEIGHTS.append(weight)
            self.DOUBAO_COOKIE_MAX_CONCURRENCY.append(max_concurrency)
            self.DOUBAO_COOKIE_DISABLED.append(disabled)

    @staticmethod
    def _truthy(value: Any) -> bool:
        if value is None:
            return False
        return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}

settings = Settings()
