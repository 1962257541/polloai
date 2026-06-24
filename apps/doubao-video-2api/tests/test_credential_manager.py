import asyncio
import json

import pytest

from app.services.credential_manager import (
    CredentialManager,
    credential_identity,
    is_login_expired_error,
    is_quota_exhausted_error,
    is_verification_required_error,
    next_video_quota_reset_at,
)


def test_legacy_polling_respects_weights():
    manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        weights=[2, 1],
        max_concurrency=[1, 1],
    )

    assert [manager.get_credential() for _ in range(6)] == [
        "cookie-a",
        "cookie-a",
        "cookie-b",
        "cookie-a",
        "cookie-a",
        "cookie-b",
    ]


def test_credential_identity_ignores_volatile_cookie_parts():
    first = "sessionid=stable-session; msToken=old; s_v_web_id=device-a"
    second = "msToken=new; sessionid=stable-session; s_v_web_id=device-b"

    assert credential_identity(first) == credential_identity(second)
    assert CredentialManager([first, second]).snapshot()["account_count"] == 1


@pytest.mark.asyncio
async def test_acquire_respects_per_account_concurrency():
    manager = CredentialManager(
        ["cookie-a"],
        max_concurrency=[1],
        acquire_timeout=0.1,
    )

    first = await manager.acquire_lease()
    with pytest.raises(TimeoutError):
        await manager.acquire_lease(timeout=0.05)

    await first.release()
    second = await manager.acquire_lease(timeout=0.05)
    await second.release()


@pytest.mark.asyncio
async def test_failure_threshold_cools_down_and_recovers():
    manager = CredentialManager(
        ["cookie-a"],
        max_concurrency=[1],
        failure_threshold=1,
        cooldown_seconds=0.05,
        acquire_timeout=0.2,
    )

    async with manager.acquire() as lease:
        lease.mark_failure(RuntimeError("expired"))

    snapshot = manager.snapshot()
    account = snapshot["accounts"][0]
    assert account["status"] == "cooling_down"
    assert account["consecutive_failures"] == 1

    await asyncio.sleep(0.06)
    async with manager.acquire() as lease:
        assert lease.cookie == "cookie-a"

    account = manager.snapshot()["accounts"][0]
    assert account["status"] == "available"
    assert account["consecutive_failures"] == 0
    assert account["success_count"] == 1


@pytest.mark.asyncio
async def test_hard_failures_disable_account_immediately():
    manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        max_concurrency=[1, 1],
        failure_threshold=10,
        cooldown_seconds=60,
    )

    manager.report_failure(
        0,
        RuntimeError("doubao_web upstream returned x-tt-agw-login=0; login invalid"),
    )

    first = manager.snapshot()["accounts"][0]
    assert first["status"] == "login_required"
    assert first["disabled_reason"] == "login_expired"
    assert first["failure_count"] == 1
    assert first["consecutive_failures"] == 1

    async with manager.acquire() as lease:
        assert lease.cookie == "cookie-b"


@pytest.mark.asyncio
async def test_hard_failure_disable_persists_across_manager_restart(monkeypatch, tmp_path):
    disabled_store = tmp_path / "disabled_credentials.json"
    monkeypatch.setattr(
        "app.services.credential_manager.settings.DOUBAO_DISABLED_CREDENTIAL_STORE_PATH",
        str(disabled_store),
    )

    manager = CredentialManager(["sessionid=expired", "sessionid=fresh"], max_concurrency=[1, 1])
    manager.report_failure(
        0,
        RuntimeError("doubao_web upstream returned x-tt-agw-login=0; login invalid"),
    )
    assert manager.snapshot()["accounts"][0]["status"] == "login_required"

    restarted = CredentialManager(["sessionid=expired", "sessionid=fresh"], max_concurrency=[1, 1])
    accounts = restarted.snapshot()["accounts"]
    assert accounts[0]["status"] == "login_required"
    assert accounts[0]["last_error"]
    assert accounts[1]["status"] == "available"

    enabled = await restarted.update_account(0, disabled=False)
    assert enabled["status"] == "available"

    restarted_again = CredentialManager(["sessionid=expired", "sessionid=fresh"], max_concurrency=[1, 1])
    assert restarted_again.snapshot()["accounts"][0]["status"] == "available"


