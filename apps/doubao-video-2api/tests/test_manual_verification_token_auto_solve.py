import asyncio
import json
from types import SimpleNamespace

import pytest

from app.services.manual_verification import (
    ManualVerificationManager,
    ManualVerificationRecord,
    manual_success_terms_from_text,
)


def test_bdturing_success_marks_auto_solved():
    manager = ManualVerificationManager()
    record = ManualVerificationRecord(
        account_index=0,
        cookie="cookie",
        session=SimpleNamespace(),
        started_at=1.0,
        expires_at=2.0,
        snapshot_interval_seconds=1.0,
        headless=True,
    )
    record.captcha_probe = {"solver_compatible": False}
    record.bdturing_render = {"render_called": True, "container_visible": False}
    record.bdturing_result = {"status": "success", "at": 123}
    workflow = {"object": "manual_verification_auto_verify", "steps": []}

    assert manager._bdturing_token_succeeded(record) is True

    manager._mark_bdturing_auto_solved(record, workflow)

    solution = workflow["captcha_solution"]
    assert solution["attempted"] is True
    assert solution["solved"] is True
    assert solution["backend"] == "bdturing_token_render"
    assert solution["bdturing_result"] == {"status": "success", "at": 123}
    assert workflow["steps"] == [
        {
            "name": "auto_solve_bdturing_token",
            "attempted": True,
            "solved": True,
            "error": None,
        }
    ]
    assert "auto-solved" in record.message


def test_generation_acceptance_text_marks_manual_verification_success():
    text = (
        "这就为您生成一个跳舞的视频。\n"
        "本次使用 Seedance 2.0 Fast 生成，将消耗 2 个视频生成额度，"
        "预计等待 1-3 分钟。视频生成好后，我会主动发送给你，今日剩余 4 个视频生成额度。"
    )

    terms = manual_success_terms_from_text(text)

    assert "这就为您生成" in terms
    assert "预计等待 1-3分钟" in terms
    assert "视频生成好后" in terms
    assert "会主动发送给你" in terms


def test_generation_acceptance_message_wins_over_empty_bdturing_render():
    manager = ManualVerificationManager()
    record = ManualVerificationRecord(
        account_index=0,
        cookie="cookie",
        session=SimpleNamespace(),
        started_at=1.0,
        expires_at=2.0,
        snapshot_interval_seconds=1.0,
        headless=True,
    )
    record.manual_success_terms = ("视频生成好后",)
    record.bdturing_render = {"render_called": True, "container_visible": False}

    assert manager._active_message(record) == (
        "Manual Doubao video generation success observed in headless snapshot."
    )


@pytest.mark.asyncio
async def test_frontend_chain_response_records_video_result_and_wakes_waiter():
    manager = ManualVerificationManager()
    record = ManualVerificationRecord(
        account_index=0,
        cookie="cookie",
        session=SimpleNamespace(profile_id="profile-a"),
        started_at=1.0,
        expires_at=2.0,
        snapshot_interval_seconds=1.0,
        headless=True,
        video_result_event=asyncio.Event(),
    )

    class FakeResponse:
        url = "https://www.doubao.com/im/chain/single"

        async def text(self):
            return json.dumps(
                {
                    "conversation_id": "38431912429684226",
                    "video_id": "v0369cg10004example",
                    "video_url": "https://example.test/generated.mp4",
                }
            )

    await manager._record_chat_completion_response(record, FakeResponse())

    assert record.video_result_event.is_set() is True
    assert record.video_signals["conversation_ids"] == ["38431912429684226"]
    assert record.video_signals["video_ids"] == ["v0369cg10004example"]
    assert record.video_signals["video_urls"] == ["https://example.test/generated.mp4"]


@pytest.mark.asyncio
async def test_enter_light_video_wait_marks_record_and_slows_snapshot_loop():
    manager = ManualVerificationManager()
    record = ManualVerificationRecord(
        account_index=0,
        cookie="cookie",
        session=SimpleNamespace(profile_id="profile-a"),
        started_at=1.0,
        expires_at=2.0,
        snapshot_interval_seconds=3.0,
        headless=True,
    )
    manager._records[0] = record

    payload = await manager.enter_light_video_wait(
        0,
        snapshot_interval_seconds=30,
    )

    assert record.light_video_wait is True
    assert record.light_video_wait_started_at is not None
    assert record.snapshot_interval_seconds == 30
    assert payload["light_video_wait"] is True
