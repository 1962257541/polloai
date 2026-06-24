import asyncio
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

import main
from app.core.config import settings
from app.routes import account_pool as account_pool_routes
from app.services.credential_manager import CredentialManager
from app.services.playwright_manager import PlaywrightManager


@pytest.fixture(autouse=True)
def reset_browser_profile_pool(monkeypatch, tmp_path):
    manager = PlaywrightManager()
    monkeypatch.setattr(settings, "DOUBAO_BROWSER_PROFILE_DIR", str(tmp_path / "browser-profiles"))
    manager._initialized = False
    manager._pool_lock = asyncio.Lock()
    manager._pool_condition = asyncio.Condition(manager._pool_lock)
    manager.sessions = {}
    manager.profile_records = {}
    manager.profile_identities = {}
    manager.ms_token = None
    manager.ms_tokens = {}
    manager.account_device_fingerprints = {}
    manager._cleanup_task = None
    manager.context = None
    manager.page = None
    manager.active_identity = None
    yield


def test_quota_payload_parser_reads_only_configured_paths_or_video_context(monkeypatch):
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_REMAINING_PATH", "data.wallet.remaining")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_TOTAL_PATH", "data.wallet.total")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_USED_PATH", "data.wallet.used")

    parsed = main._parse_quota_payload({"data": {"wallet": {"remaining": "82", "total": 100, "used": 18}}})
    assert parsed == {"total": 100.0, "remaining": 82.0, "used": 18.0}

    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_REMAINING_PATH", "")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_TOTAL_PATH", "")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_USED_PATH", "")
    monkeypatch.setattr(
        main.settings,
        "DOUBAO_QUOTA_ENDPOINT",
        "https://www.doubao.com/samantha/video/query_video_gen_info",
    )
    generic_credit = main._parse_quota_payload({"payload": {"balance": "3.5 credits", "limit": 10}})
    assert generic_credit == {"total": None, "remaining": None, "used": None}

    video_info = main._parse_quota_payload({"data": {"remain_count": 10, "has_generating_task": False}})
    assert video_info == {"total": None, "remaining": None, "used": None}

    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_REMAINING_PATH", "data.remain_count")
    explicit_video_info = main._parse_quota_payload({"data": {"remain_count": 10, "has_generating_task": False}})
    assert explicit_video_info == {"total": None, "remaining": 10.0, "used": None}
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_REMAINING_PATH", "")

    video_quota = main._parse_quota_payload(
        {"data": {"video_gen_info": {"remaining_count": 8, "total_count": 10, "used_count": 2}}}
    )
    assert video_quota == {"total": 10.0, "remaining": 8.0, "used": 2.0}

    remaining_only = main._parse_quota_payload({"data": {"video_gen_info": {"remaining_count": 2}}})
    assert remaining_only == {"total": None, "remaining": 2.0, "used": None}

    monkeypatch.setattr(
        main.settings,
        "DOUBAO_QUOTA_ENDPOINT",
        "https://www.doubao.com/commerce/benefit_supply/credit/get_credit_num_optional_tasks",
    )
    non_video_remain_count = main._parse_quota_payload({"data": {"remain_count": 10}})
    assert non_video_remain_count == {"total": None, "remaining": None, "used": None}

    benefit_credit = main._parse_quota_payload({"data": {"credit_info": {"total_credit_num": 0}}})
    assert benefit_credit == {"total": None, "remaining": None, "used": None}

    benefit_video_credit = main._parse_quota_payload(
        {
            "data": {
                "credit_info": {
                    "credit_desc_text": "积分可用于视频生成等功能",
                    "credit_text": "积分",
                    "total_credit_num": 0,
                }
            }
        }
    )
    assert benefit_video_credit == {"total": None, "remaining": 0.0, "used": None}
    assert main._quota_business_error({"code": 710012001, "message": "login invalid"})


@pytest.mark.asyncio
async def test_account_pool_management_api(monkeypatch):
    manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        weights=[1, 2],
        max_concurrency=[1, 3],
        global_concurrency=2,
    )
    monkeypatch.setattr(main, "provider", SimpleNamespace(credential_manager=manager))
    monkeypatch.setattr(main, "video_provider", None)

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        status = await client.get("/v1/account-pool")
        assert status.status_code == 200
        payload = status.json()
        assert payload["enabled"] is True
        assert payload["account_count"] == 2
        assert payload["accounts"][1]["weight"] == 2
        assert payload["quota_refresh"]["enabled"] is False

        updated = await client.patch(
            "/v1/account-pool/accounts/1",
            json={"weight": 4, "max_concurrency": 5, "disabled": True},
        )
        assert updated.status_code == 200
        account = updated.json()["data"]
        assert account["weight"] == 4
        assert account["max_concurrency"] == 5
        assert account["status"] == "disabled"

        health = await client.post("/v1/account-pool/accounts/1/health-check")
        assert health.status_code == 200
        assert health.json()["data"]["healthy"] is False

        enabled = await client.post("/v1/account-pool/accounts/1/enable")
        assert enabled.status_code == 200
        assert enabled.json()["data"]["status"] == "available"

        pool = await client.patch(
            "/v1/account-pool",
            json={
                "global_concurrency": 1,
                "failure_threshold": 5,
                "cooldown_seconds": 12,
                "acquire_timeout": 2.5,
            },
        )
        assert pool.status_code == 200
        payload = pool.json()
        assert payload["global_concurrency"] == 1
        assert payload["failure_threshold"] == 5
        assert payload["cooldown_seconds"] == 12
        assert payload["acquire_timeout"] == 2.5