@pytest.mark.asyncio
async def test_login_required_account_recovers_after_cookie_refresh():
    manager = CredentialManager(["sessionid=expired"], max_concurrency=[1])
    manager.report_failure(
        0,
        RuntimeError("doubao_web upstream returned x-tt-agw-login=0; login invalid"),
    )

    assert manager.snapshot()["accounts"][0]["status"] == "login_required"

    refreshed = await manager.update_account_cookie(0, "sessionid=fresh")

    assert refreshed["status"] == "available"
    assert refreshed["disabled_reason"] is None
    assert refreshed["last_error"] is None


def test_hard_failure_classifiers_detect_login_and_quota_text():
    assert is_login_expired_error("x-tt-agw-login=0")
    assert is_login_expired_error("login invalid")
    assert is_quota_exhausted_error("insufficient credits for video generation")
    assert is_quota_exhausted_error("quota remaining 0")
    assert is_verification_required_error("710022004 verify_scene=doubao_message_web")
    accepted = (
        "\u8fd9\u5c31\u4e3a\u60a8\u751f\u6210\u4e00\u6bb5\u8df3\u821e\u7684\u89c6\u9891\uff0c"
        "\u8bf7\u7a0d\u7b49\u7247\u523b~ "
        "\u672c\u6b21\u4f7f\u7528 **Seedance 2.0 Fast** \u751f\u6210\uff0c"
        "\u5c06\u6d88\u8017 2 \u4e2a\u89c6\u9891\u751f\u6210\u989d\u5ea6\uff0c"
        "\u9884\u8ba1\u7b49\u5f85 1-3\u5206\u949f\u3002"
        "\u89c6\u9891\u751f\u6210\u597d\u540e\uff0c\u6211\u4f1a\u4e3b\u52a8\u53d1\u9001\u7ed9\u4f60\uff0c"
        "\u4eca\u65e5\u5269\u4f59 0 \u4e2a\u89c6\u9891\u751f\u6210\u989d\u5ea6\u3002"
    )
    rejected = (
        "\u672c\u6b21\u89c6\u9891\u751f\u6210\u9700\u8981\u6d88\u8017 2 "
        "\u4e2a\u89c6\u9891\u751f\u6210\u989d\u5ea6\uff0c\u4eca\u65e5\u5269\u4f59 1 "
        "\u4e2a\u89c6\u9891\u751f\u6210\u989d\u5ea6\uff0c\u65e0\u6cd5\u751f\u6210\u8be5\u89c6\u9891\u3002"
    )
    assert not is_quota_exhausted_error(accepted)
    assert is_quota_exhausted_error(rejected)
    assert is_quota_exhausted_error("今天的生成次数已经达到上限，明天再来免费生成吧～")


@pytest.mark.asyncio
async def test_browser_verification_failure_marks_account_for_manual_verification():
    manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        max_concurrency=[1, 1],
        failure_threshold=10,
        cooldown_seconds=60,
    )

    exc = RuntimeError(
        "Doubao requires browser verification for the current session or network "
        "(rate limited, verify_scene=doubao_message_web)."
    )
    exc.verification_context = {
        "verify_scene": "doubao_message_web",
        "log_id": "20260618033843A8608FB4F7FBED69883F",
        "detail": "opaque challenge detail",
    }

    manager.report_failure(0, exc)

    first = manager.snapshot()["accounts"][0]
    assert first["status"] == "verification_required"
    assert first["requires_verification"] is True
    assert first["verification_required_at"]
    assert "verify_scene=doubao_message_web" in first["verification_error"]
    assert first["verification_context"]["verify_scene"] == "doubao_message_web"
    assert first["verification_context"]["log_id"] == "20260618033843A8608FB4F7FBED69883F"
    assert first["disabled_reason"] is None
    assert first["consecutive_failures"] == 1

    async with manager.acquire() as lease:
        assert lease.cookie == "cookie-b"

    reset = await manager.reset_health(0)
    assert reset["status"] == "available"
    assert reset["requires_verification"] is False
    assert reset["verification_context"] is None


