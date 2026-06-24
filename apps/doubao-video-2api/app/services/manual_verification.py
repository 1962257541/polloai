import asyncio
import inspect
import json
import time
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

from loguru import logger
from playwright.async_api import TimeoutError as PlaywrightTimeoutError

from app.services.doubao_context_template import (
    build_context_template,
    context_summary_for_public,
    load_latest_context_template,
    save_context_template,
)
from app.services.doubao_captcha_solver import solve_doubao_drag_captcha_if_present
from app.services.doubao_challenge_probe import apply_doubao_drag_captcha_indices, probe_doubao_drag_captcha
from app.services.playwright_manager import AccountBrowserSession, PlaywrightManager


VERIFY_TERMS = (
    "请选择",
    "验证",
    "拖拽",
    "符合上下文",
    "shark",
    "verify",
    "captcha",
)
MANUAL_SUCCESS_TERMS = (
    "\u8fd9\u5c31\u4e3a\u60a8\u751f\u6210",
    "\u8fd9\u5c31\u4e3a\u4f60\u751f\u6210",
    "\u9884\u8ba1\u7b49\u5f85 1-3\u5206\u949f",
    "\u9884\u8ba1\u7b49\u5f851-3\u5206\u949f",
    "\u89c6\u9891\u751f\u6210\u597d\u540e",
    "\u4f1a\u4e3b\u52a8\u53d1\u9001\u7ed9\u4f60",
    "\u4f1a\u4e3b\u52a8\u53d1\u9001\u7ed9\u60a8",
    "\u4f60\u7684\u89c6\u9891\u751f\u6210\u597d\u5566",
    "\u89c6\u9891\u751f\u6210\u597d\u5566",
    "\u89c6\u9891\u751f\u6210\u6210\u529f",
    "\u751f\u6210\u597d\u5566",
    "video generation has started",
    "your video is now being generated",
    "the video is now being generated",
    "started generating the video",
    "generation is now in progress",
)
LOGIN_REQUIRED_TERMS = (
    "\u767b\u5f55",
    "\u7acb\u5373\u767b\u5f55",
    "\u8bf7\u5148\u767b\u5f55",
    "\u672a\u767b\u5f55",
)
BDTURING_VERIFY_DATA_KEYS = (
    "code",
    "from",
    "version",
    "type",
    "region",
    "subtype",
    "detail",
    "server_sdk_env",
    "log_id",
    "verify_scene",
    "fp",
)


def manual_success_terms_from_text(text: str) -> tuple[str, ...]:
    lowered = str(text or "").lower()
    compact = "".join(lowered.split())
    return tuple(
        term
        for term in MANUAL_SUCCESS_TERMS
        if "".join(term.lower().split()) in compact
    )


@dataclass
class ManualVerificationRecord:
    account_index: int
    cookie: str
    session: AccountBrowserSession
    started_at: float
    expires_at: float
    snapshot_interval_seconds: float
    headless: bool
    status: str = "active"
    message: str = ""
    url: str = ""
    title: str = ""
    snapshot_path: Optional[str] = None
    snapshot_url: Optional[str] = None
    updated_at: Optional[float] = None
    released: bool = False
    lock_acquired: bool = False
    stop_event: Optional[asyncio.Event] = None
    task: Optional[asyncio.Task] = None
    last_error: Optional[str] = None
    detected_terms: tuple[str, ...] = ()
    manual_success_terms: tuple[str, ...] = ()
    captcha_probe: dict[str, Any] | None = None
    visual_challenge_seen: bool = False
    snapshot_width: Optional[int] = None
    snapshot_height: Optional[int] = None
    context_capture_count: int = 0
    latest_context_template: dict[str, Any] | None = None
    latest_context_template_path: Optional[str] = None
    login_required: bool = False
    login_terms: tuple[str, ...] = ()
    login_probe: dict[str, Any] | None = None
    request_handler: Any = None
    response_handler: Any = None
    verification_context: dict[str, Any] | None = None
    bdturing_render: dict[str, Any] | None = None
    bdturing_render_count: int = 0
    bdturing_result: dict[str, Any] | None = None
    auto_solve_result: dict[str, Any] | None = None
    video_signals: dict[str, Any] | None = None
    video_result_event: Optional[asyncio.Event] = None
    light_video_wait: bool = False
    light_video_wait_started_at: Optional[float] = None
    snapshot_capture_count: int = 0