@pytest.mark.asyncio
async def test_account_pool_status_exposes_video_quota_refresh_status(monkeypatch):
    manager = CredentialManager(["cookie-a"], weights=[1], max_concurrency=[1])
    quota_status = {
        "enabled": True,
        "in_progress": True,
        "interval_seconds": 900,
        "started_at": 123.0,
        "completed_at": None,
        "next_run_at": 456.0,
        "last_error": None,
        "last_result": None,
    }
    monkeypatch.setattr(main, "provider", None)
    monkeypatch.setattr(
        main,
        "video_provider",
        SimpleNamespace(
            credential_manager=manager,
            quota_refresh_status=lambda: quota_status,
        ),
    )

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/v1/account-pool")

    assert response.status_code == 200
    payload = response.json()
    assert payload["quota_refresh"] == quota_status
    assert payload["accounts"][0]["fingerprint"]


@pytest.mark.asyncio
async def test_refresh_all_account_quotas_returns_frontend_snapshot(monkeypatch):
    manager = CredentialManager(["cookie-a"], weights=[1], max_concurrency=[1])
    quota_status = {
        "enabled": True,
        "in_progress": False,
        "interval_seconds": 900,
        "started_at": 100.0,
        "completed_at": 110.0,
        "next_run_at": 1010.0,
        "last_error": None,
        "last_result": {"checked_count": 1, "available_count": 1, "exhausted_count": 0, "unknown_count": 0},
    }

    async def refresh_video_quotas():
        await manager.update_quota(
            0,
            remaining=5,
            unit="video credits",
            source="video_history",
            status="available",
        )
        return {"checked_count": 1, "available_count": 1, "exhausted_count": 0, "unknown_count": 0, "results": []}

    monkeypatch.setattr(main, "provider", None)
    monkeypatch.setattr(
        main,
        "video_provider",
        SimpleNamespace(
            credential_manager=manager,
            refresh_video_quotas=refresh_video_quotas,
            quota_refresh_status=lambda: quota_status,
        ),
    )

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post("/v1/account-pool/quotas/refresh")

    assert response.status_code == 200
    payload = response.json()
    assert payload["object"] == "account_quotas"
    assert payload["data"]["checked_count"] == 1
    assert payload["quota_refresh"] == quota_status
    assert payload["accounts"][0]["quota"]["status"] == "available"
    assert payload["accounts"][0]["quota"]["remaining"] == 5


@pytest.mark.asyncio
async def test_manual_verification_flow_updates_cookie_and_refreshes_quota(monkeypatch):
    manager = CredentialManager(["sessionid=old"], weights=[1], max_concurrency=[1])
    exc = RuntimeError(
        "Doubao requires browser verification for the current session or network "
        "(rate limited, verify_scene=doubao_message_web)."
    )
    exc.verification_context = {
        "verify_scene": "doubao_message_web",
        "log_id": "20260618033843A8608FB4F7FBED69883F",
    }
    manager.report_failure(0, exc)
    monkeypatch.setattr(main, "provider", SimpleNamespace(credential_manager=manager))
    monkeypatch.setattr(main, "video_provider", None)
    state = {"manual_success": False}

    class FakeManualVerification:
        async def start(self, account_index, cookie, **kwargs):
            assert account_index == 0
            assert cookie == "sessionid=old"
            return {
                "object": "manual_verification",
                "account_index": account_index,
                "status": "active",
                "message": "opened",
                "snapshot_url": "/v1/account-pool/verification-snapshots/fake.png",
            }

        async def status(self, account_index):
            return {
                "object": "manual_verification",
                "account_index": account_index,
                "status": "active",
                "message": "opened",
            }

        async def capture(self, account_index):
            return {
                "object": "manual_verification",
                "account_index": account_index,
                "status": "active",
                "message": "captured",
                "manual_success_detected": state["manual_success"],
            }

        async def trigger(self, account_index, prompt, mode="video"):
            assert prompt == "生成一个简单的产品展示短视频"
            assert mode == "video"
            return {
                "object": "manual_verification",
                "account_index": account_index,
                "status": "active",
                "message": "triggered",
            }

        async def send_input(self, account_index, payload):
            assert payload == {"type": "click", "x": 0.5, "y": 0.25, "normalized": True}
            state["manual_success"] = True
            return {
                "object": "manual_verification",
                "account_index": account_index,
                "status": "active",
                "message": "input sent",
                "manual_success_detected": True,
            }

        async def complete(self, account_index):
            return {
                "object": "manual_verification",
                "account_index": account_index,
                "status": "completed",
                "message": "done",
                "cookie_header": "sessionid=new; uid_tt=1",
                "manual_success_detected": True,
            }

        async def cancel(self, account_index):
            return {
                "object": "manual_verification",
                "account_index": account_index,
                "status": "cancelled",
            }

    async def fake_quota_refresh(refresh_manager, index):
        assert refresh_manager is manager
        assert index == 0
        assert await refresh_manager.get_cookie(index) == "sessionid=new; uid_tt=1"
        return {"status": "available", "message": "quota refreshed"}

    async def fake_register_account(self, cookie):
        assert cookie == "sessionid=new; uid_tt=1"
        return {"profile_id": "fake-profile", "created": False}

    monkeypatch.setattr(account_pool_routes, "_manual_verification", FakeManualVerification())
    monkeypatch.setattr(account_pool_routes, "_quota_refresh", fake_quota_refresh)
    monkeypatch.setattr(PlaywrightManager, "register_account", fake_register_account)

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        started = await client.post("/v1/account-pool/accounts/0/verification/start", json={})
        assert started.status_code == 200
        assert started.json()["verification"]["status"] == "active"
        assert started.json()["verification"]["account_status"] == "verification_required"
        assert started.json()["verification"]["verification_context"]["verify_scene"] == "doubao_message_web"
        assert started.json()["verification"]["server_verification_only"] is True
        assert started.json()["verification"]["visible_challenge_detected"] is False
        assert "no visible captcha/challenge" in started.json()["verification"]["message"]
        assert "sessionid=old" not in started.text

        status = await client.get("/v1/account-pool/accounts/0/verification")
        assert status.status_code == 200
        assert status.json()["status"] == "active"
        assert status.json()["verification_context"]["log_id"] == "20260618033843A8608FB4F7FBED69883F"

        captured = await client.post("/v1/account-pool/accounts/0/verification/snapshot")
        assert captured.status_code == 200
        assert captured.json()["server_verification_only"] is True

        triggered = await client.post(
            "/v1/account-pool/accounts/0/verification/trigger",
            json={"mode": "video", "prompt": "生成一个简单的产品展示短视频"},
        )
        assert triggered.status_code == 200
        assert triggered.json()["visible_challenge_detected"] is False

        input_response = await client.post(
            "/v1/account-pool/accounts/0/verification/input",
            json={"type": "click", "x": 0.5, "y": 0.25, "normalized": True},
        )
        assert input_response.status_code == 200
        assert "Manual Doubao video generation success" in input_response.json()["message"]

        completed = await client.post("/v1/account-pool/accounts/0/verification/complete")
        assert completed.status_code == 200
        payload = completed.json()
        assert payload["verification"]["status"] == "completed"
        assert payload["quota_refresh_result"]["status"] == "available"
        assert await manager.get_cookie(0) == "sessionid=new; uid_tt=1"
        assert "sessionid=new" not in completed.text