@pytest.mark.asyncio
async def test_global_concurrency_limits_across_accounts():
    manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        max_concurrency=[1, 1],
        global_concurrency=1,
        acquire_timeout=0.1,
    )

    first = await manager.acquire_lease()
    with pytest.raises(TimeoutError):
        await manager.acquire_lease(timeout=0.05)

    await first.release()
    second = await manager.acquire_lease(timeout=0.05)
    await second.release()


@pytest.mark.asyncio
async def test_account_runtime_updates_and_health_actions():
    manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        weights=[1, 1],
        max_concurrency=[1, 1],
        failure_threshold=1,
        cooldown_seconds=60,
    )

    account = await manager.update_account(1, weight=3, max_concurrency=2, disabled=True)
    assert account["weight"] == 3
    assert account["max_concurrency"] == 2
    assert account["status"] == "disabled"
    assert [manager.get_credential() for _ in range(3)] == ["cookie-a", "cookie-a", "cookie-a"]

    account = await manager.update_account(1, disabled=False)
    assert account["status"] == "available"
    assert [manager.get_credential() for _ in range(4)] == ["cookie-b", "cookie-b", "cookie-b", "cookie-a"]

    failed_index = None
    async with manager.acquire() as lease:
        failed_index = lease.index
        lease.mark_failure(RuntimeError("blocked"))

    assert manager.snapshot()["accounts"][failed_index]["status"] == "cooling_down"
    health = await manager.health_check(failed_index)
    assert health["healthy"] is False
    assert health["status"] == "cooling_down"

    account = await manager.clear_cooldown(failed_index)
    assert account["status"] == "available"
    account = await manager.reset_health(failed_index)
    assert account["failure_count"] == 0
    assert account["last_error"] is None

    pool = await manager.update_pool_config(
        global_concurrency=2,
        failure_threshold=4,
        cooldown_seconds=5,
        acquire_timeout=1.5,
    )
    assert pool["global_concurrency"] == 2
    assert pool["failure_threshold"] == 4
    assert pool["cooldown_seconds"] == 5
    assert pool["acquire_timeout"] == 1.5


@pytest.mark.asyncio
async def test_add_account_updates_weighted_pool_and_rejects_duplicates():
    manager = CredentialManager(["cookie-a"], weights=[1], max_concurrency=[1])

    account = await manager.add_account("cookie-b", weight=2, max_concurrency=3, disabled=True)
    assert account["index"] == 1
    assert account["weight"] == 2
    assert account["max_concurrency"] == 3
    assert account["status"] == "disabled"
    assert manager.snapshot()["account_count"] == 2

    with pytest.raises(ValueError, match="already exists"):
        await manager.add_account("cookie-b")

    cookie_manager = CredentialManager(["sessionid=stable-session; msToken=old"])
    with pytest.raises(ValueError, match="already exists"):
        await cookie_manager.add_account("sessionid=stable-session; msToken=new")

    enabled = await manager.update_account(1, disabled=False)
    assert enabled["status"] == "available"
    assert [manager.get_credential() for _ in range(3)] == ["cookie-a", "cookie-b", "cookie-b"]


@pytest.mark.asyncio
async def test_remove_account_reindexes_pool_and_rejects_busy_account():
    manager = CredentialManager(["cookie-a", "cookie-b", "cookie-c"], weights=[1, 2, 1], max_concurrency=[1, 1, 1])

    removed = await manager.remove_account(1)
    assert removed["index"] == 1
    snapshot = manager.snapshot()
    assert snapshot["account_count"] == 2
    assert [account["index"] for account in snapshot["accounts"]] == [0, 1]
    assert manager.contains_credential("cookie-b") is False
    assert manager.contains_credential("cookie-c") is True

    lease = await manager.acquire_lease()
    with pytest.raises(RuntimeError, match="currently in use"):
        await manager.remove_account(lease.index)
    await lease.release()