class ManualVerificationManager:
    _shared: Optional["ManualVerificationManager"] = None

    @classmethod
    def shared(cls) -> "ManualVerificationManager":
        if cls._shared is None:
            cls._shared = cls()
        return cls._shared

    def __init__(self, snapshot_dir: str | Path = ".generated/verification-snapshots") -> None:
        self.snapshot_dir = Path(snapshot_dir)
        self._records: dict[int, ManualVerificationRecord] = {}
        self._lock = asyncio.Lock()

    async def start(
        self,
        account_index: int,
        cookie: str,
        *,
        timeout_seconds: int = 600,
        snapshot_interval_seconds: float = 3.0,
        verification_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        timeout_seconds = max(30, int(timeout_seconds or 600))
        snapshot_interval_seconds = max(1.0, float(snapshot_interval_seconds or 3.0))
        async with self._lock:
            existing = self._records.get(account_index)
            if existing and not existing.released and existing.status == "active":
                await self.capture(account_index)
                return self._public(existing)

            manager = PlaywrightManager()
            if not getattr(manager, "_initialized", False):
                await manager.initialize([cookie])
            else:
                await manager.register_account(cookie)

            session = await manager._acquire_session(cookie)
            record = ManualVerificationRecord(
                account_index=account_index,
                cookie=cookie,
                session=session,
                started_at=time.time(),
                expires_at=time.time() + timeout_seconds,
                snapshot_interval_seconds=snapshot_interval_seconds,
                headless=manager._headless_mode(),
                stop_event=asyncio.Event(),
                video_result_event=asyncio.Event(),
                verification_context=dict(verification_context or {}) or None,
            )
            await session.lock.acquire()
            record.lock_acquired = True
            self._records[account_index] = record

        try:
            await session.page.goto("https://www.doubao.com/chat/", wait_until="domcontentloaded", timeout=60_000)
            self._install_context_recording(record)
            with suppress(PlaywrightTimeoutError):
                await session.page.wait_for_load_state("networkidle", timeout=8_000)
            await self._capture_record(record)
            record.message = self._active_message(record)
            record.task = asyncio.create_task(self._capture_loop(record))
            return self._public(record)
        except Exception:
            await self._release(record, "error")
            raise

    async def status(self, account_index: int) -> dict[str, Any]:
        record = self._records.get(account_index)
        if not record:
            return {
                "object": "manual_verification",
                "account_index": account_index,
                "status": "idle",
                "message": "No manual verification session is active.",
            }
        return self._public(record)

    async def capture(self, account_index: int) -> dict[str, Any]:
        record = self._records.get(account_index)
        if not record:
            return await self.status(account_index)
        if record.released:
            return self._public(record)
        await self._capture_record(record)
        return self._public(record)

    async def wait_for_video_result(
        self,
        account_index: int,
        *,
        timeout_seconds: float = 300,
    ) -> dict[str, Any]:
        record = self._records.get(account_index)
        if not record or record.released:
            return await self.status(account_index)
        if (record.video_signals or {}).get("video_urls"):
            return self._public(record)

        event = record.video_result_event
        if event is None:
            event = asyncio.Event()
            record.video_result_event = event
        try:
            await asyncio.wait_for(event.wait(), timeout=max(1.0, float(timeout_seconds)))
        except asyncio.TimeoutError:
            payload = self._public(record)
            payload["video_result_timed_out"] = True
            return payload
        return self._public(record)

    async def enter_light_video_wait(
        self,
        account_index: int,
        *,
        snapshot_interval_seconds: float = 30,
    ) -> dict[str, Any]:
        record = self._records.get(account_index)
        if not record or record.released:
            return await self.status(account_index)
        interval = max(float(snapshot_interval_seconds or 30), record.snapshot_interval_seconds, 10.0)
        record.light_video_wait = True
        record.light_video_wait_started_at = record.light_video_wait_started_at or time.time()
        record.snapshot_interval_seconds = interval
        record.updated_at = time.time()
        record.message = (
            "Frontend video generation accepted; waiting in lightweight network-listener mode."
        )
        return self._public(record)

    async def trigger(
        self,
        account_index: int,
        prompt: str = "生成一个简单的产品展示短视频",
        mode: str = "video",
        image_path: str | None = None,
    ) -> dict[str, Any]:
        record = self._records.get(account_index)
        if not record or record.released:
            return await self.status(account_index)

        prompt = (prompt or "生成一个简单的产品展示短视频").strip() or "生成一个简单的产品展示短视频"
        if len(prompt) > 80:
            prompt = prompt[:80]
        try:
            normalized_mode = str(mode or "video").strip().lower()
            if image_path:
                await self._trigger_doubao_image_video_generation(record, prompt, image_path)
            elif normalized_mode in {"image_video", "i2v", "image-to-video", "image_to_video"}:
                raise ValueError("image_path is required for image-to-video frontend capture.")
            elif normalized_mode == "chat":
                await self._trigger_doubao_message(record, prompt)
            else:
                await self._trigger_doubao_video_generation(record, prompt)
            await record.session.page.wait_for_timeout(5_000)
            await self._capture_record(record)
            if not record.detected_terms:
                record.message = "Video probe sent; no verification popup is visible yet."
            return self._public(record)
        except Exception as exc:
            record.last_error = str(exc)
            record.message = f"Unable to trigger verification probe: {exc}"
            with suppress(Exception):
                await self._capture_record(record)
            return self._public(record)

    async def complete(self, account_index: int) -> dict[str, Any]:
        record = self._records.get(account_index)
        if not record:
            return {
                "object": "manual_verification",
                "account_index": account_index,
                "status": "idle",
                "message": "No manual verification session is active.",
                "cookie_header": None,
            }
        if not record.released:
            await self._capture_record(record)
        cookie_header = None
        with suppress(Exception):
            cookie_header = await PlaywrightManager._cookie_header(record.session.context)
        await self._release(record, "completed")
        payload = self._public(record)
        payload["cookie_header"] = cookie_header
        return payload

    async def cancel(self, account_index: int) -> dict[str, Any]:
        record = self._records.get(account_index)
        if not record:
            return await self.status(account_index)
        await self._release(record, "cancelled")
        return self._public(record)

    async def send_input(self, account_index: int, payload: dict[str, Any]) -> dict[str, Any]:
        record = self._records.get(account_index)
        if not record or record.released:
            return await self.status(account_index)

        action = str(payload.get("type") or "click").strip().lower()
        page = record.session.page
        if action == "click":
            x, y = self._payload_point(payload, record)
            await page.mouse.click(x, y, delay=50)
        elif action == "drag":
            start_payload = payload.get("from") or payload.get("start") or {}
            end_payload = payload.get("to") or payload.get("end") or {}
            start_x, start_y = self._payload_point(start_payload, record)
            end_x, end_y = self._payload_point(end_payload, record)
            await page.mouse.move(start_x, start_y)
            await page.mouse.down()
            await page.mouse.move(end_x, end_y, steps=18)
            await page.mouse.up()
        elif action == "key":
            key = str(payload.get("key") or "").strip()
            if key:
                await page.keyboard.press(key)
        elif action == "text":
            text = str(payload.get("text") or "")
            if text:
                await page.keyboard.type(text, delay=20)
        else:
            raise ValueError(f"Unsupported verification input type: {action}")

        await page.wait_for_timeout(600)
        await self._capture_record(record)
        return self._public(record)

    async def solve_drag_captcha(self, account_index: int, indices: list[int]) -> dict[str, Any]:
        record = self._records.get(account_index)
        if not record or record.released:
            return await self.status(account_index)
        result = await apply_doubao_drag_captcha_indices(record.session.page, indices)
        await record.session.page.wait_for_timeout(1_000)
        await self._capture_record(record)
        payload = self._public(record)
        payload["captcha_solution"] = result
        return payload

    async def render_bdturing_challenge(
        self,
        account_index: int,
        verification_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        record = self._records.get(account_index)
        if not record or record.released:
            return await self.status(account_index)
        context = dict(verification_context or record.verification_context or {})
        if not context.get("detail"):
            record.bdturing_render = {
                "object": "bdturing_verify_render",
                "render_called": False,
                "error": "verification_context.detail is missing.",
            }
            await self._capture_record(record)
            return self._public(record)
        record.verification_context = context
        await self._render_bdturing_challenge(record, context)
        await self._capture_record(record)
        return self._public(record)

    async def auto_verify(
        self,
        account_index: int,
        verification_context: dict[str, Any] | None = None,
        *,
        prompt: str = "Generate a simple product showcase video.",
        mode: str = "video",
        image_path: str | None = None,
        solve: bool = True,
    ) -> dict[str, Any]:
        record = self._records.get(account_index)
        if not record or record.released:
            return await self.status(account_index)

        context = dict(verification_context or record.verification_context or {})
        if context:
            record.verification_context = context
        workflow: dict[str, Any] = {
            "object": "manual_verification_auto_verify",
            "solve_requested": bool(solve),
            "steps": [],
        }
        record.auto_solve_result = workflow

        async def add_step(name: str, **data: Any) -> None:
            workflow["steps"].append({"name": name, **data})

        try:
            await self._capture_record(record)
            await add_step(
                "initial_capture",
                login_required=record.login_required,
                solver_compatible=self._drag_solver_ready(record),
            )
            if record.login_required:
                workflow["error"] = "Doubao page is not logged in."
                return self._public(record)

            if context.get("detail"):
                await self._render_bdturing_challenge(record, context)
                await self._capture_record(record)
                await add_step(
                    "token_render_before_frontend_trigger",
                    container_visible=bool((record.bdturing_render or {}).get("container_visible")),
                    token_success=self._bdturing_token_succeeded(record),
                    solver_compatible=self._drag_solver_ready(record),
                )
                if solve and self._bdturing_token_succeeded(record):
                    self._mark_bdturing_auto_solved(record, workflow)
                    return self._public(record)

            if solve and self._drag_solver_ready(record):
                await self._auto_solve_visible_drag_captcha(record, workflow)
                return self._public(record)

            if not self._visible_challenge_ready(record):
                normalized_mode = str(mode or "video").strip().lower()
                if image_path:
                    await self._trigger_doubao_image_video_generation(record, prompt, image_path)
                elif normalized_mode in {"image_video", "i2v", "image-to-video", "image_to_video"}:
                    raise ValueError("image_path is required for image-to-video frontend capture.")
                elif normalized_mode == "chat":
                    await self._trigger_doubao_message(record, prompt)
                else:
                    await self._trigger_doubao_video_generation(record, prompt)
                await record.session.page.wait_for_timeout(5_000)
                await self._capture_record(record)
                await add_step(
                    "frontend_video_trigger",
                    solver_compatible=self._drag_solver_ready(record),
                    visible_challenge=self._visible_challenge_ready(record),
                )
                if await self._frontend_video_confirmation_required(record.session.page):
                    await self._type_prompt_and_submit(
                        record.session.page,
                        "\u786e\u8ba4\uff0c\u5f00\u59cb\u751f\u6210",
                    )
                    accepted = await self._wait_for_frontend_generation_acceptance(record)
                    await self._capture_record(record)
                    await add_step(
                        "frontend_video_confirmation",
                        submitted=True,
                        accepted=accepted,
                    )

            if solve and self._drag_solver_ready(record):
                await self._auto_solve_visible_drag_captcha(record, workflow)
                return self._public(record)

            if context.get("detail") and not self._drag_solver_ready(record):
                await self._render_bdturing_challenge(record, context)
                await self._capture_record(record)
                await add_step(
                    "token_render_after_frontend_trigger",
                    container_visible=bool((record.bdturing_render or {}).get("container_visible")),
                    token_success=self._bdturing_token_succeeded(record),
                    solver_compatible=self._drag_solver_ready(record),
                )
                if solve and self._bdturing_token_succeeded(record):
                    self._mark_bdturing_auto_solved(record, workflow)
                    return self._public(record)

            if solve and self._drag_solver_ready(record):
                await self._auto_solve_visible_drag_captcha(record, workflow)
            elif solve:
                workflow["error"] = "No visible zhenxun-compatible Doubao drag captcha appeared."
        except Exception as exc:
            record.last_error = str(exc)
            record.message = f"Unable to auto verify Doubao challenge: {exc}"
            workflow["error"] = str(exc)
            with suppress(Exception):
                await self._capture_record(record)
        return self._public(record)

    async def _frontend_video_confirmation_required(self, page: Any) -> bool:
        try:
            body_text = await page.locator("body").inner_text(timeout=3_000)
        except Exception:
            return False
        lowered = str(body_text or "").lower()
        compact = "".join(lowered.split())
        chinese_markers = (
            "\u8bf7\u786e\u8ba4",
            "\u786e\u8ba4\u4ee5\u4e0b\u53c2\u6570",
            "\u786e\u8ba4\u53c2\u6570",
            "\u56de\u590d\u786e\u8ba4",
        )
        english_confirmation = (
            "pleaseconfirm" in compact
            and any(marker in compact for marker in ("startgenerating", "proceed", "confirmwith"))
        )
        return english_confirmation or any(marker in compact for marker in chinese_markers)

    async def _wait_for_frontend_generation_acceptance(
        self,
        record: ManualVerificationRecord,
        *,
        timeout_seconds: float = 25,
    ) -> bool:
        deadline = time.monotonic() + max(1.0, float(timeout_seconds))
        while time.monotonic() < deadline:
            try:
                body_text = await record.session.page.locator("body").inner_text(timeout=3_000)
            except Exception:
                body_text = ""
            terms = manual_success_terms_from_text(body_text)
            if terms:
                record.manual_success_terms = terms
                record.message = "Frontend video generation was accepted by Doubao."
                record.updated_at = time.time()
                return True
            await record.session.page.wait_for_timeout(1_500)
        return False

    def _drag_solver_ready(self, record: ManualVerificationRecord) -> bool:
        return bool(record.captcha_probe and record.captcha_probe.get("solver_compatible"))

    def _visible_challenge_ready(self, record: ManualVerificationRecord) -> bool:
        return bool(
            self._drag_solver_ready(record)
            or record.detected_terms
            or (record.bdturing_render or {}).get("container_visible")
        )

    def _bdturing_token_succeeded(self, record: ManualVerificationRecord) -> bool:
        result = record.bdturing_result if isinstance(record.bdturing_result, dict) else {}
        return str(result.get("status") or "").lower() == "success"

    def _mark_bdturing_auto_solved(
        self,
        record: ManualVerificationRecord,
        workflow: dict[str, Any],
    ) -> None:
        solve_result = {
            "object": "doubao_bdturing_token_auto_solve",
            "attempted": True,
            "solved": True,
            "backend": "bdturing_token_render",
            "classification": None,
            "drag_result": None,
            "probe": record.captcha_probe,
            "bdturing_render": record.bdturing_render,
            "bdturing_result": record.bdturing_result,
            "error": None,
        }
        workflow["captcha_solution"] = solve_result
        workflow["steps"].append(
            {
                "name": "auto_solve_bdturing_token",
                "attempted": True,
                "solved": True,
                "error": None,
            }
        )
        record.auto_solve_result = workflow
        record.message = "Doubao BDTuring token verification was auto-solved in the current account page."

    async def _auto_solve_visible_drag_captcha(
        self,
        record: ManualVerificationRecord,
        workflow: dict[str, Any],
    ) -> None:
        solve_result = await solve_doubao_drag_captcha_if_present(record.session.page)
        record.auto_solve_result = workflow
        workflow["captcha_solution"] = solve_result
        workflow["steps"].append(
            {
                "name": "auto_solve_drag_captcha",
                "attempted": bool(solve_result.get("attempted")),
                "solved": bool(solve_result.get("solved")),
                "error": solve_result.get("error"),
            }
        )
        await record.session.page.wait_for_timeout(1_000)
        await self._capture_record(record)
        if solve_result.get("solved"):
            record.message = "Doubao drag captcha was auto-solved in the current account page."
        elif solve_result.get("error"):
            record.message = f"Doubao drag captcha auto-solve failed: {solve_result.get('error')}"

    async def _trigger_doubao_image_video_generation(
        self,
        record: ManualVerificationRecord,
        prompt: str,
        image_path: str,
    ) -> None:
        page = record.session.page
        path = self._resolve_upload_image_path(image_path)
        await self._ensure_doubao_chat_page(page)
        await self._dismiss_doubao_onboarding_overlays(page)
        await self._open_doubao_video_generation_tool(page)
        await self._dismiss_doubao_onboarding_overlays(page)
        upload_result = await self._upload_reference_image_in_page(page, path)
        await page.wait_for_timeout(4_000)
        await self._type_prompt_and_submit(page, prompt)
        record.message = (
            "Image-to-video frontend probe sent; "
            f"upload={upload_result.get('method', 'unknown')} file={path.name}."
        )

    async def _ensure_doubao_chat_page(self, page: Any) -> None:
        if "doubao.com" not in page.url:
            await page.goto("https://www.doubao.com/chat/", wait_until="domcontentloaded", timeout=60_000)
            with suppress(PlaywrightTimeoutError):
                await page.wait_for_load_state("networkidle", timeout=8_000)

    async def _dismiss_doubao_onboarding_overlays(self, page: Any) -> None:
        labels = (
            "\u5f00\u59cb\u4f53\u9a8c",
            "\u6211\u77e5\u9053\u4e86",
            "\u77e5\u9053\u4e86",
            "\u7acb\u5373\u4f53\u9a8c",
        )
        for _ in range(3):
            dismissed = False
            for label in labels:
                locators = (
                    page.get_by_role("button", name=label, exact=True),
                    page.locator("button").filter(has_text=label),
                    page.get_by_text(label, exact=True),
                )
                for locator in locators:
                    try:
                        if await locator.count() <= 0 or not await locator.last.is_visible():
                            continue
                        await locator.last.click(timeout=3_000)
                        await page.wait_for_timeout(600)
                        dismissed = True
                        break
                    except Exception:
                        continue
                if dismissed:
                    break
            if not dismissed:
                return

    async def _render_bdturing_challenge(
        self,
        record: ManualVerificationRecord,
        context: dict[str, Any],
    ) -> None:
        page = record.session.page
        await self._ensure_doubao_chat_page(page)
        verify_data = self._bdturing_verify_data(context)
        fp = self._verification_fp(context) or str(verify_data.get("fp") or "")
        if fp:
            verify_data.setdefault("fp", fp)
        record.bdturing_render_count += 1
        try:
            result = await page.evaluate(
                """async ({ verifyData, fp, rawDetail }) => {
                    const result = {
                        object: "bdturing_verify_render",
                        render_called: false,
                        render_method: "",
                        sdk_loaded: false,
                        sdk_available: false,
                        fp: fp || "",
                        verify_data_keys: Object.keys(verifyData || {}),
                        attempts: [],
                        container_present: false,
                        container_visible: false,
                        image_count: 0,
                        error: null,
                    };
                    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                    const loadScript = (src) => new Promise((resolve, reject) => {
                        if (window.verifySDK && typeof window.verifySDK.autoRender === "function") {
                            resolve("already_loaded");
                            return;
                        }
                        const existing = Array.from(document.scripts).find((script) => script.src === src);
                        if (existing) {
                            existing.addEventListener("load", () => resolve("existing_loaded"), { once: true });
                            existing.addEventListener("error", () => reject(new Error("existing script failed")), { once: true });
                            return;
                        }
                        const script = document.createElement("script");
                        script.src = src;
                        script.async = true;
                        script.crossOrigin = "anonymous";
                        script.onload = () => resolve("loaded");
                        script.onerror = () => reject(new Error(`Failed to load ${src}`));
                        document.head.appendChild(script);
                    });

                    const sdkUrls = [
                        "https://lf-rc1.yhgfb-cn-static.com/obj/rc-verifycenter/verifycenter/@latest/index.js",
                        "https://lf-rc2.yhgfb-cn-static.com/obj/rc-verifycenter/verifycenter/@latest/index.js",
                        "https://lf-cdn-tos.bytescm.com/obj/rc-verifycenter/verifycenter/@latest/index.js",
                    ];
                    let lastError = null;
                    for (const url of sdkUrls) {
                        try {
                            await loadScript(url);
                            result.sdk_loaded = true;
                            break;
                        } catch (error) {
                            lastError = error;
                        }
                    }
                    const sdk = window.verifySDK;
                    result.sdk_available = !!sdk;
                    if (!sdk) {
                        throw lastError || new Error("window.verifySDK is not available.");
                    }

                    window.__doubaoManualVerifyResult = null;
                    const onSuccess = () => {
                        window.__doubaoManualVerifyResult = { status: "success", at: Date.now() };
                    };
                    const onClose = () => {
                        window.__doubaoManualVerifyResult = { status: "closed", at: Date.now() };
                    };
                    const commonOptions = {
                        aid: "497858",
                        iid: "0",
                        did: "0",
                        repoId: "doubao_message_web",
                    };
                    const initOptions = {
                        commonOptions,
                        captchaOptions: {
                            fp: fp || "",
                            showMode: "mask",
                            successCb: onSuccess,
                            closeCb: onClose,
                        },
                    };
                    try {
                        if (typeof sdk.initVerifyOptions === "function") {
                            sdk.initVerifyOptions(initOptions);
                            result.render_method = "verifySDK.initVerifyOptions+autoRender";
                        } else if (typeof sdk.init === "function") {
                            sdk.init(initOptions);
                            result.render_method = "verifySDK.init+autoRender";
                        } else if (typeof sdk.initVerifyCenter === "function") {
                            const center = sdk.initVerifyCenter(initOptions);
                            if (center && typeof center.autoRender === "function") {
                                sdk.__manualCenter = center;
                            }
                            result.render_method = "verifySDK.initVerifyCenter";
                        }
                    } catch (error) {
                        result.attempts.push({ phase: "init", error: String(error && error.message || error) });
                    }

                    const verifyJson = JSON.stringify(verifyData || {});
                    const candidates = [verifyJson];
                    if (rawDetail && !candidates.includes(rawDetail)) candidates.push(rawDetail);
                    for (const verifyDataText of candidates) {
                        try {
                            const payload = {
                                verify_data: verifyDataText,
                                captchaOptions: {
                                    fp: fp || "",
                                    showMode: "mask",
                                    successCb: onSuccess,
                                    closeCb: onClose,
                                },
                                secondVerifyWebOptions: {
                                    callBack: onSuccess,
                                    closeCallBack: onClose,
                                },
                            };
                            if (sdk.__manualCenter && typeof sdk.__manualCenter.autoRender === "function") {
                                sdk.__manualCenter.autoRender(payload);
                                result.render_called = true;
                                result.render_method = result.render_method || "verifyCenter.autoRender";
                            } else if (typeof sdk.autoRender === "function") {
                                sdk.autoRender(payload);
                                result.render_called = true;
                                result.render_method = result.render_method || "verifySDK.autoRender";
                            } else if (typeof sdk.render === "function") {
                                sdk.render(payload);
                                result.render_called = true;
                                result.render_method = result.render_method || "verifySDK.render";
                            } else {
                                throw new Error("verifySDK has no autoRender/render method.");
                            }
                            await sleep(1800);
                            const container = document.querySelector("#captcha_container");
                            const iframe = container ? container.querySelector("iframe") : null;
                            const visible = !!container && (() => {
                                const rect = container.getBoundingClientRect();
                                const style = window.getComputedStyle(container);
                                return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
                            })();
                            result.attempts.push({
                                verify_data_kind: verifyDataText === verifyJson ? "decision_json" : "raw_detail",
                                container_present: !!container,
                                container_visible: visible,
                                iframe_present: !!iframe,
                            });
                            if (visible) break;
                        } catch (error) {
                            result.attempts.push({
                                verify_data_kind: verifyDataText === verifyJson ? "decision_json" : "raw_detail",
                                error: String(error && error.message || error),
                            });
                        }
                    }
                    const container = document.querySelector("#captcha_container");
                    result.container_present = !!container;
                    if (container) {
                        const rect = container.getBoundingClientRect();
                        const style = window.getComputedStyle(container);
                        result.container_visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
                    }
                    try {
                        const frame = document.querySelector("#captcha_container iframe");
                        result.iframe_present = !!frame;
                    } catch (_) {}
                    return result;
                }""",
                {
                    "verifyData": verify_data,
                    "fp": fp,
                    "rawDetail": str(context.get("detail") or ""),
                },
            )
            if isinstance(result, dict):
                result["attempt_count"] = record.bdturing_render_count
                record.bdturing_render = result
            else:
                record.bdturing_render = {
                    "object": "bdturing_verify_render",
                    "render_called": False,
                    "error": "Unexpected render result.",
                    "attempt_count": record.bdturing_render_count,
                }
        except Exception as exc:
            record.bdturing_render = {
                "object": "bdturing_verify_render",
                "render_called": False,
                "error": str(exc),
                "attempt_count": record.bdturing_render_count,
            }

    def _bdturing_verify_data(self, context: dict[str, Any]) -> dict[str, Any]:
        data: dict[str, Any] = {}
        for key in BDTURING_VERIFY_DATA_KEYS:
            value = context.get(key)
            if value is not None and value != "":
                data[key] = value
        if "version" not in data:
            data["version"] = ""
        fp = self._verification_fp(context)
        if fp:
            data.setdefault("fp", fp)
        return data

    def _verification_fp(self, context: dict[str, Any]) -> str:
        for key in ("fp", "fingerprint"):
            value = str(context.get(key) or "").strip()
            if value.startswith("verify_"):
                return value
        for key in ("trigger_request_url", "request_url", "template_request_url"):
            value = str(context.get(key) or "")
            if not value:
                continue
            with suppress(Exception):
                query = parse_qs(urlparse(value).query)
                candidate = str((query.get("fp") or [""])[0]).strip()
                if candidate.startswith("verify_"):
                    return candidate
        return ""

    async def _open_doubao_video_generation_tool(self, page: Any) -> None:
        clicked = False
        button_locators = (
            page.get_by_role("button", name="\u89c6\u9891\u751f\u6210", exact=True),
            page.get_by_text("\u89c6\u9891\u751f\u6210", exact=True),
            page.locator("button").filter(has_text="\u89c6\u9891\u751f\u6210"),
            page.get_by_role("button", name="瑙嗛鐢熸垚", exact=True),
            page.get_by_text("瑙嗛鐢熸垚", exact=True),
            page.locator("button").filter(has_text="瑙嗛鐢熸垚"),
        )
        for locator in button_locators:
            try:
                if await locator.count() <= 0:
                    continue
                await locator.last.scroll_into_view_if_needed(timeout=2_000)
                await locator.last.click(timeout=3_000)
                clicked = True
                break
            except Exception:
                continue

        if not clicked:
            viewport = page.viewport_size or {"width": 1280, "height": 720}
            await page.mouse.click(float(viewport["width"]) * 0.70, float(viewport["height"]) * 0.95)

    def _resolve_upload_image_path(self, value: str) -> Path:
        text = str(value or "").strip()
        if not text:
            raise ValueError("image_path is required.")
        path = Path(text)
        if not path.is_absolute():
            path = Path.cwd() / path
        path = path.resolve()
        if not path.is_file():
            raise ValueError(f"image_path does not exist: {path}")
        if path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
            raise ValueError(f"image_path must be a png/jpg/jpeg/webp file: {path}")
        return path

    async def _upload_reference_image_in_page(self, page: Any, path: Path) -> dict[str, Any]:
        result = await self._try_set_image_file_input(page, path)
        if result.get("uploaded"):
            return result

        await self._click_upload_entry(page)
        await page.wait_for_timeout(700)
        result = await self._try_set_image_file_input(page, path)
        if result.get("uploaded"):
            return result

        raise RuntimeError(
            "Unable to find a Doubao image file input after opening upload controls. "
            f"inputs={result.get('inputs')}"
        )

    async def _try_set_image_file_input(self, page: Any, path: Path) -> dict[str, Any]:
        inputs = await self._file_input_candidates(page)
        locator = page.locator("input[type='file']")
        total = await locator.count()
        preferred_indexes: list[int] = []
        fallback_indexes: list[int] = []
        for index, item in enumerate(inputs):
            accept = str(item.get("accept") or "").lower()
            multiple = bool(item.get("multiple"))
            if any(marker in accept for marker in ("image", ".png", ".jpg", ".jpeg", ".webp")):
                preferred_indexes.append(index)
            elif not accept or multiple:
                fallback_indexes.append(index)

        for index in [*preferred_indexes, *fallback_indexes, *range(len(inputs), total)]:
            try:
                await locator.nth(index).set_input_files(str(path), timeout=8_000)
                return {"uploaded": True, "method": "input[type=file]", "index": index, "inputs": inputs}
            except Exception as exc:
                logger.debug(f"Doubao frontend file input candidate failed: index={index}, error={exc}")
                continue
        return {"uploaded": False, "inputs": inputs}

    async def _file_input_candidates(self, page: Any) -> list[dict[str, Any]]:
        try:
            result = await page.evaluate(
                """() => Array.from(document.querySelectorAll('input[type="file"]')).map((el, index) => {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return {
                        index,
                        accept: el.getAttribute('accept') || '',
                        multiple: !!el.multiple,
                        name: el.getAttribute('name') || '',
                        id: el.id || '',
                        className: String(el.className || '').slice(0, 160),
                        visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
                        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                    };
                })"""
            )
            return result if isinstance(result, list) else []
        except Exception:
            return []

    async def _click_upload_entry(self, page: Any) -> None:
        selectors = (
            "button[aria-label*='\u4e0a\u4f20']",
            "button[aria-label*='\u56fe\u7247']",
            "[role='button'][aria-label*='\u4e0a\u4f20']",
            "[role='button'][aria-label*='\u56fe\u7247']",
            "button:has-text('\u4e0a\u4f20')",
            "button:has-text('\u56fe\u7247')",
        )
        for selector in selectors:
            try:
                locator = page.locator(selector).last
                if await locator.count() <= 0:
                    continue
                await locator.scroll_into_view_if_needed(timeout=1_500)
                await locator.click(timeout=2_000)
                return
            except Exception:
                continue

        viewport = page.viewport_size or {"width": 1280, "height": 720}
        # The Doubao chat input uses a small "+" button at the lower-left of the input composer.
        await page.mouse.click(float(viewport["width"]) * 0.32, float(viewport["height"]) * 0.94)

    async def _trigger_doubao_video_generation(self, record: ManualVerificationRecord, prompt: str) -> None:
        page = record.session.page
        await self._ensure_doubao_chat_page(page)
        await self._dismiss_doubao_onboarding_overlays(page)
        await self._open_doubao_video_generation_tool(page)
        await page.wait_for_timeout(800)
        await self._type_prompt_and_submit(page, prompt)

    async def _trigger_doubao_message(self, record: ManualVerificationRecord, prompt: str) -> None:
        page = record.session.page
        if "doubao.com" not in page.url:
            await page.goto("https://www.doubao.com/chat/", wait_until="domcontentloaded", timeout=60_000)
            with suppress(PlaywrightTimeoutError):
                await page.wait_for_load_state("networkidle", timeout=8_000)

        await self._type_prompt_and_submit(page, prompt)

    async def _type_prompt_and_submit(self, page: Any, prompt: str) -> None:
        selectors = (
            "[data-slate-editor=true]",
            "textarea[placeholder*='发消息']",
            "textarea[placeholder*='消息']",
            "textarea[placeholder*='说话']",
            "textarea[placeholder*='描述']",
            "div[contenteditable='true'][data-placeholder*='发消息']",
            "div[contenteditable='true'][aria-label*='发消息']",
            "div[contenteditable='true'][data-placeholder*='描述']",
            "div[contenteditable='true']",
            "div[role='textbox']",
            "textarea",
        )
        for selector in selectors:
            locator = page.locator(selector).last
            try:
                if await locator.count() <= 0:
                    continue
                await locator.scroll_into_view_if_needed(timeout=2_000)
                await locator.click(timeout=3_000)
                await page.keyboard.type(prompt, delay=25)
                await page.wait_for_timeout(300)
                if await self._click_doubao_send_button(page):
                    return
                await page.keyboard.press("Enter")
                return
            except Exception:
                continue

        viewport = page.viewport_size or {"width": 1280, "height": 720}
        await page.mouse.click(float(viewport["width"]) * 0.66, float(viewport["height"]) * 0.94)
        await page.keyboard.type(prompt, delay=25)
        await page.wait_for_timeout(300)
        if not await self._click_doubao_send_button(page):
            await page.keyboard.press("Enter")

    async def _click_doubao_send_button(self, page: Any) -> bool:
        locators = (
            page.locator("button#flow-end-msg-send"),
            page.locator("[id='flow-end-msg-send']"),
            page.get_by_role("button", name="\u53d1\u9001"),
            page.locator("button").filter(has_text="\u53d1\u9001"),
        )
        for locator in locators:
            try:
                if await locator.count() <= 0:
                    continue
                target = locator.last
                await target.scroll_into_view_if_needed(timeout=1_500)
                box = await target.bounding_box(timeout=1_500)
                if box:
                    await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=8)
                    await page.mouse.down()
                    await page.wait_for_timeout(90)
                    await page.mouse.up()
                else:
                    await target.click(timeout=2_000)
                return True
            except Exception:
                continue
        return False

    async def _capture_loop(self, record: ManualVerificationRecord) -> None:
        assert record.stop_event is not None
        try:
            while not record.stop_event.is_set():
                remaining = record.expires_at - time.time()
                if remaining <= 0:
                    record.message = "Manual verification session expired."
                    await self._release(record, "expired")
                    return
                try:
                    await asyncio.wait_for(
                        record.stop_event.wait(),
                        timeout=min(record.snapshot_interval_seconds, remaining),
                    )
                    break
                except asyncio.TimeoutError:
                    if record.light_video_wait:
                        record.updated_at = time.time()
                        continue
                    await self._capture_record(record)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            record.last_error = str(exc)
            logger.warning(f"Manual verification snapshot loop failed: account={record.account_index}, error={exc}")

    async def _capture_record(self, record: ManualVerificationRecord) -> None:
        self.snapshot_dir.mkdir(parents=True, exist_ok=True)
        page = record.session.page
        timestamp = time.strftime("%Y%m%d-%H%M%S")
        filename = f"account-{record.account_index}-{record.session.profile_id}-{timestamp}.png"
        snapshot_path = self.snapshot_dir / filename
        body_text = ""

        try:
            record.url = page.url
            record.title = await page.title()
            with suppress(Exception):
                body_text = await page.locator("body").inner_text(timeout=2_000)
            await page.screenshot(path=str(snapshot_path), full_page=False)
            viewport_size = page.viewport_size or {}
            record.snapshot_width = int(viewport_size.get("width") or 1280)
            record.snapshot_height = int(viewport_size.get("height") or 720)
            record.snapshot_path = str(snapshot_path)
            record.snapshot_url = f"/v1/account-pool/verification-snapshots/{filename}"
            record.snapshot_capture_count += 1
            record.updated_at = time.time()
            record.detected_terms = tuple(term for term in VERIFY_TERMS if term.lower() in body_text.lower())
            record.manual_success_terms = manual_success_terms_from_text(body_text)
            record.captcha_probe = await probe_doubao_drag_captcha(page)
            with suppress(Exception):
                bdturing_result = await page.evaluate("() => window.__doubaoManualVerifyResult || null")
                if isinstance(bdturing_result, dict):
                    record.bdturing_result = bdturing_result
            record.login_probe = await self._probe_login_required(page, body_text)
            record.login_required = bool(record.login_probe.get("login_required"))
            record.login_terms = tuple(record.login_probe.get("terms") or ())
            if record.captcha_probe.get("solver_compatible"):
                record.visual_challenge_seen = True
            record.message = self._active_message(record)
            metadata = {
                "account_index": record.account_index,
                "profile_id": record.session.profile_id,
                "status": record.status,
                "url": record.url,
                "title": record.title,
                "headless": record.headless,
                "updated_at": record.updated_at,
                "detected_terms": list(record.detected_terms),
                "manual_success_terms": list(record.manual_success_terms),
                "captcha_probe": record.captcha_probe,
                "visual_challenge_seen": record.visual_challenge_seen,
                "login_required": record.login_required,
                "login_terms": list(record.login_terms),
                "login_probe": record.login_probe,
                "bdturing_render": record.bdturing_render,
                "bdturing_result": record.bdturing_result,
                "auto_solve_result": record.auto_solve_result,
                "video_signals": record.video_signals,
                "snapshot_width": record.snapshot_width,
                "snapshot_height": record.snapshot_height,
            }
            snapshot_path.with_suffix(".json").write_text(
                json.dumps(metadata, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:
            record.last_error = str(exc)
            record.updated_at = time.time()
            raise

    async def _release(self, record: ManualVerificationRecord, status: str) -> None:
        if record.released:
            record.status = status
            return
        record.status = status
        record.released = True
        record.updated_at = time.time()
        if record.stop_event:
            record.stop_event.set()
        task = record.task
        current_task = asyncio.current_task()
        if task and task is not current_task and not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

        with suppress(Exception):
            storage_path = PlaywrightManager._storage_state_path(record.session.profile_id)
            storage_path.parent.mkdir(parents=True, exist_ok=True)
            await record.session.context.storage_state(path=str(storage_path))
        with suppress(Exception):
            if record.request_handler:
                record.session.page.remove_listener("request", record.request_handler)
            if record.response_handler:
                record.session.page.remove_listener("response", record.response_handler)
        if record.lock_acquired and record.session.lock.locked():
            record.session.lock.release()
            record.lock_acquired = False
        manager = PlaywrightManager()
        with suppress(Exception):
            await manager._release_session(record.session)
        with suppress(Exception):
            await manager.close_account_session(record.cookie)

    def _active_message(self, record: ManualVerificationRecord) -> str:
        if record.status != "active":
            return record.message or record.status
        mode = "headless snapshot" if record.headless else "headed browser"
        if record.login_required:
            return f"Doubao page is not logged in in {mode}; click Login and finish after the account is signed in."
        if record.auto_solve_result:
            solution = record.auto_solve_result.get("captcha_solution") or {}
            if solution.get("solved"):
                if solution.get("backend") == "bdturing_token_render":
                    return f"Doubao BDTuring token verification was auto-solved in {mode}."
                return f"Doubao drag captcha was auto-solved in {mode}."
            if solution.get("attempted"):
                return f"Doubao drag captcha auto-solve was attempted in {mode}."
        if self._bdturing_token_succeeded(record):
            return f"Doubao BDTuring token verification succeeded in {mode}."
        if record.manual_success_terms:
            return f"Manual Doubao video generation success observed in {mode}."
        if record.captcha_probe and record.captcha_probe.get("solver_compatible"):
            return f"Doubao drag captcha detected in {mode}."
        if record.bdturing_render and record.bdturing_render.get("render_called"):
            if record.bdturing_render.get("container_visible"):
                return f"Doubao token verification challenge rendered in {mode}."
            return f"Doubao token verification render was attempted in {mode}; no visible challenge yet."
        if record.detected_terms:
            return f"Verification page detected in {mode}."
        return f"Manual verification session is open in {mode}."

    async def _probe_login_required(self, page: Any, body_text: str) -> dict[str, Any]:
        probe: dict[str, Any] = {
            "login_required": False,
            "terms": [],
            "login_button_visible": False,
            "matched_buttons": [],
            "user_indicator_visible": False,
            "error": None,
        }
        lowered = (body_text or "").lower()
        terms = [term for term in LOGIN_REQUIRED_TERMS if term.lower() in lowered]
        probe["terms"] = terms
        try:
            dom_probe = await page.evaluate(
                """() => {
                    const loginTexts = [
                        "\\u767b\\u5f55",
                        "\\u7acb\\u5373\\u767b\\u5f55",
                        "\\u8bf7\\u5148\\u767b\\u5f55"
                    ];
                    const userTexts = [
                        "\\u7528\\u6237",
                        "\\u4e2a\\u4eba\\u4e2d\\u5fc3",
                        "\\u9000\\u51fa\\u767b\\u5f55"
                    ];
                    const visible = (el) => {
                        const style = window.getComputedStyle(el);
                        if (!style || style.visibility === "hidden" || style.display === "none" || Number(style.opacity || 1) === 0) {
                            return false;
                        }
                        const rect = el.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0;
                    };
                    const nodes = Array.from(document.querySelectorAll("button,a,[role='button'],[class*='login'],[data-testid*='login']"));
                    const buttons = nodes
                        .filter(visible)
                        .map((el) => ({
                            text: (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " "),
                            tag: el.tagName,
                            className: String(el.className || "").slice(0, 160),
                        }))
                        .filter((item) => item.text);
                    const matchedButtons = buttons.filter((item) => loginTexts.includes(item.text));
                    const bodyText = document.body ? document.body.innerText || "" : "";
                    const userIndicatorVisible = userTexts.some((text) => bodyText.includes(text));
                    return {
                        login_button_visible: matchedButtons.length > 0,
                        matched_buttons: matchedButtons.slice(0, 10),
                        visible_button_texts: buttons.map((item) => item.text).slice(0, 30),
                        user_indicator_visible: userIndicatorVisible,
                    };
                }"""
            )
            if isinstance(dom_probe, dict):
                probe.update(dom_probe)
        except Exception as exc:
            probe["error"] = str(exc)
        probe["login_required"] = bool(probe.get("login_button_visible")) and not bool(
            probe.get("user_indicator_visible")
        )
        return probe

    def _install_context_recording(self, record: ManualVerificationRecord) -> None:
        page = record.session.page
        if record.request_handler or record.response_handler:
            return

        def on_request(request: Any) -> None:
            asyncio.create_task(self._record_chat_completion_request(record, request))

        def on_response(response: Any) -> None:
            asyncio.create_task(self._record_chat_completion_response(record, response))

        record.request_handler = on_request
        record.response_handler = on_response
        page.on("request", on_request)
        page.on("response", on_response)

    async def _record_chat_completion_request(self, record: ManualVerificationRecord, request: Any) -> None:
        try:
            url = str(getattr(request, "url", "") or "")
            if "/chat/completion" not in url or "doubao.com" not in url:
                return
            method = str(getattr(request, "method", "") or "")
            headers = await self._maybe_await(getattr(request, "headers", {}) or {})
            payload = await self._maybe_await(getattr(request, "post_data", None))
            template = build_context_template(
                account_index=record.account_index,
                profile_id=record.session.profile_id,
                request_url=url,
                method=method,
                headers=headers if isinstance(headers, dict) else {},
                payload=payload,
                source="frontend_page",
            )
            paths = save_context_template(template)
            record.context_capture_count += 1
            record.latest_context_template = template
            record.latest_context_template_path = paths.get("latest_path")
            record.updated_at = time.time()
            logger.info(
                f"Captured Doubao frontend /chat/completion context: "
                f"account={record.account_index}, path={record.latest_context_template_path}"
            )
        except Exception as exc:
            logger.warning(f"Unable to record Doubao chat completion context: {exc}")

    async def _record_chat_completion_response(self, record: ManualVerificationRecord, response: Any) -> None:
        try:
            url = str(getattr(response, "url", "") or "")
            if "/im/chain/single" in url and "doubao.com" in url:
                await self._record_chain_response(record, response)
                return
            if "/chat/completion" not in url or "doubao.com" not in url:
                return
            if not record.latest_context_template:
                return
            headers = await self._maybe_await(getattr(response, "headers", {}) or {})
            status = await self._maybe_await(getattr(response, "status", None))
            record.latest_context_template["response"] = {
                "status": status,
                "headers": {
                    str(key): ("[REDACTED]" if "token" in str(key).lower() else str(value)[:1000])
                    for key, value in (headers if isinstance(headers, dict) else {}).items()
                },
                "captured_at": time.time(),
            }
            paths = save_context_template(record.latest_context_template)
            record.latest_context_template_path = paths.get("latest_path")
        except Exception as exc:
            logger.debug(f"Unable to update Doubao chat completion response context: {exc}")

    async def _record_chain_response(self, record: ManualVerificationRecord, response: Any) -> None:
        try:
            body = await self._maybe_await(getattr(response, "text", None))
            data = json.loads(str(body or ""))
            from app.providers.video_provider import empty_video_signals, extract_video_signals

            incoming = extract_video_signals(data)
            merged = record.video_signals or empty_video_signals()
            for key, default in empty_video_signals().items():
                merged.setdefault(key, [] if isinstance(default, list) else default)
            for key in (
                "task_ids",
                "video_ids",
                "video_urls",
                "conversation_ids",
                "failures",
                "non_video_results",
                "quota",
                "verification",
            ):
                for item in incoming.get(key) or []:
                    if item not in merged[key]:
                        merged[key].append(item)
            merged["status"] = incoming.get("status") or merged.get("status")
            merged["saw_video_intent"] = bool(
                merged.get("saw_video_intent") or incoming.get("saw_video_intent")
            )
            record.video_signals = merged
            record.updated_at = time.time()
            if merged.get("video_urls") and record.video_result_event:
                record.video_result_event.set()
        except Exception as exc:
            logger.debug(f"Unable to record Doubao frontend chain response: {exc}")

    async def _maybe_await(self, value: Any) -> Any:
        if callable(value):
            value = value()
        if inspect.isawaitable(value):
            return await value
        return value

    def _payload_point(self, payload: dict[str, Any], record: ManualVerificationRecord) -> tuple[float, float]:
        width = float(record.snapshot_width or 1280)
        height = float(record.snapshot_height or 720)
        x = float(payload.get("x"))
        y = float(payload.get("y"))
        normalized = payload.get("normalized", True)
        if normalized is not False:
            x *= width
            y *= height
        return (
            min(max(x, 0.0), width),
            min(max(y, 0.0), height),
        )

    def _public(self, record: ManualVerificationRecord) -> dict[str, Any]:
        return {
            "object": "manual_verification",
            "account_index": record.account_index,
            "profile_id": record.session.profile_id,
            "status": record.status,
            "message": record.message,
            "headless": record.headless,
            "started_at": record.started_at,
            "expires_at": record.expires_at,
            "updated_at": record.updated_at,
            "url": record.url,
            "title": record.title,
            "snapshot_url": record.snapshot_url,
            "snapshot_width": record.snapshot_width,
            "snapshot_height": record.snapshot_height,
            "last_error": record.last_error,
            "detected_terms": list(record.detected_terms),
            "manual_success_detected": bool(record.manual_success_terms),
            "manual_success_terms": list(record.manual_success_terms),
            "captcha_probe": record.captcha_probe,
            "visual_challenge_seen": record.visual_challenge_seen,
            "login_required": record.login_required,
            "login_terms": list(record.login_terms),
            "login_probe": record.login_probe,
            "bdturing_render": record.bdturing_render,
            "bdturing_result": record.bdturing_result,
            "bdturing_render_count": record.bdturing_render_count,
            "auto_solve_result": record.auto_solve_result,
            "video_signals": record.video_signals,
            "light_video_wait": record.light_video_wait,
            "light_video_wait_started_at": record.light_video_wait_started_at,
            "snapshot_capture_count": record.snapshot_capture_count,
            "context_capture_count": record.context_capture_count,
            "latest_context_template_path": record.latest_context_template_path,
            "latest_context_template": context_summary_for_public(
                record.latest_context_template
                or load_latest_context_template(record.account_index)
            ),
        }