@pytest.mark.asyncio
async def test_manual_verification_done_requires_manual_success_for_server_only_block(monkeypatch):
    manager = CredentialManager(["sessionid=old"], weights=[1], max_concurrency=[1])
    exc = RuntimeError(
        "Doubao requires browser verification for the current session or network "
        "(rate limited, verify_scene=doubao_message_web)."
    )
    exc.verification_context = {
        "verify_scene": "doubao_message_web",
        "log_id": "20260618150942A8E076E133FCB803A28E",
    }
    manager.report_failure(0, exc)
    monkeypatch.setattr(main, "provider", SimpleNamespace(credential_manager=manager))
    monkeypatch.setattr(main, "video_provider", None)

    class FakeManualVerification:
        async def capture(self, account_index):
            return {
                "object": "manual_verification",
                "account_index": account_index,
                "status": "active",
                "message": "captured",
                "detected_terms": [],
                "manual_success_detected": False,
            }

        async def complete(self, account_index):
            raise AssertionError("complete should not be called without manual success")

    monkeypatch.setattr(account_pool_routes, "_manual_verification", FakeManualVerification())

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post("/v1/account-pool/accounts/0/verification/complete")

    assert response.status_code == 200
    payload = response.json()
    assert payload["object"] == "manual_verification_pending"
    assert payload["verification"]["completion_blocked"] is True
    assert payload["verification"]["manual_success_required"] is True
    assert manager.snapshot()["accounts"][0]["status"] == "verification_required"


@pytest.mark.asyncio
async def test_manual_verification_reports_zhenxun_drag_captcha_probe(monkeypatch):
    manager = CredentialManager(["sessionid=old"], weights=[1], max_concurrency=[1])
    exc = RuntimeError(
        "Doubao requires browser verification for the current session or network "
        "(rate limited, verify_scene=doubao_message_web)."
    )
    exc.verification_context = {
        "verify_scene": "doubao_message_web",
        "log_id": "20260618150942A8E076E133FCB803A28E",
    }
    manager.report_failure(0, exc)
    monkeypatch.setattr(main, "provider", SimpleNamespace(credential_manager=manager))
    monkeypatch.setattr(main, "video_provider", None)

    class FakeManualVerification:
        async def status(self, account_index):
            return {
                "object": "manual_verification",
                "account_index": account_index,
                "status": "active",
                "message": "captcha visible",
                "detected_terms": [],
                "captcha_probe": {
                    "container_present": True,
                    "container_visible": True,
                    "iframe_present": True,
                    "prompt_visible": True,
                    "prompt_text": "请选择所有的猫",
                    "captcha_box_visible": True,
                    "image_count": 9,
                    "drag_area_visible": True,
                    "submit_visible": True,
                    "solver_compatible": True,
                },
            }

    monkeypatch.setattr(account_pool_routes, "_manual_verification", FakeManualVerification())

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/v1/account-pool/accounts/0/verification")

    assert response.status_code == 200
    payload = response.json()
    assert payload["visible_challenge_detected"] is True
    assert payload["zhenxun_drag_captcha_detected"] is True
    assert payload.get("server_verification_only") is not True
    assert "zhenxun-plugin-ai_creation" in payload["message"]


@pytest.mark.asyncio
async def test_auto_verification_route_uses_token_context_and_reports_solver(monkeypatch):
    manager = CredentialManager(["sessionid=old"], weights=[1], max_concurrency=[1])
    exc = RuntimeError(
        "Doubao requires browser verification for the current session or network "
        "(rate limited, verify_scene=doubao_message_web)."
    )
    exc.verification_context = {
        "verify_scene": "doubao_message_web",
        "log_id": "20260618150942A8E076E133FCB803A28E",
        "detail": "verify-token-detail",
    }
    manager.report_failure(0, exc)
    monkeypatch.setattr(main, "provider", SimpleNamespace(credential_manager=manager))
    monkeypatch.setattr(main, "video_provider", None)

    class FakeManualVerification:
        async def auto_verify(self, account_index, verification_context=None, **kwargs):
            assert account_index == 0
            assert verification_context["detail"] == "verify-token-detail"
            assert kwargs["solve"] is True
            return {
                "object": "manual_verification",
                "account_index": account_index,
                "status": "active",
                "message": "auto solved",
                "visual_challenge_seen": True,
                "auto_solve_result": {
                    "captcha_solution": {
                        "attempted": True,
                        "solved": True,
                        "classification": {"indices": [1, 5, 8]},
                    }
                },
            }

        async def complete(self, account_index):
            assert account_index == 0
            return {
                "object": "manual_verification",
                "account_index": account_index,
                "status": "completed",
                "message": "done",
                "cookie_header": "sessionid=new; uid_tt=1",
            }

    async def fake_quota_refresh(refresh_manager, index):
        assert refresh_manager is manager
        assert index == 0
        return {"status": "available", "message": "quota refreshed"}

    async def fake_register_account(self, cookie):
        assert cookie == "sessionid=new; uid_tt=1"
        return {"profile_id": "fake-profile", "created": False}

    monkeypatch.setattr(account_pool_routes, "_manual_verification", FakeManualVerification())
    monkeypatch.setattr(account_pool_routes, "_quota_refresh", fake_quota_refresh)
    monkeypatch.setattr(PlaywrightManager, "register_account", fake_register_account)

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/v1/account-pool/accounts/0/verification/auto-verify",
            json={"mode": "video", "prompt": "probe", "solve": True},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["auto_solve_attempted"] is True
    assert payload["auto_solve_solved"] is True
    assert payload["visible_challenge_detected"] is True
    assert payload["auto_completed"] is True
    assert payload["status"] == "completed"
    assert payload["account_status"] == "available"
    assert payload["quota_refresh_result"]["status"] == "available"
    assert manager.snapshot()["accounts"][0]["requires_verification"] is False