@pytest.mark.asyncio
async def test_quota_update_and_consumption_are_reflected_in_snapshot():
    manager = CredentialManager(["cookie-a"], weights=[1], max_concurrency=[1])

    account = await manager.update_quota(
        0,
        total=10,
        remaining=7,
        unit="credits",
        source="upstream",
        status="available",
    )
    assert account["quota"]["total"] == 10
    assert account["quota"]["remaining"] == 7
    assert account["quota"]["used"] == 3
    assert account["quota"]["status"] == "available"

    account = await manager.consume_quota(0, 2, source="local_estimate", reason="test")
    assert account["quota"]["remaining"] == 5
    assert account["quota"]["used"] == 5
    assert account["quota"]["last_delta"] == 2
    assert account["quota"]["status"] == "estimated"

    account = await manager.update_quota(0, remaining=4, used=6, unit="credits", source="upstream")
    assert account["quota"]["remaining"] == 4
    assert account["quota"]["used"] == 6
    assert account["quota"]["last_delta"] is None


@pytest.mark.asyncio
async def test_usage_without_reported_balance_blocks_video_reuse_and_persists():
    manager = CredentialManager(["cookie-a", "cookie-b"])

    account = await manager.record_quota_usage_without_balance(0, 2, reason="video")

    assert account["status"] == "available"
    assert account["quota"]["status"] == "pending_refresh"
    assert account["quota"]["used"] == 2
    assert account["quota"]["last_delta"] == 2

    lease = await manager.acquire_lease_for_quota(2, allow_unknown=True)
    assert lease.cookie == "cookie-b"
    await lease.release()

    restarted = CredentialManager(["cookie-a", "cookie-b"])
    cached = restarted.snapshot()["accounts"][0]["quota"]
    assert cached["status"] == "pending_refresh"
    assert cached["used"] == 2

    errored = await restarted.mark_quota_error(0, "temporary quota refresh network error")
    assert errored["quota"]["status"] == "pending_refresh"
    assert errored["quota"]["used"] == 2


@pytest.mark.asyncio
async def test_zero_quota_disables_account():
    manager = CredentialManager(["cookie-a", "cookie-b"], weights=[1, 1], max_concurrency=[1, 1])

    account = await manager.update_quota(
        0,
        total=10,
        remaining=0,
        used=10,
        unit="credits",
        source="upstream",
        status="available",
    )

    assert account["status"] == "disabled"
    assert account["disabled_reason"] == "quota_exhausted"
    assert account["quota"]["status"] == "exhausted"
    assert account["quota"]["remaining"] == 0
    assert manager.active_credentials == ["cookie-b"]

    async with manager.acquire() as lease:
        assert lease.cookie == "cookie-b"


@pytest.mark.asyncio
async def test_quota_exhausted_account_records_daily_reset_time(monkeypatch):
    clock = {"now": 1_781_588_400.0}
    monkeypatch.setattr("app.services.credential_manager.time.time", lambda: clock["now"])
    manager = CredentialManager(["cookie-a", "cookie-b"], weights=[1, 1], max_concurrency=[1, 1])

    account = await manager.disable_for_quota_exhausted(
        0,
        "今天的生成次数已经达到上限，明天再来免费生成吧～",
        source="upstream_error",
    )

    assert account["status"] == "disabled"
    assert account["disabled_reason"] == "quota_exhausted"
    assert account["quota"]["status"] == "exhausted"
    assert account["quota"]["remaining"] == 0
    assert account["quota"]["reset_at"] == next_video_quota_reset_at(clock["now"])
    assert account["quota"]["reset_remaining_seconds"] > 0


@pytest.mark.asyncio
async def test_video_quota_acquire_skips_accounts_below_required_cost():
    manager = CredentialManager(["cookie-a", "cookie-b"], weights=[1, 1], max_concurrency=[1, 1])

    await manager.update_quota(0, remaining=2, unit="video credits", source="video_signal", status="available")
    await manager.update_quota(1, remaining=5, unit="video credits", source="video_signal", status="available")

    async with manager.acquire_for_quota(4) as lease:
        assert lease.cookie == "cookie-b"

    accounts = manager.snapshot()["accounts"]
    assert accounts[0]["status"] == "available"
    assert accounts[0]["quota"]["remaining"] == 2