@pytest.mark.asyncio
async def test_auto_verification_completes_after_manual_video_success(monkeypatch):
    manager = CredentialManager(["sessionid=old"], weights=[1], max_concurrency=[1])
    exc = RuntimeError(
        "Doubao requires browser verification for the current session or network "
        "(rate limited, verify_scene=doubao_message_web)."
    )
    exc.verification_context = {"verify_scene": "doubao_message_web", "detail": "verify-token-detail"}
    manager.report_failure(0, exc)
    monkeypatch.setattr(main, "provider", SimpleNamespace(credential_manager=manager))
    monkeypatch.setattr(main, "video_provider", None)

    class FakeManualVerification:
        async def auto_verify(self, account_index, verification_context=None, **kwargs):
            assert verification_context["detail"] == "verify-token-detail"
            return {
                "object": "manual_verification",
                "account_index": account_index,
                "status": "active",
                "message": "Manual Doubao video generation success observed in headless snapshot.",
                "manual_success_detected": True,
            }

        async def complete(self, account_index):
            return {
                "object": "manual_verification",
                "account_index": account_index,
                "status": "completed",
                "message": "done",
                "cookie_header": "sessionid=new; uid_tt=1",
            }

    async def fake_quota_refresh(refresh_manager, index):
        return {"status": "available"}

    async def fake_register_account(self, cookie):
        return {"profile_id": "fake-profile", "created": False}

    monkeypatch.setattr(account_pool_routes, "_manual_verification", FakeManualVerification())
    monkeypatch.setattr(account_pool_routes, "_quota_refresh", fake_quota_refresh)
    monkeypatch.setattr(PlaywrightManager, "register_account", fake_register_account)

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post("/v1/account-pool/accounts/0/verification/auto-verify", json={"solve": True})

    assert response.status_code == 200
    payload = response.json()
    assert payload["auto_completed"] is True
    assert payload["manual_success_detected"] is True
    assert payload["account_status"] == "available"
    assert manager.snapshot()["accounts"][0]["requires_verification"] is False


@pytest.mark.asyncio
async def test_render_verification_challenge_accepts_explicit_context(monkeypatch):
    manager = CredentialManager(["sessionid=old"], weights=[1], max_concurrency=[1])
    monkeypatch.setattr(main, "provider", SimpleNamespace(credential_manager=manager))
    monkeypatch.setattr(main, "video_provider", None)

    class FakeManualVerification:
        async def render_bdturing_challenge(self, account_index, verification_context=None):
            assert account_index == 0
            assert verification_context["detail"] == "explicit-detail"
            assert verification_context["verify_scene"] == "doubao_message_web"
            return {
                "object": "manual_verification",
                "account_index": account_index,
                "status": "active",
                "message": "token render called",
                "bdturing_render": {
                    "render_called": True,
                    "container_visible": True,
                },
            }

    monkeypatch.setattr(account_pool_routes, "_manual_verification", FakeManualVerification())

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/v1/account-pool/accounts/0/verification/render-challenge",
            json={"verify_scene": "doubao_message_web", "detail": "explicit-detail"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["bdturing_render"]["render_called"] is True
    assert payload["bdturing_render"]["container_visible"] is True


@pytest.mark.asyncio
async def test_manual_verification_reports_trigger_time_challenge(monkeypatch):
    manager = CredentialManager(["sessionid=old"], weights=[1], max_concurrency=[1])
    exc = RuntimeError(
        "Doubao requires browser verification for the current session or network "
        "(rate limited, verify_scene=doubao_message_web)."
    )
    exc.verification_context = {
        "verify_scene": "doubao_message_web",
        "trigger_visible_challenge": "true",
        "trigger_solver_compatible": "true",
        "trigger_captcha_container": "visible",
        "trigger_captcha_images": "9",
    }
    manager.report_failure(0, exc)
    monkeypatch.setattr(main, "provider", SimpleNamespace(credential_manager=manager))
    monkeypatch.setattr(main, "video_provider", None)

    class FakeManualVerification:
        async def status(self, account_index):
            return {
                "object": "manual_verification",
                "account_index": account_index,
                "status": "active",
                "message": "plain chat page",
                "detected_terms": [],
                "captcha_probe": {
                    "container_present": False,
                    "container_visible": False,
                    "image_count": 0,
                    "solver_compatible": False,
                },
            }

    monkeypatch.setattr(account_pool_routes, "_manual_verification", FakeManualVerification())

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/v1/account-pool/accounts/0/verification")

    assert response.status_code == 200
    payload = response.json()
    assert payload["visible_challenge_detected"] is True
    assert payload["trigger_visible_challenge"] is True
    assert payload["trigger_solver_compatible"] is True
    assert payload["zhenxun_drag_captcha_detected"] is True
    assert payload.get("server_verification_only") is not True
    assert "original /chat/completion trigger" in payload["message"]


@pytest.mark.asyncio
async def test_add_account_to_existing_pool(monkeypatch):
    manager = CredentialManager(["cookie-a"], weights=[1], max_concurrency=[1])
    monkeypatch.setattr(main, "provider", SimpleNamespace(credential_manager=manager))
    monkeypatch.setattr(main, "video_provider", None)
    monkeypatch.setattr(main, "runtime_credential_manager", None)

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/v1/account-pool/accounts",
            json={"cookie": "cookie-b", "weight": 3, "max_concurrency": 2, "persist": False},
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["enabled"] is True
        assert payload["persisted"] is False
        assert payload["account_count"] == 2
        assert payload["account"]["index"] == 1
        assert payload["account"]["weight"] == 3
        assert "cookie-b" not in response.text

        duplicate = await client.post(
            "/v1/account-pool/accounts",
            json={"cookie": "cookie-b", "persist": False},
        )
        assert duplicate.status_code == 400


@pytest.mark.asyncio
async def test_bulk_add_and_delete_accounts(monkeypatch):
    manager = CredentialManager(["cookie-a"], weights=[1], max_concurrency=[1])
    monkeypatch.setattr(main, "provider", SimpleNamespace(credential_manager=manager))
    monkeypatch.setattr(main, "video_provider", None)
    monkeypatch.setattr(main, "runtime_credential_manager", None)

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        bulk = await client.post(
            "/v1/account-pool/accounts/bulk",
            json={
                "cookies": "cookie-b\ncookie-a\ncookie-c",
                "weight": 2,
                "max_concurrency": 3,
                "persist": False,
            },
        )
        assert bulk.status_code == 200
        payload = bulk.json()
        assert payload["added_count"] == 2
        assert payload["skipped_count"] == 1
        assert payload["account_count"] == 3
        assert "cookie-b" not in bulk.text
        assert "cookie-c" not in bulk.text

        deleted = await client.delete("/v1/account-pool/accounts/1")
        assert deleted.status_code == 200
        payload = deleted.json()
        assert payload["object"] == "account_deleted"
        assert payload["account_count"] == 2
        assert payload["env_index"] is None
        assert manager.contains_credential("cookie-b") is False


@pytest.mark.asyncio
async def test_add_account_rejects_same_login_with_different_dynamic_token(monkeypatch):
    manager = CredentialManager(["sessionid=stable-session; msToken=old"], weights=[1], max_concurrency=[1])
    monkeypatch.setattr(main, "provider", SimpleNamespace(credential_manager=manager))
    monkeypatch.setattr(main, "video_provider", None)
    monkeypatch.setattr(main, "runtime_credential_manager", None)

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        duplicate = await client.post(
            "/v1/account-pool/accounts",
            json={"cookie": "msToken=new; sessionid=stable-session", "persist": False},
        )
        assert duplicate.status_code == 400
        assert duplicate.json()["detail"] == "Credential cookie already exists."
        assert manager.snapshot()["account_count"] == 1


@pytest.mark.asyncio
async def test_add_account_creates_runtime_pool_without_provider(monkeypatch):
    monkeypatch.setattr(main, "provider", None)
    monkeypatch.setattr(main, "video_provider", None)
    monkeypatch.setattr(main, "runtime_credential_manager", None)
    monkeypatch.setattr(main.settings, "DOUBAO_COOKIES", [])

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        empty = await client.get("/v1/account-pool")
        assert empty.status_code == 200
        assert empty.json()["enabled"] is False

        created = await client.post(
            "/v1/account-pool/accounts",
            json={"cookie": "runtime-cookie", "weight": 2, "max_concurrency": 4, "persist": False},
        )
        assert created.status_code == 200
        payload = created.json()
        assert payload["enabled"] is True
        assert payload["account_count"] == 1
        assert payload["accounts"][0]["weight"] == 2
        assert payload["accounts"][0]["max_concurrency"] == 4
        assert payload["env_index"] is None
        assert "runtime-cookie" not in created.text

        status = await client.get("/v1/account-pool")
        assert status.json()["enabled"] is True
        assert status.json()["account_count"] == 1


@pytest.mark.asyncio
async def test_add_account_attaches_runtime_pool_to_video_provider(monkeypatch):
    class FakeVideoProvider:
        def __init__(self):
            self.credential_manager = None
            self.attach_calls = []

        async def attach_credential_manager(self, manager, *, run_initial_refresh=False):
            self.credential_manager = manager
            self.attach_calls.append(run_initial_refresh)

        def quota_refresh_status(self):
            return {"enabled": True, "in_progress": False}

        async def refresh_account_video_quota(self, index):
            return {
                "supported": True,
                "index": index,
                "account": self.credential_manager.snapshot()["accounts"][index],
            }

    fake_video_provider = FakeVideoProvider()
    monkeypatch.setattr(main, "provider", None)
    monkeypatch.setattr(main, "video_provider", fake_video_provider)
    monkeypatch.setattr(main, "runtime_credential_manager", None)
    monkeypatch.setattr(main.settings, "DOUBAO_COOKIES", [])

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        created = await client.post(
            "/v1/account-pool/accounts",
            json={"cookie": "runtime-cookie", "persist": False},
        )

    assert created.status_code == 200
    payload = created.json()
    assert payload["account_count"] == 1
    assert payload["quota_refresh_result"]["supported"] is True
    assert payload["quota_refresh_result"]["index"] == 0
    assert fake_video_provider.credential_manager is main.runtime_credential_manager
    assert fake_video_provider.attach_calls == [False]


@pytest.mark.asyncio
async def test_bulk_add_creates_runtime_pool_without_provider(monkeypatch):
    monkeypatch.setattr(main, "provider", None)
    monkeypatch.setattr(main, "video_provider", None)
    monkeypatch.setattr(main, "runtime_credential_manager", None)
    monkeypatch.setattr(main.settings, "DOUBAO_COOKIES", [])

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/v1/account-pool/accounts/bulk",
            json={"cookies": ["runtime-a", "runtime-b"], "weight": 2, "max_concurrency": 2, "persist": False},
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["enabled"] is True
        assert payload["account_count"] == 2
        assert payload["added_count"] == 2
        assert "runtime-a" not in response.text
        assert "runtime-b" not in response.text


@pytest.mark.asyncio
async def test_doubao_cookie_plugin_config_and_update(monkeypatch, tmp_path):
    monkeypatch.setenv("DOUBAO_COOKIE_PLUGIN_CONFIG_PATH", str(tmp_path / "plugin.json"))
    for index in range(1, 5):
        monkeypatch.delenv(f"DOUBAO_COOKIE_{index}", raising=False)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(main, "provider", None)
    monkeypatch.setattr(main, "video_provider", None)
    monkeypatch.setattr(main, "runtime_credential_manager", None)
    monkeypatch.setattr(main.settings, "DOUBAO_COOKIES", [])
    monkeypatch.setattr(main.settings, "DOUBAO_COOKIE_WEIGHTS", [])
    monkeypatch.setattr(main.settings, "DOUBAO_COOKIE_MAX_CONCURRENCY", [])
    monkeypatch.setattr(main.settings, "DOUBAO_COOKIE_DISABLED", [])

    async def fake_activate(manager):
        main._set_runtime_credential_manager(manager)

    monkeypatch.setattr(main, "_activate_runtime_credential_manager", fake_activate)

    async def fake_register(self, cookie):
        return {"profile_id": "profile", "created": True}

    monkeypatch.setattr(PlaywrightManager, "register_account", fake_register)

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        config_response = await client.get("/v1/doubao-cookie-plugin/config")
        assert config_response.status_code == 200
        config = config_response.json()
        token = config["connection_token"]
        assert config["connection_url"] == "http://testserver/v1/doubao-cookie-plugin/update-cookie"
        assert config["extension_path"] == "doubao-cookie-sync-plugin"

        unauthorized = await client.post(
            "/v1/doubao-cookie-plugin/update-cookie",
            json={"cookie": "sessionid=stable; sid_guard=stable"},
        )
        assert unauthorized.status_code == 401

        added = await client.post(
            "/v1/doubao-cookie-plugin/update-cookie",
            headers={"Authorization": f"Bearer {token}"},
            json={"cookie": "sessionid=stable; sid_guard=stable; msToken=one"},
        )
        assert added.status_code == 200
        added_payload = added.json()
        assert added_payload["action"] == "added"
        assert added_payload["account_count"] == 1
        assert "msToken=one" not in added.text

        updated = await client.post(
            "/v1/doubao-cookie-plugin/update-cookie",
            headers={"Authorization": f"Bearer {token}"},
            json={"cookie": "sessionid=stable; sid_guard=stable; msToken=two"},
        )
        assert updated.status_code == 200
        updated_payload = updated.json()
        assert updated_payload["action"] == "updated"
        assert updated_payload["account_count"] == 1
        assert "msToken=two" not in updated.text
        assert (tmp_path / ".env").read_text(encoding="utf-8").count("DOUBAO_COOKIE_1=") == 1


@pytest.mark.asyncio
async def test_quota_refresh_reports_unsupported_without_endpoint(monkeypatch):
    manager = CredentialManager(["cookie-a"], weights=[1], max_concurrency=[1])
    monkeypatch.setattr(main, "provider", SimpleNamespace(credential_manager=manager))
    monkeypatch.setattr(main, "video_provider", None)
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_ENDPOINT", "")

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post("/v1/account-pool/accounts/0/quota-refresh")
        assert response.status_code == 200
        payload = response.json()["data"]
        assert payload["supported"] is False
        assert payload["account"]["quota"]["status"] == "unsupported"
        assert "cookie-a" not in response.text


@pytest.mark.asyncio
async def test_quota_refresh_parses_configured_endpoint(monkeypatch):
    manager = CredentialManager(["cookie-a"], weights=[1], max_concurrency=[1])
    monkeypatch.setattr(main, "provider", SimpleNamespace(credential_manager=manager))
    monkeypatch.setattr(main, "video_provider", None)
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_ENDPOINT", "https://quota.example.local/balance")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_METHOD", "GET")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_SIGNED", False)
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_REMAINING_PATH", "data.remaining")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_TOTAL_PATH", "data.total")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_USED_PATH", "data.used")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_UNIT", "credits")

    async def fake_refresh(manager_arg, index):
        assert manager_arg is manager
        assert index == 0
        account = await manager_arg.update_quota(
            index,
            total=100,
            remaining=82,
            used=18,
            unit="credits",
            source="upstream",
            status="available",
        )
        return {"account": account, "supported": True, "message": "Quota refreshed from upstream."}

    monkeypatch.setattr(main, "_refresh_account_quota", fake_refresh)

    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post("/v1/account-pool/accounts/0/quota-refresh")
        assert response.status_code == 200
        payload = response.json()["data"]
        assert payload["supported"] is True
        assert payload["account"]["quota"]["remaining"] == 82
        assert payload["account"]["quota"]["used"] == 18
        assert "cookie-a" not in response.text