@pytest.mark.asyncio
async def test_same_day_video_history_cannot_raise_confirmed_remaining_quota():
    manager = CredentialManager(["cookie-a"])

    await manager.update_quota(
        0,
        remaining=0,
        unit="video credits",
        source="frontend_video_completion",
        status="exhausted",
    )
    account = await manager.update_quota(
        0,
        remaining=4,
        unit="video credits",
        source="video_history",
        status="available",
    )

    assert account["quota"]["remaining"] == 0
    assert account["quota"]["status"] == "exhausted"
    assert account["quota"]["source"] == "frontend_video_completion"


@pytest.mark.asyncio
async def test_video_quota_acquire_can_probe_unknown_account_explicitly():
    manager = CredentialManager(["cookie-a"])

    with pytest.raises(TimeoutError):
        await manager.acquire_lease_for_quota(2, timeout=0.05)

    with pytest.raises(TimeoutError):
        await manager.acquire_lease_for_quota(2, timeout=0.05, allow_unknown=True)

    await manager.update_quota(
        0,
        unit="video credits",
        source="video_history",
        status="unknown",
        error="No current-day video quota signal was found in Doubao conversation history.",
    )

    lease = await manager.acquire_lease_for_quota(2, timeout=0.05, allow_unknown=True)
    assert lease.cookie == "cookie-a"
    await lease.release()


@pytest.mark.asyncio
async def test_video_quota_acquire_can_probe_pending_refresh_timeout_explicitly():
    manager = CredentialManager(["cookie-a"])

    await manager.update_quota(
        0,
        unit="video credits",
        source="video_history",
        status="pending_refresh",
        error="Video quota refresh timed out after 30s.",
    )

    with pytest.raises(TimeoutError):
        await manager.acquire_lease_for_quota(2, timeout=0.05)

    lease = await manager.acquire_lease_for_quota(2, timeout=0.05, allow_unknown=True)
    assert lease.cookie == "cookie-a"
    await lease.release()


@pytest.mark.asyncio
async def test_quota_exhausted_accounts_do_not_reenter_pool_after_manual_enable():
    manager = CredentialManager(["cookie-a", "cookie-b"], weights=[1, 1], max_concurrency=[1, 1])

    await manager.update_quota(
        0,
        total=10,
        remaining=0,
        used=10,
        unit="credits",
        source="upstream",
        status="available",
    )
    enabled = await manager.update_account(0, disabled=False)

    assert enabled["status"] == "disabled"
    assert enabled["disabled_reason"] == "quota_exhausted"
    assert enabled["quota"]["status"] == "exhausted"

    async with manager.acquire() as lease:
        assert lease.cookie == "cookie-b"



@pytest.mark.asyncio
async def test_positive_quota_refresh_recovers_only_quota_disabled_accounts():
    manager = CredentialManager(["cookie-a", "cookie-b"], weights=[1, 1], max_concurrency=[1, 1])

    await manager.disable_for_quota_exhausted(0, "Doubao quota remaining is 0.", source="upstream")
    recovered = await manager.update_quota(
        0,
        total=10,
        remaining=3,
        used=7,
        unit="credits",
        source="upstream",
        status="available",
    )

    assert recovered["status"] == "available"
    assert recovered["disabled_reason"] is None
    assert recovered["quota"]["remaining"] == 3
    async with manager.acquire() as lease:
        assert lease.cookie == "cookie-a"

    await manager.update_account(1, disabled=True)
    manual = await manager.update_quota(
        1,
        total=10,
        remaining=4,
        used=6,
        unit="credits",
        source="upstream",
        status="available",
    )

    assert manual["status"] == "disabled"
    assert manual["disabled_reason"] == "manual"
    assert manual["quota"]["remaining"] == 4