@pytest.mark.asyncio
async def test_signed_quota_refresh_initializes_signer_and_reports_login_expiry(monkeypatch):
    manager = CredentialManager(["cookie-a"], weights=[1], max_concurrency=[1])
    monkeypatch.setattr(main, "provider", SimpleNamespace(credential_manager=manager))
    monkeypatch.setattr(main, "video_provider", None)
    monkeypatch.setattr(main, "quota_playwright_manager", None)
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_ENDPOINT", "https://quota.example.local/balance")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_METHOD", "POST")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_SIGNED", True)
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_REQUEST_BODY", {"need_tasks": False})
    monkeypatch.setattr(main.settings, "DOUBAO_DEVICE_ID", "device")
    monkeypatch.setattr(main.settings, "DOUBAO_FP", "fp")
    monkeypatch.setattr(main.settings, "DOUBAO_TEA_UUID", "tea")
    monkeypatch.setattr(main.settings, "DOUBAO_WEB_ID", "web")

    class FakeSigner:
        ms_token = "fresh-token"
        initialized_with = None
        signed_cookie = None
        closed_cookie = None

        async def initialize(self, cookies):
            self.initialized_with = cookies

        async def get_signed_url(self, endpoint, cookie, params):
            self.signed_cookie = cookie
            assert endpoint == "https://quota.example.local/balance"
            assert params["fp"] == "fp"
            return "https://quota.example.local/balance?msToken=fresh-token&a_bogus=signed"

        async def close_account_session(self, cookie):
            self.closed_cookie = cookie
            return True

    fake_signer = FakeSigner()
    monkeypatch.setattr(main, "PlaywrightManager", lambda: fake_signer)

    class FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"code": 710012001, "message": "login invalid", "msg": "登录已过期，请重新登录"}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            self.request_cookie = None

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def request(self, method, url, headers=None, json=None):
            self.request_cookie = headers["Cookie"]
            assert method == "POST"
            assert "a_bogus=signed" in url
            assert json == {"need_tasks": False}
            assert "fresh-token" in headers["Cookie"]
            return FakeResponse()

    monkeypatch.setattr(main.httpx, "AsyncClient", FakeClient)

    result = await main._refresh_account_quota(manager, 0)

    assert fake_signer.initialized_with == ["cookie-a"]
    assert fake_signer.signed_cookie == "cookie-a; msToken=fresh-token"
    assert fake_signer.closed_cookie == "cookie-a"
    assert result["account"]["quota"]["status"] == "error"
    assert "登录态已失效" in result["message"]
    assert result["account"]["status"] == "login_required"
    assert result["account"]["disabled_reason"] == "login_expired"
    assert result["account"]["failure_count"] == 1
    assert "cookie-a" not in result["message"]


@pytest.mark.asyncio
async def test_quota_refresh_disables_account_when_remaining_is_zero(monkeypatch):
    manager = CredentialManager(["cookie-a"], weights=[1], max_concurrency=[1])
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_ENDPOINT", "https://quota.example.local/balance")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_METHOD", "GET")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_SIGNED", False)
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_REMAINING_PATH", "data.remaining")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_TOTAL_PATH", "data.total")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_USED_PATH", "data.used")

    class FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"data": {"remaining": 0, "total": 10, "used": 10}}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def request(self, method, url, headers=None, json=None):
            return FakeResponse()

    monkeypatch.setattr(main.httpx, "AsyncClient", FakeClient)

    result = await main._refresh_account_quota(manager, 0)

    assert result["account"]["status"] == "disabled"
    assert result["account"]["disabled_reason"] == "quota_exhausted"
    assert result["account"]["quota"]["status"] == "exhausted"
    assert result["account"]["quota"]["remaining"] == 0


@pytest.mark.asyncio
async def test_quota_refresh_recovers_quota_disabled_account_when_remaining_is_positive(monkeypatch):
    manager = CredentialManager(["cookie-a"], weights=[1], max_concurrency=[1])
    await manager.disable_for_quota_exhausted(0, "Doubao quota remaining is 0.", source="upstream")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_ENDPOINT", "https://quota.example.local/balance")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_METHOD", "GET")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_SIGNED", False)
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_REMAINING_PATH", "data.remaining")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_TOTAL_PATH", "data.total")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_USED_PATH", "data.used")

    class FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"data": {"remaining": 2, "total": 10, "used": 8}}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def request(self, method, url, headers=None, json=None):
            return FakeResponse()

    monkeypatch.setattr(main.httpx, "AsyncClient", FakeClient)

    result = await main._refresh_account_quota(manager, 0)

    assert result["account"]["status"] == "available"
    assert result["account"]["disabled_reason"] is None
    assert result["account"]["quota"]["status"] == "available"
    assert result["account"]["quota"]["remaining"] == 2


@pytest.mark.asyncio
async def test_quota_refresh_does_not_treat_benefit_credit_zero_as_video_quota(monkeypatch):
    manager = CredentialManager(["cookie-a"], weights=[1], max_concurrency=[1])
    monkeypatch.setattr(
        main.settings,
        "DOUBAO_QUOTA_ENDPOINT",
        "https://www.doubao.com/commerce/benefit_supply/credit/get_credit_num_optional_tasks",
    )
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_METHOD", "POST")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_SIGNED", False)
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_REQUEST_BODY", {"need_tasks": False})
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_REMAINING_PATH", "")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_TOTAL_PATH", "")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_USED_PATH", "")

    class FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"data": {"credit_info": {"total_credit_num": 0}}}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def request(self, method, url, headers=None, json=None):
            assert method == "POST"
            assert json == {"need_tasks": False}
            return FakeResponse()

    monkeypatch.setattr(main.httpx, "AsyncClient", FakeClient)

    result = await main._refresh_account_quota(manager, 0)

    assert result["account"]["status"] == "available"
    assert result["account"]["quota"]["status"] == "unknown"
    assert result["account"]["quota"]["remaining"] is None