def test_persisted_video_quota_disabled_accounts_recover_next_day(monkeypatch, tmp_path):
    store_path = tmp_path / "disabled.json"
    monkeypatch.setattr("app.services.credential_manager.settings.DOUBAO_DISABLED_CREDENTIAL_STORE_PATH", str(store_path))
    identity = credential_identity("sessionid=quota")
    store_path.write_text(
        json.dumps(
            {
                "credentials": [
                    {
                        "identity": identity,
                        "fingerprint": "old",
                        "reason": "quota_exhausted",
                        "error": "video quota exhausted",
                        "disabled_at": 1_780_000_000,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr("app.services.credential_manager.time.time", lambda: 1_780_200_000)

    manager = CredentialManager(["sessionid=quota"])
    account = manager.snapshot()["accounts"][0]

    assert account["status"] == "available"
    assert account["disabled_reason"] is None
    assert json.loads(store_path.read_text(encoding="utf-8"))["credentials"] == []


@pytest.mark.asyncio
async def test_runtime_video_quota_state_resets_after_beijing_day_rollover(monkeypatch, tmp_path):
    store_path = tmp_path / "disabled.json"
    monkeypatch.setattr("app.services.credential_manager.settings.DOUBAO_DISABLED_CREDENTIAL_STORE_PATH", str(store_path))
    clock = {"now": 1_780_000_000.0}
    monkeypatch.setattr("app.services.credential_manager.time.time", lambda: clock["now"])
    manager = CredentialManager(["sessionid=empty", "sessionid=low"])

    await manager.disable_for_quota_exhausted(0, "daily limit reached", source="video_history")
    await manager.update_quota(1, remaining=1, source="video_history", status="available")
    clock["now"] += 90_000

    reset_indexes = await manager.reset_expired_video_quotas()
    accounts = manager.snapshot()["accounts"]

    assert reset_indexes == [0, 1]
    assert accounts[0]["status"] == "available"
    assert accounts[0]["disabled_reason"] is None
    assert accounts[1]["status"] == "available"
    assert all(account["quota"]["status"] == "unknown" for account in accounts)
    assert all(account["quota"]["remaining"] is None for account in accounts)
    assert json.loads(store_path.read_text(encoding="utf-8"))["credentials"] == []


@pytest.mark.asyncio
async def test_confirmed_video_quota_persists_until_beijing_day_rollover(monkeypatch, tmp_path):
    quota_store = tmp_path / "video_quotas.json"
    monkeypatch.setattr(
        "app.services.credential_manager.settings.DOUBAO_VIDEO_QUOTA_STORE_PATH",
        str(quota_store),
    )
    clock = {"now": 1_780_000_000.0}
    monkeypatch.setattr("app.services.credential_manager.time.time", lambda: clock["now"])

    manager = CredentialManager(["sessionid=quota-cache"])
    await manager.update_quota(
        0,
        total=10,
        remaining=6,
        used=4,
        source="video_history",
        status="available",
    )

    restarted = CredentialManager(["sessionid=quota-cache"])
    cached = restarted.snapshot()["accounts"][0]["quota"]
    assert cached["status"] == "available"
    assert cached["remaining"] == 6
    assert cached["source"] == "video_history"

    clock["now"] += 90_000
    next_day = CredentialManager(["sessionid=quota-cache"])
    expired = next_day.snapshot()["accounts"][0]["quota"]
    assert expired["status"] == "unknown"
    assert expired["remaining"] is None


@pytest.mark.asyncio
async def test_no_signal_video_quota_state_persists_until_beijing_day_rollover(monkeypatch, tmp_path):
    quota_store = tmp_path / "video_quotas.json"
    monkeypatch.setattr(
        "app.services.credential_manager.settings.DOUBAO_VIDEO_QUOTA_STORE_PATH",
        str(quota_store),
    )
    clock = {"now": 1_780_000_000.0}
    monkeypatch.setattr("app.services.credential_manager.time.time", lambda: clock["now"])

    manager = CredentialManager(["sessionid=no-signal"])
    await manager.update_quota(
        0,
        unit="video credits",
        source="video_history",
        status="unknown",
        error="No current-day video quota signal was found in Doubao conversation history.",
    )

    restarted = CredentialManager(["sessionid=no-signal"])
    cached = restarted.snapshot()["accounts"][0]["quota"]
    assert cached["status"] == "unknown"
    assert cached["source"] == "video_history"
    assert "No current-day video quota signal" in cached["last_error"]

    clock["now"] += 90_000
    next_day = CredentialManager(["sessionid=no-signal"])
    expired = next_day.snapshot()["accounts"][0]["quota"]
    assert expired["status"] == "unknown"
    assert expired["source"] != "video_history"
    assert expired["last_error"] is None


def test_legacy_advisory_quota_disable_recovers_immediately(monkeypatch, tmp_path):
    store_path = tmp_path / "disabled.json"
    monkeypatch.setattr("app.services.credential_manager.settings.DOUBAO_DISABLED_CREDENTIAL_STORE_PATH", str(store_path))
    identity = credential_identity("sessionid=quota")
    store_path.write_text(
        json.dumps(
            {
                "credentials": [
                    {
                        "identity": identity,
                        "fingerprint": "old",
                        "reason": "quota_exhausted",
                        "error": "Doubao quota remaining is 0.",
                        "disabled_at": 1_780_000_000,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr("app.services.credential_manager.time.time", lambda: 1_780_000_100)

    manager = CredentialManager(["sessionid=quota"])
    account = manager.snapshot()["accounts"][0]

    assert account["status"] == "available"
    assert account["disabled_reason"] is None
    assert json.loads(store_path.read_text(encoding="utf-8"))["credentials"] == []


def test_persisted_accepted_zero_remaining_disable_recovers_immediately(monkeypatch, tmp_path):
    store_path = tmp_path / "disabled.json"
    monkeypatch.setattr("app.services.credential_manager.settings.DOUBAO_DISABLED_CREDENTIAL_STORE_PATH", str(store_path))
    identity = credential_identity("sessionid=quota")
    accepted = (
        "\u8fd9\u5c31\u4e3a\u60a8\u751f\u6210\u4e00\u6bb5\u8df3\u821e\u7684\u89c6\u9891\uff0c"
        "\u8bf7\u7a0d\u7b49\u7247\u523b~ "
        "\u672c\u6b21\u4f7f\u7528 **Seedance 2.0 Fast** \u751f\u6210\uff0c"
        "\u5c06\u6d88\u8017 2 \u4e2a\u89c6\u9891\u751f\u6210\u989d\u5ea6\uff0c"
        "\u9884\u8ba1\u7b49\u5f85 1-3\u5206\u949f\u3002"
        "\u89c6\u9891\u751f\u6210\u597d\u540e\uff0c\u6211\u4f1a\u4e3b\u52a8\u53d1\u9001\u7ed9\u4f60\uff0c"
        "\u4eca\u65e5\u5269\u4f59 0 \u4e2a\u89c6\u9891\u751f\u6210\u989d\u5ea6\u3002"
    )
    store_path.write_text(
        json.dumps(
            {
                "credentials": [
                    {
                        "identity": identity,
                        "fingerprint": "old",
                        "reason": "quota_exhausted",
                        "error": accepted,
                        "source": "upstream_error",
                        "disabled_at": 1_780_000_000,
                        "reset_at": 1_780_086_400,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr("app.services.credential_manager.time.time", lambda: 1_780_000_100)

    manager = CredentialManager(["sessionid=quota"])
    account = manager.snapshot()["accounts"][0]

    assert account["status"] == "available"
    assert account["disabled_reason"] is None
    assert json.loads(store_path.read_text(encoding="utf-8"))["credentials"] == []


@pytest.mark.asyncio
async def test_reported_advisory_quota_does_not_enter_video_pool():
    manager = CredentialManager(["cookie-a"], weights=[1], max_concurrency=[1])
    account = await manager.update_quota(
        0,
        remaining=0,
        unit="credits",
        source="benefit_credit_advisory",
        status="reported",
    )

    assert account["status"] == "available"
    with pytest.raises(TimeoutError, match="confirmed enough video quota"):
        async with manager.acquire_for_quota(1):
            pass

    async with manager.acquire() as lease:
        assert lease.cookie == "cookie-a"