@pytest.mark.asyncio
async def test_quota_refresh_keeps_account_available_for_advisory_benefit_credit_zero(monkeypatch):
    manager = CredentialManager(["cookie-a"], weights=[1], max_concurrency=[1])
    monkeypatch.setattr(
        main.settings,
        "DOUBAO_QUOTA_ENDPOINT",
        "https://www.doubao.com/commerce/benefit_supply/credit/get_credit_num_optional_tasks",
    )
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_METHOD", "POST")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_SIGNED", False)
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_REQUEST_BODY", {"need_tasks": False})
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_REMAINING_PATH", "")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_TOTAL_PATH", "")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_USED_PATH", "")

    class FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "code": 0,
                "data": {
                    "credit_info": {
                        "credit_desc_text": "积分可用于视频生成等功能",
                        "credit_text": "积分",
                        "total_credit_num": 0,
                    }
                },
            }

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def request(self, method, url, headers=None, json=None):
            assert method == "POST"
            assert json == {"need_tasks": False}
            return FakeResponse()

    monkeypatch.setattr(main.httpx, "AsyncClient", FakeClient)

    result = await main._refresh_account_quota(manager, 0)

    assert result["account"]["status"] == "available"
    assert result["account"]["disabled_reason"] is None
    assert result["account"]["quota"]["status"] == "unknown"
    assert result["account"]["quota"]["source"] is None
    assert result["account"]["quota"]["remaining"] is None
    assert result["advisory"]["remaining"] == 0
    assert result["message"] == "Benefit credit refreshed separately; confirmed video quota was not changed."


@pytest.mark.asyncio
async def test_advisory_benefit_credit_does_not_override_confirmed_quota_exhaustion(monkeypatch):
    manager = CredentialManager(["cookie-a"], weights=[1], max_concurrency=[1])
    await manager.disable_for_quota_exhausted(0, "Doubao quota remaining is 0.", source="upstream")
    monkeypatch.setattr(
        main.settings,
        "DOUBAO_QUOTA_ENDPOINT",
        "https://www.doubao.com/commerce/benefit_supply/credit/get_credit_num_optional_tasks",
    )
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_METHOD", "POST")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_SIGNED", False)
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_REQUEST_BODY", {"need_tasks": False})
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_REMAINING_PATH", "")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_TOTAL_PATH", "")
    monkeypatch.setattr(main.settings, "DOUBAO_QUOTA_USED_PATH", "")

    class FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "code": 0,
                "data": {
                    "credit_info": {
                        "credit_desc_text": "积分可用于视频生成等功能",
                        "credit_text": "积分",
                        "total_credit_num": 3,
                    }
                },
            }

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def request(self, method, url, headers=None, json=None):
            assert method == "POST"
            assert json == {"need_tasks": False}
            return FakeResponse()

    monkeypatch.setattr(main.httpx, "AsyncClient", FakeClient)

    result = await main._refresh_account_quota(manager, 0)

    assert result["account"]["status"] == "disabled"
    assert result["account"]["disabled_reason"] == "quota_exhausted"
    assert result["account"]["quota"]["status"] == "exhausted"
    assert result["account"]["quota"]["source"] == "upstream"
    assert result["account"]["quota"]["remaining"] == 0
    assert result["advisory"]["remaining"] == 3


@pytest.mark.asyncio
async def test_generated_api_key_lifecycle(monkeypatch, tmp_path):
    manager = CredentialManager(["cookie-a"], weights=[1], max_concurrency=[1])
    monkeypatch.setattr(main, "provider", SimpleNamespace(credential_manager=manager))
    monkeypatch.setattr(main, "video_provider", None)
    monkeypatch.setattr(main, "runtime_credential_manager", None)
    monkeypatch.setattr(main.settings, "API_MASTER_KEY", "master-key")
    monkeypatch.setenv("API_KEY_STORE_PATH", str(tmp_path / "api_keys.json"))
    monkeypatch.setattr(main, "api_key_records_cache", None)
    monkeypatch.setattr(main, "api_key_records_cache_mtime", None)
    monkeypatch.setattr(main, "api_key_records_cache_path", None)

    master_headers = {"Authorization": "Bearer master-key"}
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        unauthorized = await client.get("/v1/api-keys")
        assert unauthorized.status_code == 401

        created = await client.post("/v1/api-keys", headers=master_headers, json={"name": "client-a"})
        assert created.status_code == 200
        payload = created.json()["data"]
        secret = payload["secret"]
        key_id = payload["id"]
        assert secret.startswith("sk-doubao-")

        listed = await client.get("/v1/api-keys", headers=master_headers)
        assert listed.status_code == 200
        assert listed.json()["data"][0]["name"] == "client-a"
        assert secret not in listed.text

        generated_headers = {"Authorization": f"Bearer {secret}"}
        allowed = await client.get("/v1/account-pool", headers=generated_headers)
        assert allowed.status_code == 200

        disabled = await client.post(f"/v1/api-keys/{key_id}/disable", headers=master_headers)
        assert disabled.status_code == 200
        rejected = await client.get("/v1/account-pool", headers=generated_headers)
        assert rejected.status_code == 403

        enabled = await client.post(f"/v1/api-keys/{key_id}/enable", headers=master_headers)
        assert enabled.status_code == 200
        allowed_again = await client.get("/v1/account-pool", headers=generated_headers)
        assert allowed_again.status_code == 200

        deleted = await client.delete(f"/v1/api-keys/{key_id}", headers=master_headers)
        assert deleted.status_code == 200
        rejected_again = await client.get("/v1/account-pool", headers=generated_headers)
        assert rejected_again.status_code == 403


@pytest.mark.asyncio
async def test_control_page_contains_account_pool_ui():
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/")
        assert response.status_code == 200
        html = response.text
        assert "Doubao2API" in html
        assert "账户管理" in html
        assert "配置管理" in html
        assert "创建 API Key" in html
        assert "/v1/api-keys" in html
        assert "+ 新增" in html
        assert "/v1/account-pool/accounts" in html
        assert "/v1/account-pool/accounts/bulk" in html
        assert "/v1/account-pool" in html
        assert "openBulkAccount" in html
        assert "bulkTextFile" in html
        assert "readFileAsText" in html
        assert 'data-action="delete"' in html
        assert "视频生成测试" in html

        video_test = await client.get("/video-test")
        assert video_test.status_code == 200
        assert "Doubao2API" in video_test.text
