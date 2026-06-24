import asyncio
import base64
import json
import time
from pathlib import Path

import imageio.v3 as iio
import numpy as np
import pytest
from httpx import ASGITransport, AsyncClient

from main import app
from app.core.config import Settings, settings
from app.providers.video_provider import (
    DOUBAO_BLOCK_ATTACHMENT,
    DOUBAO_BLOCK_TEXT,
    RetryableUploadAuthError,
    VideoProvider,
    VideoQuotaInsufficientError,
    _is_watermarked_video_url,
    _select_failure,
    empty_video_signals,
    extract_video_signals,
    extract_video_quota_text,
    normalize_prepare_upload_data,
    normalize_prompt_text,
)
from app.routes.video import _openai_video_progress, _raw_video_task, set_video_provider_getter
from app.services.credential_manager import CredentialManager


def data_url_png() -> str:
    image = np.zeros((16, 16, 3), dtype=np.uint8)
    image[:, :, 0] = 240
    image[:, :, 1] = np.arange(16, dtype=np.uint8)[None, :] * 12
    image[:, :, 2] = np.arange(16, dtype=np.uint8)[:, None] * 12
    png = iio.imwrite("<bytes>", image, extension=".png")
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def test_video_provider_defaults_to_real_mode_in_runtime_config():
    assert Settings.model_fields["VIDEO_PROVIDER"].default == "doubao_web"
    assert Settings.model_fields["DOUBAO_VIDEO_QUOTA_COST"].default == 2
    assert Settings.model_fields["DOUBAO_VIDEO_QUOTA_AUTO_REFRESH"].default is True
    assert Settings.model_fields["DOUBAO_VIDEO_QUOTA_REFRESH_CONCURRENCY"].default == 1
    assert Settings.model_fields["DOUBAO_VIDEO_QUOTA_REFRESH_INTERVAL_SECONDS"].default == 30
    assert Settings.model_fields["DOUBAO_VIDEO_QUOTA_REFRESH_BATCH_SIZE"].default == 1
    assert Settings.model_fields["DOUBAO_VIDEO_QUOTA_REFRESH_MIN_AVAILABLE_ACCOUNTS"].default == 3
    assert Settings.model_fields["DOUBAO_VIDEO_QUOTA_UNKNOWN_REFRESH_INTERVAL_SECONDS"].default == 600
    assert Settings.model_fields["DOUBAO_VIDEO_QUOTA_REFRESH_TIMEOUT_SECONDS"].default == 30
    assert Settings.model_fields["DOUBAO_VIDEO_VERIFICATION_RETRY_LIMIT"].default == 3
    assert Settings.model_fields["DOUBAO_VIDEO_TASK_TIMEOUT_SECONDS"].default == 900
    assert Settings.model_fields["VIDEO_TASK_RETENTION_SECONDS"].default == 3600
    assert Settings.model_fields["VIDEO_TASK_MAX_RETAINED"].default == 500
    assert Settings.model_fields["VIDEO_TASK_CLEANUP_INTERVAL_SECONDS"].default == 300
    assert Settings.model_fields["DOUBAO_VIDEO_QUOTA_INITIAL_REFRESH"].default is True
    assert Settings.model_fields["DOUBAO_VIDEO_ALLOW_UNKNOWN_QUOTA_ON_GENERATE"].default is False
    assert Settings.model_fields["DOUBAO_BROWSER_IDLE_TIMEOUT_SECONDS"].default == 120
    assert Settings.model_fields["DOUBAO_BROWSER_LAZY_START"].default is True
    assert Settings.model_fields["DOUBAO_BROWSER_IDLE_SHUTDOWN_SECONDS"].default == 45
    assert Settings.model_fields["DOUBAO_BROWSER_STALE_SESSION_SECONDS"].default == 300
    assert Settings.model_fields["DOUBAO_VIDEO_WATERMARK"].default is False
    assert settings.VIDEO_PROVIDER == "mock"


def test_admin_page_keeps_long_form_duration_fallbacks():
    html = (Path(__file__).resolve().parents[1] / "app" / "static" / "admin.html").read_text(encoding="utf-8")

    for duration in [5, 10, 15, 20, 25, 30]:
        assert f'<option value="{duration}">{duration}s</option>' in html


def test_openai_video_progress_uses_doubao_polling_attempt():
    assert _openai_video_progress(
        {"status": "polling", "polling": {"attempt": 30, "max_attempts": 60}}
    ) == 50
    assert _openai_video_progress(
        {"status": "polling", "polling": {"attempt": 80, "max_attempts": 60}}
    ) == 95
    assert _openai_video_progress({"status": "polling"}) == 1


def test_public_video_task_exposes_lightweight_polling_state():
    provider = VideoProvider()
    task = {
        "id": "vid-test",
        "object": "video.generation",
        "created": 123,
        "model": "doubao-seedance-2-0",
        "prompt": "dance",
        "params": {"duration": 10},
        "reference_image_meta": None,
        "status": "polling",
        "error": None,
        "result": None,
        "debug": {
            "polling": {
                "conversation_id": "internal-conversation-id",
                "attempt": 30,
                "max_attempts": 60,
                "poll_interval": 5,
            },
            "signals": empty_video_signals(),
        },
    }

    public = provider._public_task(task)

    assert public["polling"] == {"attempt": 30, "max_attempts": 60, "poll_interval": 5}


def test_upstream_debug_includes_terminal_video_metadata(tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path / "videos"
    task = {
        "id": "vid-test",
        "object": "video.generation",
        "created": 123,
        "status": "succeeded",
        "model": "doubao-seedance-2-0",
        "prompt": "dance",
        "credential_index": 0,
        "params": {"duration": 10},
        "reference_image_meta": {"file_name": "reference.png"},
        "error": None,
        "result": {
            "url": "https://example.test/video.mp4",
            "upstream_url": "https://example.test/video.mp4",
            "content_type": "video/mp4",
        },
        "debug": {"signals": empty_video_signals()},
    }

    provider._write_upstream_debug(task)

    data = json.loads((tmp_path / "upstream-debug-vid-test.json").read_text(encoding="utf-8"))
    assert data["status"] == "succeeded"
    assert data["model"] == "doubao-seedance-2-0"
    assert data["prompt"] == "dance"
    assert data["result"]["url"] == "https://example.test/video.mp4"


def test_cached_video_task_restores_debug_metadata(tmp_path):
    import main as main_module

    provider = VideoProvider()
    provider.output_dir = tmp_path / "videos"
    provider.output_dir.mkdir(parents=True)
    task_id = "vid-cached"
    (provider.output_dir / f"{task_id}.mp4").write_bytes(b"\x00\x00\x00 ftypisom")
    (tmp_path / f"upstream-debug-{task_id}.json").write_text(
        json.dumps(
            {
                "object": "video.generation",
                "created": 456,
                "model": "doubao-seedance-2-0",
                "prompt": "dance",
                "params": {"duration": 10},
                "reference_image": {"file_name": "reference.png"},
                "result": {
                    "url": "https://example.test/video.mp4",
                    "upstream_url": "https://example.test/video.mp4",
                    "content_type": "video/mp4",
                },
            }
        ),
        encoding="utf-8",
    )

    set_video_provider_getter(lambda: provider)
    try:
        task = _raw_video_task(task_id)
    finally:
        set_video_provider_getter(lambda: main_module.video_provider)

    assert task["created"] == 456
    assert task["model"] == "doubao-seedance-2-0"
    assert task["prompt"] == "dance"
    assert task["params"] == {"duration": 10}
    assert task["reference_image_meta"] == {"file_name": "reference.png"}
    assert task["result"]["url"] == "https://example.test/video.mp4"


def test_doubao_cookie_loading_allows_index_gaps(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ENABLE_CHAT_PROVIDER", "false")
    monkeypatch.delenv("DOUBAO_COOKIE_1", raising=False)
    monkeypatch.setenv("DOUBAO_COOKIE_3", "sessionid=gap")

    cfg = Settings()

    assert cfg.DOUBAO_COOKIES == ["sessionid=gap"]


def test_doubao_web_config_allows_empty_cookie_pool(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("DOUBAO_COOKIE_1", raising=False)
    monkeypatch.delenv("DOUBAO_COOKIE_2", raising=False)
    monkeypatch.delenv("DOUBAO_COOKIE_3", raising=False)
    monkeypatch.setenv("VIDEO_PROVIDER", "doubao_web")
    monkeypatch.setenv("DOUBAO_DEVICE_ID", "device")
    monkeypatch.setenv("DOUBAO_FP", "fp")
    monkeypatch.setenv("DOUBAO_TEA_UUID", "tea")
    monkeypatch.setenv("DOUBAO_WEB_ID", "web")

    cfg = Settings()

    assert cfg.VIDEO_PROVIDER == "doubao_web"
    assert cfg.DOUBAO_COOKIES == []


@pytest.mark.asyncio
async def test_video_provider_does_not_refresh_all_quotas_on_startup(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    calls = []

    class FakeCredentialManager:
        active_credentials = ["cookie-a"]

    class FakePlaywrightManager:
        async def initialize(self, credentials):
            calls.append(("initialize", list(credentials)))

        async def close(self):
            calls.append(("close",))

    async def fail_refresh():
        raise AssertionError("startup quota refresh should be disabled")

    monkeypatch.setattr(settings, "VIDEO_PROVIDER", "doubao_web")
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_AUTO_REFRESH", False)
    monkeypatch.setattr(CredentialManager, "shared", staticmethod(lambda: FakeCredentialManager()))
    monkeypatch.setattr("app.providers.video_provider.PlaywrightManager", FakePlaywrightManager)
    monkeypatch.setattr(provider, "refresh_video_quotas", fail_refresh)

    await provider.initialize()

    assert provider._quota_refresh_task is None
    assert calls == [("initialize", ["cookie-a"])]

    await provider.close()


@pytest.mark.asyncio
async def test_video_provider_starts_initial_quota_refresh_by_default(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    calls = []

    class FakeCredentialManager:
        active_credentials = ["cookie-a"]

    class FakePlaywrightManager:
        async def initialize(self, credentials):
            calls.append(("initialize", list(credentials)))

        async def close(self):
            calls.append(("close",))

    async def fake_refresh(*args, **kwargs):
        calls.append(("refresh", kwargs))
        return {"checked_count": 0, "available_count": 0, "exhausted_count": 0, "unknown_count": 0}

    monkeypatch.setattr(settings, "VIDEO_PROVIDER", "doubao_web")
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_AUTO_REFRESH", True)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_INITIAL_REFRESH", True)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_REFRESH_BATCH_SIZE", 1)
    monkeypatch.setattr(CredentialManager, "shared", staticmethod(lambda: FakeCredentialManager()))
    monkeypatch.setattr("app.providers.video_provider.PlaywrightManager", FakePlaywrightManager)
    monkeypatch.setattr(provider, "refresh_stale_video_quotas", fake_refresh)

    await provider.initialize()
    await asyncio.sleep(0)

    assert provider._quota_refresh_task is not None
    assert provider._quota_auto_refresh_task is not None
    assert calls == [
        ("initialize", ["cookie-a"]),
        ("refresh", {"confirmed_only": False, "limit": 1, "rotate": True}),
    ]

    await provider.close()


@pytest.mark.asyncio
async def test_video_generation_closed_loop():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            create_response = await client.post(
                "/v1/video/generations",
                json={
                    "model": "doubao-video-mock",
                    "prompt": "A short cinematic clip of a neon city street.",
                    "aspect_ratio": "9:16",
                    "resolution": "720p",
                    "duration": 5,
                },
            )
            assert create_response.status_code == 202

            task = create_response.json()
            assert task["id"].startswith("vid-")
            assert task["status"] == "queued"
            assert task["data"] == []
            assert task["params"]["ratio"] == "9:16"
            assert task["params"]["size"] == "720x1280"

            for _ in range(20):
                poll_response = await client.get(f"/v1/video/generations/{task['id']}")
                assert poll_response.status_code == 200
                task = poll_response.json()
                if task["status"] == "succeeded":
                    break
                await asyncio.sleep(0.05)

            assert task["status"] == "succeeded"
            assert task["params"]["duration"] == 5
            assert task["params"]["resolution"] == "720p"
            assert task["data"][0]["content_type"] == "video/mp4"
            assert task["data"][0]["url"].endswith(f"/v1/video/generations/{task['id']}/content")

            download_response = await client.get(f"/v1/video/generations/{task['id']}/content")
            assert download_response.status_code == 200
            assert download_response.headers["content-type"].startswith("video/mp4")
            assert download_response.content[4:8] == b"ftyp"


@pytest.mark.asyncio
async def test_openai_style_videos_create_retrieve_and_download():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            create_response = await client.post(
                "/v1/videos",
                json={
                    "model": "doubao-video-mock",
                    "prompt": "A short cinematic clip of ocean waves.",
                    "seconds": 5,
                    "size": "720x1280",
                    "resolution_name": "720p",
                },
            )
            assert create_response.status_code == 200

            task = create_response.json()
            assert task["id"].startswith("vid-")
            assert task["object"] == "video"
            assert task["status"] == "queued"
            assert task["prompt"] == "A short cinematic clip of ocean waves."
            assert task["content_url"] == f"/v1/videos/{task['id']}/content"
            assert task["status_url"] == f"http://testserver/v1/videos/{task['id']}"

            for _ in range(20):
                poll_response = await client.get(f"/v1/videos/{task['id']}")
                assert poll_response.status_code == 200
                task = poll_response.json()
                if task["status"] == "completed":
                    break
                await asyncio.sleep(0.05)

            assert task["status"] == "completed"
            assert task["progress"] == 100
            assert task["prompt"] == "A short cinematic clip of ocean waves."
            assert task["data"][0]["url"] == f"/v1/videos/{task['id']}/content"
            assert task["data"][0]["legacy_url"].endswith(f"/v1/video/generations/{task['id']}/content")

            download_response = await client.get(f"/v1/videos/{task['id']}/content")
            assert download_response.status_code == 200
            assert download_response.headers["content-type"].startswith("video/mp4")
            assert download_response.content[4:8] == b"ftyp"


@pytest.mark.asyncio
async def test_openai_style_videos_accepts_xinghui_parameter_aliases():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            create_response = await client.post(
                "/v1/videos",
                json={
                    "model": "doubao-video-mock",
                    "prompt": "A vertical long form product clip.",
                    "duration_seconds": 15,
                    "video_size": "720x1280",
                    "resolution": "720p",
                },
            )
            assert create_response.status_code == 200

            task = create_response.json()
            assert task["params"]["duration"] == 15
            assert task["params"]["ratio"] == "9:16"
            assert task["params"]["size"] == "720x1280"


@pytest.mark.asyncio
async def test_plural_legacy_video_generation_retrieve_and_download_is_not_shadowed():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            create_response = await client.post(
                "/v1/videos/generations",
                json={
                    "model": "doubao-video-mock",
                    "prompt": "A short compatibility test clip.",
                    "aspect_ratio": "16:9",
                    "resolution": "720p",
                    "duration": 5,
                },
            )
            assert create_response.status_code == 202

            task = create_response.json()
            assert task["id"].startswith("vid-")

            for _ in range(20):
                poll_response = await client.get(f"/v1/videos/generations/{task['id']}")
                assert poll_response.status_code == 200
                task = poll_response.json()
                if task["status"] == "succeeded":
                    break
                await asyncio.sleep(0.05)

            assert task["status"] == "succeeded"
            assert task["data"][0]["url"].endswith(f"/v1/video/generations/{task['id']}/content")

            download_response = await client.get(f"/v1/videos/generations/{task['id']}/content")
            assert download_response.status_code == 200
            assert download_response.headers["content-type"].startswith("video/mp4")
            assert download_response.content[4:8] == b"ftyp"


@pytest.mark.asyncio
async def test_video_model_can_be_created_through_chat_completion_compatibility():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post(
                "/v1/chat/completions",
                json={
                    "model": "doubao-video-mock",
                    "messages": [{"role": "user", "content": "A tiny video of a sunrise."}],
                    "stream": False,
                    "duration": 5,
                },
            )
            assert response.status_code == 200
            payload = response.json()
            content = payload["choices"][0]["message"]["content"]
            assert "Video generation task created." in content
            assert "status_url: http://testserver/v1/video/generations/vid-" in content
            assert "content_url: /v1/video/generations/vid-" in content
            metadata = payload["video_generation"]
            message_metadata = payload["choices"][0]["message"]["video_generation"]
            assert metadata == message_metadata
            assert metadata["task_id"].startswith("vid-")
            assert metadata["status"] == "queued"
            assert metadata["status_url"] == f"http://testserver/v1/video/generations/{metadata['task_id']}"
            assert metadata["content_url"] == f"/v1/video/generations/{metadata['task_id']}/content"
            assert metadata["download_url"] == metadata["content_url"]
            assert metadata["requires_authorization"] is True


@pytest.mark.asyncio
async def test_video_chat_completion_stream_includes_generation_metadata():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post(
                "/v1/chat/completions",
                json={
                    "model": "doubao-video-mock",
                    "messages": [{"role": "user", "content": "A tiny video of a sunrise."}],
                    "stream": True,
                    "duration": 5,
                },
            )
            assert response.status_code == 200
            first_line = next(
                line for line in response.text.splitlines()
                if line.startswith("data: ") and line != "data: [DONE]"
            )
            chunk = json.loads(first_line.removeprefix("data: "))
            metadata = chunk["video_generation"]
            delta_metadata = chunk["choices"][0]["delta"]["video_generation"]
            assert metadata == delta_metadata
            assert metadata["task_id"].startswith("vid-")
            assert metadata["content_url"].endswith(f"/v1/video/generations/{metadata['task_id']}/content")


@pytest.mark.asyncio
async def test_openapi_exposes_xinghui_video_parameters():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/openapi.json")
        assert response.status_code == 200
        doc = response.json()
        operation = doc["paths"]["/v1/videos/generations"]["post"]
        schema = operation["requestBody"]["content"]["multipart/form-data"]["schema"]

        assert operation["tags"] == ["video"]
        assert schema["properties"]["model"]["enum"] == ["doubao-seedance-2-0"]
        assert schema["properties"]["duration"]["enum"] == [5, 10, 15, 20, 25, 30]
        assert "size" not in schema["properties"]
        assert schema["properties"]["input_reference[]"]["items"]["format"] == "binary"
        standard_schema = doc["paths"]["/v1/videos"]["post"]["requestBody"]["content"]["application/json"]["schema"]
        assert {"model", "prompt", "seconds", "size", "resolution_name"}.issubset(standard_schema["properties"])
        assert len(standard_schema["properties"]) == 7


@pytest.mark.asyncio
async def test_model_list_exposes_public_long_form_duration_options():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/v1/models", headers={"Authorization": "Bearer 1"})

        assert response.status_code == 200
        model = next(item for item in response.json()["data"] if item["id"] == "doubao-seedance-2-0")
        params = model["video_parameters"]
        assert params["durations"] == [5, 10, 15, 20, 25, 30]
        assert params["duration_options"] == [5, 10, 15, 20, 25, 30]
        assert params["seconds"] == [5, 10, 15, 20, 25, 30]
        assert params["native_durations"] == [5, 10, 15, 20, 25, 30]
        assert params["segment_durations"] == [10, 5]
        assert params["provider_native_durations"] == [10, 5]


@pytest.mark.asyncio
async def test_video_generation_accepts_xinghui_multipart_reference_image():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            png = base64.b64decode(data_url_png().split(",", 1)[1])
            response = await client.post(
                "/v1/videos/generations",
                data={
                    "model": "doubao-video-mock",
                    "prompt": "Animate this uploaded reference.",
                    "duration": "5",
                    "aspect_ratio": "1:1",
                    "resolution": "720p",
                },
                files={
                    "input_reference[]": ("reference.png", png, "image/png"),
                },
            )

            assert response.status_code == 202
            payload = response.json()
            assert payload["id"].startswith("vid-")
            assert payload["reference_image"]["file_name"] == "reference.png"
            assert payload["reference_image"]["kind"] == "multipart_upload"
            assert payload["params"]["ratio"] == "1:1"


@pytest.mark.asyncio
async def test_video_generation_with_reference_image():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            create_response = await client.post(
                "/v1/video/generations",
                json={
                    "model": "doubao-seedance-2-0",
                    "prompt": "Animate this reference image.",
                    "aspect_ratio": "1:1",
                    "resolution": "720p",
                    "duration": 10,
                    "reference_image": {
                        "data": data_url_png(),
                        "file_name": "reference.png",
                        "mime_type": "image/png",
                    },
                },
            )
            assert create_response.status_code == 202

            task = create_response.json()
            assert task["reference_image"]["file_name"] == "reference.png"
            assert task["reference_image"]["kind"] == "inline_data"

            for _ in range(20):
                poll_response = await client.get(f"/v1/video/generations/{task['id']}")
                assert poll_response.status_code == 200
                task = poll_response.json()
                if task["status"] == "succeeded":
                    break
                await asyncio.sleep(0.05)

            assert task["status"] == "succeeded"
            assert task["params"]["ratio"] == "1:1"
            assert task["reference_image"]["mime_type"] == "image/png"


@pytest.mark.asyncio
async def test_long_form_video_generation_concatenates_segments():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            create_response = await client.post(
                "/v1/video/generations",
                json={
                    "model": "doubao-video-mock",
                    "prompt": "A longer cinematic travel montage.",
                    "aspect_ratio": "16:9",
                    "resolution": "720p",
                    "duration": 25,
                },
            )
            assert create_response.status_code == 202

            task = create_response.json()
            assert task["params"]["duration"] == 25
            assert task["long_form"]["total_segments"] == 3
            assert [item["duration"] for item in task["long_form"]["segments"]] == [10, 10, 5]

            for _ in range(40):
                poll_response = await client.get(f"/v1/video/generations/{task['id']}")
                assert poll_response.status_code == 200
                task = poll_response.json()
                if task["status"] == "succeeded":
                    break
                await asyncio.sleep(0.05)

            assert task["status"] == "succeeded"
            assert task["long_form"]["completed_segments"] == 3
            assert all(item["status"] == "succeeded" for item in task["long_form"]["segments"])
            assert task["data"][0]["url"].endswith(f"/v1/video/generations/{task['id']}/content")

            download_response = await client.get(f"/v1/video/generations/{task['id']}/content")
            assert download_response.status_code == 200
            assert download_response.headers["content-type"].startswith("video/mp4")
            assert download_response.content[4:8] == b"ftyp"


def test_long_form_duration_splits_second_level_requests():
    provider = VideoProvider()
    assert provider._normalize_duration("15秒") == 15
    assert [item["duration"] for item in provider._long_form_plan({"duration": 15})["segments"]] == [10, 5]
    assert [item["duration"] for item in provider._long_form_plan({"duration": 20})["segments"]] == [10, 10]
    assert [item["duration"] for item in provider._long_form_plan({"duration": 25})["segments"]] == [10, 10, 5]
    assert [item["duration"] for item in provider._long_form_plan({"duration": 30})["segments"]] == [10, 10, 10]


def test_long_form_duration_rejects_minute_units():
    provider = VideoProvider()
    with pytest.raises(Exception):
        provider._normalize_duration("15m")


def test_video_polling_config_uses_request_values():
    provider = VideoProvider()

    assert provider._polling_config({}) == (5, 60)
    assert provider._polling_config({"poll_interval": 10, "poll_timeout": 600}) == (10.0, 60)
    assert provider._polling_config({"poll_interval": 0, "poll_timeout": 9999}) == (1, 1800)
    assert provider._video_task_timeout({}) == 900
    assert provider._video_task_timeout({"poll_timeout": 600}) == 600
    assert provider._video_task_timeout({"task_timeout": 30}) == 60


def test_rate_limit_signal_preserves_upstream_error_code():
    decision = {
        "from": "shark_admin",
        "type": "verify",
        "subtype": "semantic_reasoning",
        "verify_scene": "doubao_message_web",
        "log_id": "20260618033843A8608FB4F7FBED69883F",
        "detail": "opaque challenge detail",
    }
    signals = extract_video_signals(
        {
            "error_code": 710022004,
            "error_msg": "rate limited",
            "extra": {"decision": json.dumps(decision)},
        }
    )

    failure = _select_failure(signals["failures"])
    assert failure["code"] == "710022004"
    assert "browser verification" in failure["message"]
    assert failure["verification"]["verify_scene"] == "doubao_message_web"
    assert failure["verification"]["log_id"] == "20260618033843A8608FB4F7FBED69883F"
    assert signals["verification"][0]["detail"] == "opaque challenge detail"


@pytest.mark.asyncio
async def test_video_reference_upload_and_1080_mapping():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            upload_response = await client.post(
                "/v1/video/uploads",
                json={
                    "reference_image": {
                        "data": data_url_png(),
                        "file_name": "reference.png",
                        "mime_type": "image/png",
                    }
                },
            )
            assert upload_response.status_code == 200

            uploaded = upload_response.json()["data"]
            assert uploaded["fileKey"].startswith("mock://image/")
            assert uploaded["localKey"].startswith("local_")
            assert uploaded["imageWidth"] == 16
            assert uploaded["imageHeight"] == 16
            assert uploaded["md5"]

            create_response = await client.post(
                "/v1/video/generations",
                json={
                    "model": "doubao-seedance-2-0",
                    "prompt": "Animate this reference image in portrait.",
                    "aspect_ratio": "9:16",
                    "resolution": "1080p",
                    "duration": 5,
                    "reference_image": uploaded,
                },
            )
            assert create_response.status_code == 202

            task = create_response.json()
            assert task["params"]["model"] == "seedance_v2.0"
            assert task["params"]["size"] == "1080x1920"
            assert task["reference_image"]["file_key"] == uploaded["fileKey"]
            assert task["reference_image"]["image_width"] == 16
            assert task["reference_image"]["image_height"] == 16


def test_extract_video_signals_detects_upstream_failure():
    signals = extract_video_signals(
        {
            "conversation_id": "38430428492993794",
            "ext": {
                "ai_creation_tool_list": (
                    '[{"task_id":47314578497512450,"task_type":6,'
                    '"status":5,"fail_code":710082036}]'
                )
            },
            "content_block": [
                {"content": {"text_block": {"text": "Something went wrong"}}}
            ],
        }
    )

    assert signals["conversation_ids"] == ["38430428492993794"]
    assert signals["task_ids"] == ["47314578497512450"]
    assert {"code": "710082036", "message": "Upstream video generation failed."} in signals["failures"]
    assert {"code": None, "message": "Something went wrong"} in signals["failures"]


def test_extract_video_signals_detects_quota_failure_text():
    signals = extract_video_signals(
        {
            "content": {
                "text_block": {
                    "text": "本次视频生成需要消耗 4 个视频生成额度，今日剩余 2 个视频生成额度 ，无法生成该视频。"
                }
            }
        }
    )

    assert signals["failures"] == [
        {
            "code": None,
            "message": "本次视频生成需要消耗 4 个视频生成额度，今日剩余 2 个视频生成额度 ，无法生成该视频。",
        }
    ]


def test_extract_video_quota_text_only_reads_video_quota():
    quota = extract_video_quota_text(
        "\u672c\u6b21\u89c6\u9891\u751f\u6210\u9700\u8981\u6d88\u8017 4 "
        "\u4e2a\u89c6\u9891\u751f\u6210\u989d\u5ea6\uff0c\u4eca\u65e5\u5269\u4f59 2 "
        "\u4e2a\u89c6\u9891\u751f\u6210\u989d\u5ea6\uff0c\u65e0\u6cd5\u751f\u6210\u8be5\u89c6\u9891\u3002"
    )

    assert quota["cost"] == 4
    assert quota["remaining"] == 2
    assert quota["exhausted"] is False
    zero_quota = extract_video_quota_text("当前视频生成剩余额度为 0 个")
    assert zero_quota["remaining"] == 0
    assert zero_quota["exhausted"] is True
    assert extract_video_quota_text("credit_info total_credit_num 0") is None


def test_extract_video_quota_text_detects_daily_limit_without_number():
    quota = extract_video_quota_text(
        "\u4eca\u5929\u7684\u751f\u6210\u6b21\u6570\u5df2\u7ecf\u8fbe\u5230\u4e0a\u9650\uff0c"
        "\u660e\u5929\u518d\u6765\u514d\u8d39\u751f\u6210\u5427"
    )

    assert quota is not None
    assert quota["remaining"] is None
    assert quota["exhausted"] is True


def test_extract_video_quota_text_sanitizes_doubao_packet_json():
    packet = json.dumps(
        [
            {
                "PacketMeta": {"Seq": 0},
                "BlockInfo": {
                    "BlockContent": {
                        "content": {
                            "text_block": {
                                "text": (
                                    "这就为您生成一个他跳舞的视频，请稍等。 "
                                    "今日剩余 0 个视频生成额度。"
                                )
                            }
                        }
                    }
                },
            }
        ],
        ensure_ascii=False,
    )

    quota = extract_video_quota_text(packet)

    assert quota["remaining"] == 0
    assert quota["exhausted"] is False
    assert quota["message"] == "这就为您生成一个他跳舞的视频，请稍等。 今日剩余 0 个视频生成额度。"

def test_accepted_video_quota_zero_remaining_allows_polling():
    message = (
        "这就为您生成一段跳舞的视频，请稍等片刻~\n\n"
        "本次使用 **Seedance 2.0 Fast** 生成，将消耗 2 个视频生成额度，"
        "预计等待 1-3分钟。视频生成好后，我会主动发送给你，今日剩余 0 个视频生成额度。"
    )
    signals = extract_video_signals(
        {
            "conversation_id": "38432002057551618",
            "content_block": [{"content": {"text_block": {"text": message}}}],
        }
    )

    assert signals["conversation_ids"] == ["38432002057551618"]
    assert signals["failures"] == []
    assert signals["quota"][-1]["remaining"] == 0
    assert signals["quota"][-1]["cost"] == 2
    assert signals["quota"][-1]["exhausted"] is False

    provider = VideoProvider()
    task = {
        "params": {"duration": 10},
        "debug": {"signals": signals},
        "result": None,
        "error": None,
    }
    provider._set_result_from_signals(task)

    assert task["error"] is None


def test_extract_video_quota_text_ignores_plain_doubao_progress_packet_json():
    packet = json.dumps(
        [
            {
                "PacketMeta": {"Seq": 0},
                "BlockInfo": {
                    "BlockContent": {
                        "content": {
                            "text_block": {
                                "text": "我将按照您的脚本要求，为您生成一个10秒的9:16竖屏视频。"
                            }
                        }
                    }
                },
            }
        ],
        ensure_ascii=False,
    )

    assert extract_video_quota_text(packet) is None


def test_extract_video_signals_maps_doubao_daily_generation_limit_code():
    signals = extract_video_signals(
        {
            "conversation_id": "38430428492993794",
            "ext": {
                "ai_creation_tool_list": (
                    '[{"task_id":47406311730471426,"tool_name":"ai_creation",'
                    '"status":5,"fail_code":710082020}]'
                ),
                "brief": "正在为您生成符合要求的视频...\n\n今天的生成次数已经达到上限，明天再来免费生成吧～",
            },
            "content_block": [
                {
                    "content": {
                        "text_block": {
                            "text": "今天的生成次数已经达到上限，明天再来免费生成吧～"
                        }
                    }
                }
            ],
        }
    )

    assert signals["conversation_ids"] == ["38430428492993794"]
    assert signals["task_ids"] == ["47406311730471426"]
    assert {
        "code": "710082020",
        "message": (
            "Doubao daily video generation limit reached for this account. "
            "今天的生成次数已经达到上限，明天再来免费生成吧～"
        ),
    } in signals["failures"]
    assert {
        "code": None,
        "message": "今天的生成次数已经达到上限，明天再来免费生成吧～",
    } in signals["failures"]


def test_extract_video_signals_maps_doubao_rejected_video_request_code():
    signals = extract_video_signals(
        {
            "ext": {
                "ai_creation_tool_list": (
                    '[{"task_id":47406311730471427,"tool_name":"ai_creation",'
                    '"status":5,"fail_code":710082041,"fail_msg":"success"}]'
                ),
            },
        }
    )

    expected_message = (
        "Doubao upstream rejected the video request (710082041). "
        "The prompt or reference image may not satisfy video generation requirements, "
        "or the requested duration, ratio, or resolution may not be supported."
    )
    assert {"code": "710082041", "message": expected_message} in signals["failures"]
    assert all(failure.get("message") != "Upstream video generation failed." for failure in signals["failures"])


def test_normalize_prompt_text_decodes_json_wrapped_prompt():
    assert normalize_prompt_text('"生成一个视频"') == "生成一个视频"
    assert normalize_prompt_text('"\\"生成一个视频\\""') == "生成一个视频"
    assert normalize_prompt_text("  plain prompt  ") == "plain prompt"
    assert normalize_prompt_text("") is None


def test_extract_video_signals_ignores_doubao_quota_progress_text():
    progress_message = (
        "本次使用 **Seedance 2.0 全能视频模型**生成，将消耗 2 个视频生成额度，预计等待 1-3分钟。"
        "视频生成好后，我会及时通知你，今日剩余 8 个视频生成额度。"
    )

    signals = extract_video_signals(
        {
            "status": "1",
            "conversation_id": "38430415964389122",
            "message": progress_message,
            "content_block": [
                {
                    "content": {
                        "text_block": {
                            "text": f"这就为您生成视频，请稍等片刻~\n\n{progress_message}"
                        }
                    }
                }
            ],
        }
    )

    assert signals["status"] == "1"
    assert signals["conversation_ids"] == ["38430415964389122"]
    assert signals["failures"] == []


def test_native_quota_progress_text_uses_reported_cost(monkeypatch):
    progress_message = (
        "\u672c\u6b21\u4f7f\u7528 **Seedance 2.0 \u5168\u80fd\u89c6\u9891\u6a21\u578b**"
        "\u751f\u6210\uff0c\u5c06\u6d88\u8017 2 \u4e2a\u89c6\u9891\u751f\u6210\u989d\u5ea6\uff0c"
        "\u9884\u8ba1\u7b49\u5f85 1-3\u5206\u949f\u3002"
        "\u89c6\u9891\u751f\u6210\u597d\u540e\uff0c\u6211\u4f1a\u53ca\u65f6\u901a\u77e5\u4f60\uff0c"
        "\u4eca\u65e5\u5269\u4f59 3 \u4e2a\u89c6\u9891\u751f\u6210\u989d\u5ea6\u3002"
    )
    signals = extract_video_signals({"message": progress_message})

    assert signals["failures"] == []
    assert signals["quota"][-1]["cost"] == 2
    assert signals["quota"][-1]["remaining"] == 3

    provider = VideoProvider()
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 4)
    monkeypatch.setattr(settings, "VIDEO_LONG_FORM_SEGMENT_SECONDS", 10)
    task = {
        "params": {"duration": 10},
        "debug": {"signals": signals},
        "result": None,
        "error": None,
    }
    provider._set_result_from_signals(task)

    assert task["error"] is None


def test_native_quota_progress_text_marks_insufficient_when_reported_cost_is_not_met(monkeypatch):
    progress_message = (
        "\u672c\u6b21\u89c6\u9891\u751f\u6210\u9700\u8981\u6d88\u8017 2 "
        "\u4e2a\u89c6\u9891\u751f\u6210\u989d\u5ea6\uff0c\u4eca\u65e5\u5269\u4f59 1 "
        "\u4e2a\u89c6\u9891\u751f\u6210\u989d\u5ea6\uff0c\u65e0\u6cd5\u751f\u6210\u8be5\u89c6\u9891\u3002"
    )
    signals = extract_video_signals({"message": progress_message})

    provider = VideoProvider()
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 4)
    monkeypatch.setattr(settings, "VIDEO_LONG_FORM_SEGMENT_SECONDS", 10)
    task = {
        "params": {"duration": 10},
        "debug": {"signals": signals},
        "result": None,
        "error": None,
    }
    provider._set_result_from_signals(task)

    assert task["error"]["code"] == "video_quota_insufficient"
    assert task["error"]["remaining"] == 1
    assert task["error"]["required"] == 2


@pytest.mark.asyncio
async def test_doubao_segment_retries_next_account_after_login_expiry(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    provider.playwright_manager = object()
    provider.credential_manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        failure_threshold=10,
        cooldown_seconds=60,
    )
    calls = []

    async def fake_segment(task, request_data, log_task_id, cookie):
        calls.append(cookie)
        if cookie == "cookie-a":
            task["reference_image"] = {
                "file_key": "tos-cn-i-a9rns2rl98/already-uploaded.png",
                "fileName": "reference.png",
                "file_name": "reference.png",
                "kind": "doubao_uploaded",
            }
            raise RuntimeError("doubao_web upstream returned x-tt-agw-login=0; login invalid")
        task["result"] = {
            "url": "https://example.test/video.mp4",
            "upstream_url": "https://example.test/video.mp4",
            "content_type": "video/mp4",
        }
        task["status"] = "succeeded"
        assert request_data["reference_image"]["file_key"] == "tos-cn-i-a9rns2rl98/already-uploaded.png"
        assert request_data["reference_image"]["fileKey"] == "tos-cn-i-a9rns2rl98/already-uploaded.png"
        assert request_data["reference_image"]["localKey"] == "tos-cn-i-a9rns2rl98/already-uploaded.png"
        assert request_data["reference_image"]["kind"] == "doubao_uploaded"
        return task["result"]

    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 0)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "debug": {"events": [], "signals": {"task_ids": [], "video_urls": [], "conversation_ids": [], "failures": [], "status": None}},
        "reference_image": {"bytes": b"fake", "file_name": "reference.png"},
    }

    result = await provider._complete_doubao_web_segment(
        task,
        {"reference_image": {"bytes": b"fake", "file_name": "reference.png"}},
        "vid-test",
    )

    assert calls == ["cookie-a", "cookie-b"]
    assert result["url"] == "https://example.test/video.mp4"
    assert task["status"] == "succeeded"
    assert task["debug"]["credential_retries"][0]["account_index"] == 0
    accounts = provider.credential_manager.snapshot()["accounts"]
    assert accounts[0]["status"] == "login_required"
    assert accounts[0]["disabled_reason"] == "login_expired"
    assert accounts[1]["status"] == "available"


@pytest.mark.asyncio
async def test_doubao_segment_retries_next_account_after_daily_generation_limit(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    provider.playwright_manager = object()
    provider.credential_manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        failure_threshold=10,
        cooldown_seconds=60,
    )
    calls = []

    async def fake_segment(task, request_data, log_task_id, cookie):
        calls.append(cookie)
        if cookie == "cookie-a":
            task["debug"]["signals"]["failures"].append(
                {"code": "710022004", "message": "browser verification"}
            )
            task["error"] = {
                "message": (
                    "Doubao daily video generation limit reached for this account. "
                    "今天的生成次数已经达到上限，明天再来免费生成吧～"
                ),
                "type": "upstream_error",
                "code": "710082020",
            }
            return {}
        assert task["debug"]["signals"]["failures"] == []
        task["result"] = {
            "url": "https://example.test/video.mp4",
            "upstream_url": "https://example.test/video.mp4",
            "content_type": "video/mp4",
        }
        task["status"] = "succeeded"
        return task["result"]

    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 0)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "debug": {"events": [], "signals": {"task_ids": [], "video_urls": [], "conversation_ids": [], "failures": [], "status": None}},
        "reference_image": {"bytes": b"fake", "file_name": "reference.png"},
    }

    result = await provider._complete_doubao_web_segment(
        task,
        {"reference_image": {"bytes": b"fake", "file_name": "reference.png"}},
        "vid-test",
    )

    assert calls == ["cookie-a", "cookie-b"]
    assert result["url"] == "https://example.test/video.mp4"
    assert task["status"] == "succeeded"
    accounts = provider.credential_manager.snapshot()["accounts"]
    assert accounts[0]["status"] == "disabled"
    assert accounts[0]["disabled_reason"] == "quota_exhausted"
    assert accounts[1]["status"] == "available"


@pytest.mark.asyncio
async def test_doubao_segment_retries_next_account_after_browser_verification(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    closed_sessions = []

    class FakePlaywrightManager:
        async def close_account_session(self, cookie):
            closed_sessions.append(cookie)
            return True

    provider.playwright_manager = FakePlaywrightManager()
    provider.credential_manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        failure_threshold=10,
        cooldown_seconds=60,
    )
    calls = []

    async def fake_segment(task, request_data, log_task_id, cookie):
        calls.append(cookie)
        if cookie == "cookie-a":
            task["error"] = {
                "message": (
                    "Doubao requires browser verification for the current session or network "
                    "(rate limited, verify_scene=doubao_message_web)."
                ),
                "type": "upstream_error",
                "code": "710022004",
                "verification": {
                    "verify_scene": "doubao_message_web",
                    "log_id": "20260618033843A8608FB4F7FBED69883F",
                    "from": "shark_admin",
                    "type": "verify",
                },
            }
            return {}
        task["result"] = {
            "url": "https://example.test/video.mp4",
            "upstream_url": "https://example.test/video.mp4",
            "content_type": "video/mp4",
        }
        task["status"] = "succeeded"
        return task["result"]

    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 0)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT", 8)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "debug": {"events": [], "signals": empty_video_signals()},
        "reference_image": None,
    }

    result = await provider._complete_doubao_web_segment(task, {}, "vid-test")

    assert calls == ["cookie-a", "cookie-b"]
    assert result["url"] == "https://example.test/video.mp4"
    assert task["status"] == "succeeded"
    assert task["debug"]["credential_retries"][0]["account_index"] == 0
    assert closed_sessions == ["cookie-b"]
    accounts = provider.credential_manager.snapshot()["accounts"]
    assert accounts[0]["status"] == "verification_required"
    assert accounts[0]["requires_verification"] is True
    assert accounts[0]["verification_context"]["verify_scene"] == "doubao_message_web"
    assert accounts[0]["verification_context"]["log_id"] == "20260618033843A8608FB4F7FBED69883F"


@pytest.mark.asyncio
async def test_doubao_segment_stops_rotation_after_semantic_reasoning_recovery_fails(
    monkeypatch,
    tmp_path,
):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    closed_sessions = []

    class FakePlaywrightManager:
        async def close_account_session(self, cookie):
            closed_sessions.append(cookie)
            return True

    provider.playwright_manager = FakePlaywrightManager()
    provider.credential_manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        failure_threshold=10,
        cooldown_seconds=60,
    )
    calls = []
    recoveries = []

    async def fake_segment(task, request_data, log_task_id, cookie):
        calls.append(cookie)
        if cookie == "cookie-a":
            task["error"] = {
                "message": (
                    "Doubao requires browser verification for the current session or network "
                    "(rate limited, verify_scene=doubao_message_web)."
                ),
                "type": "upstream_error",
                "code": "710022004",
                "verification": {
                    "verify_scene": "doubao_message_web",
                    "log_id": "20260618033843A8608FB4F7FBED69883F",
                    "from": "shark_admin",
                    "type": "verify",
                    "subtype": "semantic_reasoning",
                    "detail": "verify-token-detail",
                },
            }
            return {}
        task["result"] = {
            "url": "https://example.test/video.mp4",
            "upstream_url": "https://example.test/video.mp4",
            "content_type": "video/mp4",
        }
        task["status"] = "succeeded"
        return task["result"]

    async def fake_auto_recover(task, account_index, cookie, error):
        recoveries.append(
            {
                "account_index": account_index,
                "cookie": cookie,
                "subtype": error["verification"]["subtype"],
            }
        )
        return False

    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)
    monkeypatch.setattr(provider, "_auto_recover_credential_verification", fake_auto_recover)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 0)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT", 8)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "debug": {"events": [], "signals": empty_video_signals()},
        "reference_image": None,
    }

    with pytest.raises(RuntimeError, match="browser verification"):
        await provider._complete_doubao_web_segment(task, {}, "vid-test")

    assert calls == ["cookie-a"]
    assert recoveries == [
        {"account_index": 0, "cookie": "cookie-a", "subtype": "semantic_reasoning"}
    ]
    assert closed_sessions == []
    stops = task["debug"]["semantic_reasoning_rotation_stops"]
    assert stops[0]["account_index"] == 0
    assert stops[0]["context"]["subtype"] == "semantic_reasoning"
    assert stops[0]["context"]["verify_scene"] == "doubao_message_web"
    assert stops[0]["context"]["log_id"] == "20260618033843A8608FB4F7FBED69883F"
    accounts = provider.credential_manager.snapshot()["accounts"]
    assert accounts[0]["status"] == "verification_required"
    assert accounts[1]["status"] == "available"


@pytest.mark.asyncio
async def test_doubao_segment_stops_rotation_after_semantic_reasoning_exception_recovery_fails(
    monkeypatch,
    tmp_path,
):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    closed_sessions = []

    class FakePlaywrightManager:
        async def close_account_session(self, cookie):
            closed_sessions.append(cookie)
            return True

    provider.playwright_manager = FakePlaywrightManager()
    provider.credential_manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        failure_threshold=10,
        cooldown_seconds=60,
    )
    calls = []
    recoveries = []

    async def fake_segment(task, request_data, log_task_id, cookie):
        calls.append(cookie)
        if cookie == "cookie-a":
            exc = RuntimeError(
                "Doubao requires browser verification for the current session or network "
                "(rate limited, verify_scene=doubao_message_web)."
            )
            exc.verification_context = {
                "verify_scene": "doubao_message_web",
                "log_id": "20260618033843A8608FB4F7FBED69883F",
                "from": "shark_admin",
                "type": "verify",
                "subtype": "semantic_reasoning",
                "detail": "verify-token-detail",
            }
            raise exc
        task["result"] = {
            "url": "https://example.test/video.mp4",
            "upstream_url": "https://example.test/video.mp4",
            "content_type": "video/mp4",
        }
        task["status"] = "succeeded"
        return task["result"]

    async def fake_auto_recover(task, account_index, cookie, error):
        recoveries.append(
            {
                "account_index": account_index,
                "cookie": cookie,
                "subtype": error.verification_context["subtype"],
            }
        )
        return False

    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)
    monkeypatch.setattr(provider, "_auto_recover_credential_verification", fake_auto_recover)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 0)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT", 8)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "debug": {"events": [], "signals": empty_video_signals()},
        "reference_image": None,
    }

    with pytest.raises(RuntimeError, match="browser verification"):
        await provider._complete_doubao_web_segment(task, {}, "vid-test")

    assert calls == ["cookie-a"]
    assert recoveries == [
        {"account_index": 0, "cookie": "cookie-a", "subtype": "semantic_reasoning"}
    ]
    assert closed_sessions == []
    stops = task["debug"]["semantic_reasoning_rotation_stops"]
    assert stops[0]["account_index"] == 0
    assert stops[0]["context"]["subtype"] == "semantic_reasoning"
    accounts = provider.credential_manager.snapshot()["accounts"]
    assert accounts[0]["status"] == "verification_required"
    assert accounts[1]["status"] == "available"


@pytest.mark.asyncio
async def test_doubao_segment_auto_verifies_and_retries_same_account(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    provider.credential_manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        failure_threshold=10,
        cooldown_seconds=60,
    )
    closed_sessions = []
    registered = []

    class FakePlaywrightManager:
        _initialized = True

        async def close_account_session(self, cookie):
            closed_sessions.append(cookie)
            return True

        async def register_account(self, cookie):
            registered.append(cookie)
            return {"profile_id": "profile-a", "created": False}

    class FakeManualVerificationManager:
        async def start(self, account_index, cookie, **kwargs):
            assert account_index == 0
            assert cookie == "cookie-a"
            assert kwargs["verification_context"]["detail"] == "verify-token-detail"
            return {"object": "manual_verification", "status": "active"}

        async def auto_verify(self, account_index, verification_context=None, **kwargs):
            assert account_index == 0
            assert verification_context["detail"] == "verify-token-detail"
            assert kwargs["solve"] is True
            return {
                "object": "manual_verification",
                "status": "active",
                "manual_success_detected": True,
                "message": "Manual Doubao video generation success observed in headless snapshot.",
            }

        async def complete(self, account_index):
            assert account_index == 0
            return {
                "object": "manual_verification",
                "status": "completed",
                "cookie_header": "cookie-a-new; uid_tt=1",
            }

    provider.playwright_manager = FakePlaywrightManager()
    provider.manual_verification_manager = FakeManualVerificationManager()
    calls = []

    async def fake_segment(task, request_data, log_task_id, cookie):
        calls.append(cookie)
        if len(calls) == 1:
            task["error"] = {
                "message": (
                    "Doubao requires browser verification for the current session or network "
                    "(rate limited, verify_scene=doubao_message_web)."
                ),
                "type": "upstream_error",
                "code": "710022004",
                "verification": {
                    "verify_scene": "doubao_message_web",
                    "detail": "verify-token-detail",
                },
            }
            return {}
        task["result"] = {
            "url": "https://example.test/video.mp4",
            "upstream_url": "https://example.test/video.mp4",
            "content_type": "video/mp4",
        }
        task["status"] = "succeeded"
        return task["result"]

    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)
    monkeypatch.setattr(settings, "DOUBAO_CAPTCHA_AUTO_SOLVE", True)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 0)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT", 8)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "debug": {"events": [], "signals": empty_video_signals()},
        "reference_image": None,
    }

    result = await provider._complete_doubao_web_segment(task, {}, "vid-test")

    assert calls == ["cookie-a", "cookie-a-new; uid_tt=1"]
    assert registered == ["cookie-a-new; uid_tt=1"]
    assert result["url"] == "https://example.test/video.mp4"
    assert task["status"] == "succeeded"
    assert task["debug"]["verification_auto_recoveries"][0]["status"] == "recovered"
    assert closed_sessions == ["cookie-a-new; uid_tt=1"]
    accounts = provider.credential_manager.snapshot()["accounts"]
    assert accounts[0]["status"] == "available"
    assert accounts[0]["requires_verification"] is False


@pytest.mark.asyncio
async def test_doubao_segment_resumes_frontend_verification_conversation_without_resubmit(
    monkeypatch,
    tmp_path,
):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    provider.credential_manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        failure_threshold=10,
        cooldown_seconds=60,
    )
    closed_sessions = []

    class FakePlaywrightManager:
        _initialized = True

        async def close_account_session(self, cookie):
            closed_sessions.append(cookie)
            return True

        async def register_account(self, cookie):
            return {"profile_id": "profile-a", "created": False}

    class FakeManualVerificationManager:
        async def start(self, account_index, cookie, **kwargs):
            return {"object": "manual_verification", "status": "active"}

        async def auto_verify(self, account_index, verification_context=None, **kwargs):
            return {
                "object": "manual_verification",
                "status": "active",
                "url": "https://www.doubao.com/chat/38431912429684226",
                "manual_success_detected": True,
                "auto_solve_result": {
                    "steps": [{"name": "frontend_video_trigger"}],
                },
            }

        async def complete(self, account_index):
            return {
                "object": "manual_verification",
                "status": "completed",
                "url": "https://www.doubao.com/chat/38431912429684226",
                "manual_success_detected": True,
                "auto_solve_result": {
                    "steps": [{"name": "frontend_video_trigger"}],
                },
                "cookie_header": "cookie-a-new; uid_tt=1",
            }

    provider.playwright_manager = FakePlaywrightManager()
    provider.manual_verification_manager = FakeManualVerificationManager()
    submit_calls = []
    poll_calls = []

    async def fake_segment(task, request_data, log_task_id, cookie):
        submit_calls.append(cookie)
        task["error"] = {
            "message": (
                "Doubao requires browser verification for the current session or network "
                "(rate limited, verify_scene=doubao_message_web)."
            ),
            "type": "upstream_error",
            "code": "710022004",
            "verification": {
                "verify_scene": "doubao_message_web",
                "detail": "verify-token-detail",
            },
        }
        return {}

    async def fake_poll(task, cookie, conversation_id, request_data=None):
        poll_calls.append((cookie, conversation_id))
        task["result"] = {
            "url": "https://example.test/video.mp4",
            "upstream_url": "https://example.test/video.mp4",
            "content_type": "video/mp4",
        }

    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)
    monkeypatch.setattr(provider, "_poll_doubao_chain", fake_poll)
    monkeypatch.setattr(settings, "DOUBAO_CAPTCHA_AUTO_SOLVE", True)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 0)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT", 8)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "debug": {"events": [], "signals": empty_video_signals()},
        "reference_image": None,
    }

    result = await provider._complete_doubao_web_segment(task, {}, "vid-test")

    assert submit_calls == ["cookie-a"]
    assert poll_calls == [("cookie-a-new; uid_tt=1", "38431912429684226")]
    assert result["url"] == "https://example.test/video.mp4"
    assert task["status"] == "succeeded"
    recovery = task["debug"]["verification_auto_recoveries"][0]
    assert recovery["status"] == "recovered"
    assert recovery["conversation_id"] == "38431912429684226"
    assert closed_sessions == ["cookie-a-new; uid_tt=1"]


@pytest.mark.asyncio
async def test_doubao_segment_detaches_frontend_and_polls_after_acceptance(
    monkeypatch,
    tmp_path,
):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    provider.credential_manager = CredentialManager(["cookie-a"], failure_threshold=10)

    class FakePlaywrightManager:
        _initialized = True

        async def close_account_session(self, cookie):
            return True

        async def register_account(self, cookie):
            return {"profile_id": "profile-a", "created": False}

    class FakeManualVerificationManager:
        def __init__(self):
            self.completed = []

        async def start(self, account_index, cookie, **kwargs):
            return {"object": "manual_verification", "status": "active"}

        async def auto_verify(self, account_index, verification_context=None, **kwargs):
            return {
                "object": "manual_verification",
                "status": "active",
                "url": "https://www.doubao.com/chat/38431912429684226",
                "manual_success_detected": True,
                "auto_solve_result": {
                    "steps": [{"name": "frontend_video_trigger"}],
                },
            }

        async def enter_light_video_wait(self, account_index, *, snapshot_interval_seconds=30):
            raise AssertionError("detached polling must not keep the manual browser page alive")

        async def wait_for_video_result(self, account_index, *, timeout_seconds=300):
            raise AssertionError("detached polling must not wait on the manual browser page")

        async def complete(self, account_index):
            self.completed.append(account_index)
            return {
                "object": "manual_verification",
                "status": "completed",
                "url": "https://www.doubao.com/chat/38431912429684226",
                "cookie_header": "cookie-a-new; uid_tt=1",
            }

    provider.playwright_manager = FakePlaywrightManager()
    fake_manual = FakeManualVerificationManager()
    provider.manual_verification_manager = fake_manual

    async def fake_segment(task, request_data, log_task_id, cookie):
        task["error"] = {
            "message": (
                "Doubao requires browser verification for the current session or network "
                "(rate limited, verify_scene=doubao_message_web)."
            ),
            "type": "upstream_error",
            "code": "710022004",
            "verification": {
                "verify_scene": "doubao_message_web",
                "detail": "verify-token-detail",
            },
        }
        return {}

    poll_calls = []

    async def fake_poll(task, cookie, conversation_id, request_data=None):
        poll_calls.append((cookie, conversation_id))
        task["result"] = {
            "url": "https://example.test/generated.mp4",
            "upstream_url": "https://example.test/generated.mp4",
            "content_type": "video/mp4",
        }

    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)
    monkeypatch.setattr(provider, "_poll_doubao_chain", fake_poll)
    monkeypatch.setattr(settings, "DOUBAO_CAPTCHA_AUTO_SOLVE", True)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 0)
    monkeypatch.setattr(settings, "DOUBAO_VERIFICATION_LIGHT_WAIT_SNAPSHOT_INTERVAL_SECONDS", 45)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "debug": {"events": [], "signals": empty_video_signals()},
        "reference_image": None,
    }

    result = await provider._complete_doubao_web_segment(task, {}, "vid-test")

    assert result["url"] == "https://example.test/generated.mp4"
    assert fake_manual.completed == [0]
    assert poll_calls == [("cookie-a-new; uid_tt=1", "38431912429684226")]
    recovery = task["debug"]["verification_auto_recoveries"][0]
    assert recovery["detached_result_polling"] is True
    assert recovery["conversation_id"] == "38431912429684226"


@pytest.mark.asyncio
async def test_frontend_submit_and_result_wait_use_independent_semaphores(monkeypatch):
    provider = VideoProvider()

    class FakeCredentialManager:
        async def update_account_cookie(self, account_index, cookie):
            return None

        async def clear_cooldown(self, account_index):
            return None

        async def reset_health(self, account_index):
            return {"status": "available"}

    class FakePlaywrightManager:
        _initialized = True

        async def register_account(self, cookie):
            return {"created": False}

    class FakeManualVerificationManager:
        def __init__(self):
            self.submit_active = 0
            self.submit_peak = 0

        async def start(self, account_index, cookie, **kwargs):
            return {"status": "active"}

        async def auto_verify(self, account_index, verification_context=None, **kwargs):
            self.submit_active += 1
            self.submit_peak = max(self.submit_peak, self.submit_active)
            await asyncio.sleep(0.01)
            self.submit_active -= 1
            return {
                "status": "active",
                "url": f"https://www.doubao.com/chat/{38431912429684220 + account_index}",
                "manual_success_detected": True,
                "auto_solve_result": {"steps": [{"name": "frontend_video_trigger"}]},
            }

        async def complete(self, account_index):
            return {"status": "completed", "cookie_header": f"cookie-{account_index}-new"}

    provider.credential_manager = FakeCredentialManager()
    provider.playwright_manager = FakePlaywrightManager()
    fake_manual = FakeManualVerificationManager()
    provider.manual_verification_manager = fake_manual
    monkeypatch.setattr(settings, "DOUBAO_CAPTCHA_AUTO_SOLVE", True)
    monkeypatch.setattr(settings, "DOUBAO_FRONTEND_SUBMIT_CONCURRENCY", 1)
    monkeypatch.setattr(settings, "DOUBAO_FRONTEND_RESULT_WAIT_CONCURRENCY", 2)

    error = {
        "message": "Doubao requires browser verification for the current session or network.",
        "code": "710022004",
        "verification": {"verify_scene": "doubao_message_web"},
    }
    tasks = [
        {
            "id": f"vid-{index}",
            "prompt": "test",
            "reference_image": None,
            "debug": {},
        }
        for index in range(3)
    ]
    recovered = await asyncio.gather(
        *(
            provider._auto_recover_credential_verification(task, index, f"cookie-{index}", error)
            for index, task in enumerate(tasks)
        )
    )

    assert recovered == [True, True, True]
    assert fake_manual.submit_peak == 1

    wait_active = 0
    wait_peak = 0

    async def fake_poll_unlimited(task, cookie, conversation_id, request_data=None):
        nonlocal wait_active, wait_peak
        wait_active += 1
        wait_peak = max(wait_peak, wait_active)
        await asyncio.sleep(0.1)
        wait_active -= 1

    monkeypatch.setattr(provider, "_poll_doubao_chain_unlimited", fake_poll_unlimited)
    await asyncio.gather(
        *(
            provider._poll_doubao_chain(
                task,
                f"cookie-{index}-new",
                str(38431912429684220 + index),
            )
            for index, task in enumerate(tasks)
        )
    )

    assert wait_peak == 2
    status = provider.frontend_queue_status()
    assert status["verification_submit"]["limit"] == 1
    assert status["verification_submit"]["peak_active"] == 1
    assert status["result_wait"]["limit"] == 2
    assert status["result_wait"]["peak_active"] == 2
    assert status["verification_submit"]["active"] == status["verification_submit"]["waiting"] == 0
    assert status["result_wait"]["active"] == status["result_wait"]["waiting"] == 0
    assert max(
        task["debug"]["verification_auto_recoveries"][0]["frontend_verification_submit_slot"]["queue_wait_seconds"]
        for task in tasks
    ) > 0
    assert max(
        task["debug"]["frontend_queues"]["frontend_result_wait_slot"]["queue_wait_seconds"]
        for task in tasks
    ) > 0


@pytest.mark.asyncio
async def test_normal_submit_releases_slot_before_result_wait(monkeypatch):
    provider = VideoProvider()
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_SUBMIT_CONCURRENCY", 2)
    monkeypatch.setattr(settings, "DOUBAO_FRONTEND_RESULT_WAIT_CONCURRENCY", 3)
    wait_active = 0
    wait_peak = 0

    async def fake_poll_unlimited(task, cookie, conversation_id, request_data=None):
        nonlocal wait_active, wait_peak
        wait_active += 1
        wait_peak = max(wait_peak, wait_active)
        assert provider.frontend_queue_status()["video_submit"]["active"] <= 2
        await asyncio.sleep(0.1)
        wait_active -= 1

    async def fake_submit(task, request_data, log_task_id, cookie):
        await asyncio.sleep(0.01)
        await provider._poll_doubao_chain(task, cookie, f"conversation-{task['id']}")
        return {}

    monkeypatch.setattr(provider, "_poll_doubao_chain_unlimited", fake_poll_unlimited)
    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_submit)
    tasks = [
        {"id": f"vid-{index}", "credential_index": index, "debug": {}}
        for index in range(5)
    ]
    await asyncio.gather(
        *(
            provider._complete_doubao_web_segment_with_submit_slot(
                task,
                {},
                task["id"],
                f"cookie-{index}",
            )
            for index, task in enumerate(tasks)
        )
    )

    status = provider.frontend_queue_status()
    assert status["video_submit"]["peak_active"] == 2
    assert status["result_wait"]["peak_active"] == 3
    assert wait_peak == 3
    assert status["video_submit"]["active"] == status["video_submit"]["waiting"] == 0
    assert status["result_wait"]["active"] == status["result_wait"]["waiting"] == 0


@pytest.mark.asyncio
async def test_verification_recovery_uses_captured_frontend_video_without_chain_poll(
    monkeypatch,
    tmp_path,
):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    poll_calls = []

    async def fake_poll(*args, **kwargs):
        poll_calls.append((args, kwargs))

    monkeypatch.setattr(provider, "_poll_doubao_chain", fake_poll)

    task = {
        "id": "vid-test",
        "status": "failed",
        "error": {"message": "verification required"},
        "result": None,
        "debug": {
            "events": [],
            "signals": empty_video_signals(),
            "verification_auto_recoveries": [
                {
                    "account_index": 0,
                    "status": "recovered",
                    "conversation_id": "38431912429684226",
                    "frontend_video_signals": {
                        **empty_video_signals(),
                        "video_ids": ["v0369cg10004example"],
                        "video_urls": ["https://example.test/generated.mp4"],
                    },
                }
            ],
        },
        "params": {"watermark": False},
    }

    result = await provider._continue_after_verification_recovery(
        task,
        {},
        "vid-test",
        0,
        "cookie-a",
        1,
    )

    assert poll_calls == []
    assert result["url"] == "https://example.test/generated.mp4"
    assert task["status"] == "succeeded"
    assert task["error"] is None


@pytest.mark.asyncio
async def test_doubao_segment_auto_verifies_exception_and_retries_same_account(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    provider.credential_manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        failure_threshold=10,
        cooldown_seconds=60,
    )
    closed_sessions = []
    registered = []

    class FakePlaywrightManager:
        _initialized = True

        async def close_account_session(self, cookie):
            closed_sessions.append(cookie)
            return True

        async def register_account(self, cookie):
            registered.append(cookie)
            return {"profile_id": "profile-a", "created": False}

    class FakeManualVerificationManager:
        async def start(self, account_index, cookie, **kwargs):
            assert account_index == 0
            assert cookie == "cookie-a"
            assert kwargs["verification_context"]["detail"] == "verify-token-detail"
            return {"object": "manual_verification", "status": "active"}

        async def auto_verify(self, account_index, verification_context=None, **kwargs):
            assert account_index == 0
            assert verification_context["detail"] == "verify-token-detail"
            assert kwargs["solve"] is True
            return {
                "object": "manual_verification",
                "status": "active",
                "manual_success_detected": True,
                "message": "Manual Doubao video generation success observed in headless snapshot.",
            }

        async def complete(self, account_index):
            assert account_index == 0
            return {
                "object": "manual_verification",
                "status": "completed",
                "cookie_header": "cookie-a-new; uid_tt=1",
            }

    provider.playwright_manager = FakePlaywrightManager()
    provider.manual_verification_manager = FakeManualVerificationManager()
    calls = []

    async def fake_segment(task, request_data, log_task_id, cookie):
        calls.append(cookie)
        if len(calls) == 1:
            exc = RuntimeError(
                "Doubao requires browser verification for the current session or network "
                "(rate limited, verify_scene=doubao_message_web)."
            )
            exc.verification_context = {
                "verify_scene": "doubao_message_web",
                "detail": "verify-token-detail",
            }
            raise exc
        task["result"] = {
            "url": "https://example.test/video.mp4",
            "upstream_url": "https://example.test/video.mp4",
            "content_type": "video/mp4",
        }
        task["status"] = "succeeded"
        return task["result"]

    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)
    monkeypatch.setattr(settings, "DOUBAO_CAPTCHA_AUTO_SOLVE", True)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 0)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT", 8)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "debug": {"events": [], "signals": empty_video_signals()},
        "reference_image": None,
    }

    result = await provider._complete_doubao_web_segment(task, {}, "vid-test")

    assert calls == ["cookie-a", "cookie-a-new; uid_tt=1"]
    assert registered == ["cookie-a-new; uid_tt=1"]
    assert result["url"] == "https://example.test/video.mp4"
    assert task["status"] == "succeeded"
    assert task["debug"]["verification_auto_recoveries"][0]["status"] == "recovered"
    assert closed_sessions == ["cookie-a-new; uid_tt=1"]
    accounts = provider.credential_manager.snapshot()["accounts"]
    assert accounts[0]["status"] == "available"
    assert accounts[0]["requires_verification"] is False


@pytest.mark.asyncio
async def test_doubao_segment_stops_after_browser_verification_retry_limit(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    closed_sessions = []

    class FakePlaywrightManager:
        async def close_account_session(self, cookie):
            closed_sessions.append(cookie)
            return True

    provider.playwright_manager = FakePlaywrightManager()
    provider.credential_manager = CredentialManager(
        ["cookie-a", "cookie-b", "cookie-c", "cookie-d"],
        failure_threshold=10,
        cooldown_seconds=60,
    )
    calls = []

    async def fake_segment(task, request_data, log_task_id, cookie):
        calls.append(cookie)
        task["error"] = {
            "message": (
                "Doubao requires browser verification for the current session or network "
                "(rate limited, verify_scene=doubao_message_web)."
            ),
            "type": "upstream_error",
            "code": "710022004",
        }
        return {}

    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 0)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT", 8)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_VERIFICATION_RETRY_LIMIT", 2)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "debug": {"events": [], "signals": empty_video_signals()},
        "reference_image": None,
    }

    with pytest.raises(RuntimeError, match="browser verification"):
        await provider._complete_doubao_web_segment(task, {}, "vid-test")

    assert calls == ["cookie-a", "cookie-b"]
    assert len(task["debug"]["credential_retries"]) == 2
    assert closed_sessions == []


@pytest.mark.asyncio
async def test_doubao_segment_prefers_quota_error_after_mixed_account_failures(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    provider.playwright_manager = object()
    provider.credential_manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        failure_threshold=10,
        cooldown_seconds=60,
    )
    await provider.credential_manager.update_quota(
        0,
        remaining=2,
        unit="video credits",
        source="video_history",
        status="available",
    )
    await provider.credential_manager.update_quota(
        1,
        remaining=2,
        unit="video credits",
        source="video_history",
        status="available",
    )

    async def fake_segment(task, request_data, log_task_id, cookie):
        if cookie == "cookie-a":
            task["error"] = {
                "message": "Doubao requires browser verification (verify_scene=doubao_message_web).",
                "type": "upstream_error",
                "code": "710022004",
            }
            return {}

        await provider.credential_manager.disable_for_quota_exhausted(
            1,
            "Doubao daily video generation limit reached.",
            source="video_signal",
        )
        task["error"] = {
            "message": "Doubao daily video generation limit reached.",
            "type": "video_quota_insufficient",
            "code": "video_quota_insufficient",
            "remaining": 0,
            "required": 1,
        }
        return {}

    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 1)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT", 2)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "params": {"duration": 10},
        "debug": {"events": [], "signals": empty_video_signals()},
        "reference_image": None,
    }

    with pytest.raises(VideoQuotaInsufficientError):
        await provider._complete_doubao_web_segment(task, {}, "vid-test")

    provider._fail_task(
        task,
        VideoQuotaInsufficientError("quota exhausted", remaining=0, required=1),
        "test",
    )
    assert task["error"]["code"] == "video_quota_insufficient"
    assert task["error"]["remaining"] == 0


@pytest.mark.asyncio
async def test_doubao_segment_refreshes_unknown_quota_before_retrying_generation(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    provider.playwright_manager = object()
    provider.credential_manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        failure_threshold=10,
        cooldown_seconds=60,
    )
    await provider.credential_manager.update_quota(
        0,
        remaining=2,
        unit="video credits",
        source="video_history",
        status="available",
    )
    calls = []
    refresh_calls = []

    async def fake_segment(task, request_data, log_task_id, cookie):
        calls.append(cookie)
        if cookie == "cookie-a":
            await provider.credential_manager.disable_for_quota_exhausted(
                0,
                "今天的生成次数已经达到上限，明天再来免费生成吧～",
                source="video_signal",
            )
            task["error"] = {
                "message": "今天的生成次数已经达到上限，明天再来免费生成吧～",
                "type": "video_quota_insufficient",
                "code": "video_quota_insufficient",
                "remaining": 0,
                "required": 2,
            }
            return {}

        task["error"] = None
        task["result"] = {
            "url": "https://example.test/video.mp4",
            "upstream_url": "https://example.test/video.mp4",
            "content_type": "video/mp4",
        }
        task["status"] = "succeeded"
        return task["result"]

    async def fake_refresh(indexes=None):
        batch = list(indexes) if indexes is not None else []
        refresh_calls.append(batch)
        assert batch == [1]
        await provider.credential_manager.update_quota(
            1,
            remaining=4,
            unit="video credits",
            source="video_history",
            status="available",
        )
        return {"checked_count": 1, "available_count": 1, "exhausted_count": 0, "unknown_count": 0, "results": []}

    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)
    monkeypatch.setattr(provider, "refresh_video_quotas", fake_refresh)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 2)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT", 2)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "params": {"duration": 10},
        "debug": {
            "events": [],
            "signals": empty_video_signals(),
            "quota_preflight": {
                "eligible": True,
                "eligible_count": 1,
                "provisional": False,
            },
        },
        "reference_image": None,
    }

    result = await provider._complete_doubao_web_segment(task, {}, "vid-test")

    assert calls == ["cookie-a", "cookie-b"]
    assert refresh_calls == [[1]]
    assert result["url"] == "https://example.test/video.mp4"
    accounts = provider.credential_manager.snapshot()["accounts"]
    assert accounts[0]["disabled_reason"] == "quota_exhausted"
    assert accounts[1]["quota"]["status"] == "estimated"
    assert accounts[1]["quota"]["remaining"] == 2


@pytest.mark.asyncio
async def test_doubao_segment_does_not_submit_generation_to_unconfirmed_quota_account(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    provider.playwright_manager = object()
    provider.credential_manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        failure_threshold=10,
        cooldown_seconds=60,
    )
    await provider.credential_manager.update_quota(
        0,
        remaining=2,
        unit="video credits",
        source="video_history",
        status="available",
    )
    calls = []
    refresh_calls = []

    async def fake_segment(task, request_data, log_task_id, cookie):
        calls.append(cookie)
        await provider.credential_manager.disable_for_quota_exhausted(
            0,
            "今天的生成次数已经达到上限，明天再来免费生成吧～",
            source="video_signal",
        )
        task["error"] = {
            "message": "今天的生成次数已经达到上限，明天再来免费生成吧～",
            "type": "video_quota_insufficient",
            "code": "video_quota_insufficient",
            "remaining": 0,
            "required": 2,
        }
        return {}

    async def fake_refresh(indexes=None):
        batch = list(indexes) if indexes is not None else []
        refresh_calls.append(batch)
        await provider.credential_manager.mark_quota_error(
            batch[0],
            "No current-day video quota signal was found in Doubao conversation history.",
            source="video_history",
        )
        return {"checked_count": 1, "available_count": 0, "exhausted_count": 0, "unknown_count": 1, "results": []}

    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)
    monkeypatch.setattr(provider, "refresh_video_quotas", fake_refresh)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 2)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT", 2)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "params": {"duration": 10},
        "debug": {"events": [], "signals": empty_video_signals()},
        "reference_image": None,
    }

    with pytest.raises(VideoQuotaInsufficientError):
        await provider._complete_doubao_web_segment(task, {}, "vid-test")

    assert calls == ["cookie-a"]
    assert refresh_calls == [[1]]


@pytest.mark.asyncio
async def test_doubao_segment_retries_account_with_enough_video_quota(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    provider.playwright_manager = object()
    provider.credential_manager = CredentialManager(
        ["cookie-a", "cookie-b"],
        failure_threshold=10,
        cooldown_seconds=60,
    )
    await provider.credential_manager.update_quota(0, remaining=2, unit="video credits", source="video_signal")
    await provider.credential_manager.update_quota(1, remaining=5, unit="video credits", source="video_signal")
    calls = []

    async def fake_segment(task, request_data, log_task_id, cookie):
        calls.append(cookie)
        task["result"] = {
            "url": "https://example.test/video.mp4",
            "upstream_url": "https://example.test/video.mp4",
            "content_type": "video/mp4",
        }
        task["status"] = "succeeded"
        return task["result"]

    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 1)
    monkeypatch.setattr(settings, "VIDEO_LONG_FORM_SEGMENT_SECONDS", 10)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "params": {"duration": 30},
        "debug": {"events": [], "signals": {"task_ids": [], "video_urls": [], "conversation_ids": [], "failures": [], "non_video_results": [], "quota": [], "status": None}},
        "reference_image": {"bytes": b"fake", "file_name": "reference.png"},
    }

    result = await provider._complete_doubao_web_segment(
        task,
        {"reference_image": {"bytes": b"fake", "file_name": "reference.png"}},
        "vid-test",
    )

    assert calls == ["cookie-b"]
    assert result["url"] == "https://example.test/video.mp4"
    accounts = provider.credential_manager.snapshot()["accounts"]
    assert accounts[0]["status"] == "available"
    assert accounts[0]["quota"]["remaining"] == 2
    assert accounts[1]["quota"]["remaining"] == 2


@pytest.mark.asyncio
async def test_video_quota_signal_updates_and_recovers_account(tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.credential_manager = CredentialManager(["cookie-a"], failure_threshold=10)
    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "params": {"duration": 10},
        "credential_index": 0,
        "debug": {"events": [], "signals": {"task_ids": [], "video_urls": [], "conversation_ids": [], "failures": [], "non_video_results": [], "quota": [], "status": None}},
    }

    zero_quota = extract_video_signals(
        {
            "message": (
                "\u672c\u6b21\u4f7f\u7528 Seedance 2.0 \u5168\u80fd\u89c6\u9891\u6a21\u578b"
                "\u751f\u6210\uff0c\u5c06\u6d88\u8017 2 \u4e2a\u89c6\u9891\u751f\u6210\u989d\u5ea6\uff0c"
                "\u4eca\u65e5\u5269\u4f59 0 \u4e2a\u89c6\u9891\u751f\u6210\u989d\u5ea6\u3002"
            )
        }
    )
    provider._merge_signals(task, zero_quota)
    await provider._sync_video_quota_from_task(task)
    account = provider.credential_manager.snapshot()["accounts"][0]
    assert account["status"] == "quota_exhausted"
    assert account["disabled_reason"] is None
    assert account["quota"]["remaining"] == 0

    task["debug"]["signals"]["quota"] = []
    positive_quota = extract_video_signals(
        {
            "message": (
                "\u672c\u6b21\u4f7f\u7528 Seedance 2.0 \u5168\u80fd\u89c6\u9891\u6a21\u578b"
                "\u751f\u6210\uff0c\u5c06\u6d88\u8017 2 \u4e2a\u89c6\u9891\u751f\u6210\u989d\u5ea6\uff0c"
                "\u4eca\u65e5\u5269\u4f59 3 \u4e2a\u89c6\u9891\u751f\u6210\u989d\u5ea6\u3002"
            )
        }
    )
    provider._merge_signals(task, positive_quota)
    await provider._sync_video_quota_from_task(task)
    account = provider.credential_manager.snapshot()["accounts"][0]
    assert account["status"] == "available"
    assert account["disabled_reason"] is None
    assert account["quota"]["remaining"] == 3


@pytest.mark.asyncio
async def test_video_quota_refresh_reads_today_history_without_submitting_video(monkeypatch):
    provider = VideoProvider()
    provider.credential_manager = CredentialManager(["cookie-a"], failure_threshold=10)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_REFRESH_TIMEOUT_SECONDS", 12)
    calls = []
    timeouts = []
    today = int(time.time())

    class FakePlaywrightManager:
        browser_headers = {}

        async def post_json(self, url, cookie, params, payload, headers=None, timeout_seconds=None):
            calls.append(url)
            timeouts.append(timeout_seconds)
            if url.endswith("/im/chain/recent_conv"):
                body = {
                    "downlink_body": {
                        "pull_recent_conv_chain_downlink_body": {
                            "cells": [
                                {
                                    "conversation": {
                                        "conversation_id": "conv-video",
                                        "name": "生成服装展示视频",
                                        "update_time": str(today),
                                    }
                                }
                            ]
                        }
                    }
                }
            else:
                body = {
                    "message": (
                        "本次使用 Seedance 2.0 全能视频模型生成，将消耗 4 个视频生成额度，"
                        "今日剩余 6 个视频生成额度。"
                    )
                }
            return {"status_code": 200, "text": json.dumps(body, ensure_ascii=False), "headers": {}}

        async def close_account_session(self, cookie):
            calls.append(f"close:{cookie}")
            return True

    provider.playwright_manager = FakePlaywrightManager()
    result = await provider.refresh_account_video_quota(0)

    assert result["found"] is True
    assert calls == [
        "https://www.doubao.com/im/chain/recent_conv",
        "https://www.doubao.com/im/chain/single",
        "close:cookie-a",
    ]
    assert timeouts == [12, 12]
    account = provider.credential_manager.snapshot()["accounts"][0]
    assert account["quota"]["remaining"] == 6
    assert account["quota"]["source"] == "video_history"
    assert account["quota"]["video_eligible"] is True


@pytest.mark.asyncio
async def test_doubao_chain_polling_times_out_without_video_url(monkeypatch):
    provider = VideoProvider()
    provider.client = object()
    sleeps = []

    class FakePlaywrightManager:
        async def post_json(self, url, cookie, params, payload, headers=None, timeout_seconds=None):
            return {"status_code": 200, "text": json.dumps({"message": "still processing"}), "headers": {}}

        def update_ms_token(self, token, cookie):
            raise AssertionError("unexpected token update")

    async def fake_sleep(delay):
        sleeps.append(delay)

    provider.playwright_manager = FakePlaywrightManager()
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_TRANSPORT", "browser")
    monkeypatch.setattr("app.providers.video_provider.asyncio.sleep", fake_sleep)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "debug": {"events": [], "signals": empty_video_signals()},
    }

    await provider._poll_doubao_chain(
        task,
        "cookie-a",
        "conversation-a",
        {"poll_interval": 1, "poll_timeout": 1},
    )

    assert task["status"] == "failed"
    assert task["error"]["code"] == "video_poll_timeout"
    assert sleeps == [1]


@pytest.mark.asyncio
async def test_video_quota_refresh_preserves_pending_usage_when_history_has_no_balance(monkeypatch):
    provider = VideoProvider()
    provider.credential_manager = CredentialManager(["cookie-a"], failure_threshold=10)
    await provider.credential_manager.record_quota_usage_without_balance(0, 2, reason="video")

    class FakePlaywrightManager:
        browser_headers = {}

        async def post_json(self, url, cookie, params, payload, headers=None, timeout_seconds=None):
            if url.endswith("/im/chain/recent_conv"):
                body = {
                    "downlink_body": {
                        "pull_recent_conv_chain_downlink_body": {
                            "cells": [],
                        }
                    }
                }
            else:
                raise AssertionError("conversation detail should not be requested")
            return {"status_code": 200, "text": json.dumps(body), "headers": {}}

        async def close_account_session(self, cookie):
            return True

    provider.playwright_manager = FakePlaywrightManager()

    result = await provider.refresh_account_video_quota(0)

    assert result["found"] is False
    quota = provider.credential_manager.snapshot()["accounts"][0]["quota"]
    assert quota["status"] == "pending_refresh"
    assert quota["used"] == 2


@pytest.mark.asyncio
async def test_refresh_stale_video_quotas_targets_unknown_and_pending_accounts(monkeypatch):
    provider = VideoProvider()
    provider.credential_manager = CredentialManager(["cookie-a", "cookie-b", "cookie-c"], failure_threshold=10)
    await provider.credential_manager.update_quota(
        0,
        remaining=4,
        unit="video credits",
        source="video_history",
        status="available",
    )
    await provider.credential_manager.record_quota_usage_without_balance(2, 2, reason="video")
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_MAX_AGE_SECONDS", 9999)
    calls = []

    async def fake_refresh(indexes=None):
        batch = list(indexes) if indexes is not None else []
        calls.append(batch)
        return {
            "checked_count": len(batch),
            "available_count": 0,
            "exhausted_count": 0,
            "unknown_count": len(batch),
            "results": [],
        }

    monkeypatch.setattr(provider, "refresh_video_quotas", fake_refresh)

    result = await provider.refresh_stale_video_quotas()

    assert calls == [[1, 2]]
    assert result["checked_count"] == 2


@pytest.mark.asyncio
async def test_refresh_stale_video_quotas_rotates_limited_background_batches(monkeypatch):
    provider = VideoProvider()
    provider.credential_manager = CredentialManager(
        ["cookie-a", "cookie-b", "cookie-c", "cookie-d"],
        failure_threshold=10,
    )
    calls = []

    async def fake_refresh(indexes=None):
        batch = list(indexes) if indexes is not None else []
        calls.append(batch)
        return {
            "checked_count": len(batch),
            "available_count": 0,
            "exhausted_count": 0,
            "unknown_count": len(batch),
            "results": [],
        }

    monkeypatch.setattr(provider, "refresh_video_quotas", fake_refresh)

    first = await provider.refresh_stale_video_quotas(limit=2, rotate=True)
    second = await provider.refresh_stale_video_quotas(limit=2, rotate=True)
    third = await provider.refresh_stale_video_quotas(limit=2, rotate=True)

    assert calls == [[0, 1], [2, 3], [0, 1]]
    assert first["checked_count"] == 2
    assert second["checked_count"] == 2
    assert third["checked_count"] == 2


@pytest.mark.asyncio
async def test_auto_quota_refresh_plan_skips_browser_when_confirmed_pool_is_healthy(monkeypatch):
    provider = VideoProvider()
    provider.credential_manager = CredentialManager(["cookie-a", "cookie-b", "cookie-c"], failure_threshold=10)
    for index in range(3):
        await provider.credential_manager.update_quota(
            index,
            remaining=4,
            unit="video credits",
            source="video_history",
            status="available",
        )
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_REFRESH_BATCH_SIZE", 1)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_REFRESH_MIN_AVAILABLE_ACCOUNTS", 3)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_UNKNOWN_REFRESH_INTERVAL_SECONDS", 600)
    provider._quota_unknown_refresh_last_at = time.time()

    plan = provider._auto_quota_refresh_plan()

    assert plan["skip"] is True
    assert plan["limit"] == 0
    assert plan["mode"] == "healthy_confirmed_quota"
    assert plan["confirmed_count"] == 3


@pytest.mark.asyncio
async def test_auto_quota_refresh_plan_probes_unknown_when_confirmed_pool_is_low(monkeypatch):
    provider = VideoProvider()
    provider.credential_manager = CredentialManager(["cookie-a", "cookie-b", "cookie-c"], failure_threshold=10)
    await provider.credential_manager.update_quota(
        0,
        remaining=4,
        unit="video credits",
        source="video_history",
        status="available",
    )
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_REFRESH_BATCH_SIZE", 1)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_REFRESH_MIN_AVAILABLE_ACCOUNTS", 3)

    plan = provider._auto_quota_refresh_plan()

    assert plan["skip"] is False
    assert plan["confirmed_only"] is False
    assert plan["limit"] == 1
    assert plan["mode"] == "low_confirmed_quota"
    assert plan["confirmed_count"] == 1


def test_cleanup_video_tasks_removes_expired_terminal_tasks(monkeypatch):
    provider = VideoProvider()
    now = time.time()
    provider.tasks = {
        "old": {
            "id": "old",
            "status": "succeeded",
            "result": {},
            "error": None,
            "created": now - 7200,
            "completed_at": now - 7200,
        },
        "active": {
            "id": "active",
            "status": "running",
            "result": None,
            "error": None,
            "created": now - 7200,
            "completed_at": now - 7200,
        },
        "fresh": {
            "id": "fresh",
            "status": "failed",
            "result": None,
            "error": {"message": "recent"},
            "created": now,
            "completed_at": now,
        },
    }
    monkeypatch.setattr(settings, "VIDEO_TASK_RETENTION_SECONDS", 3600)
    monkeypatch.setattr(settings, "VIDEO_TASK_MAX_RETAINED", 500)

    removed = provider.cleanup_video_tasks()

    assert removed == 1
    assert set(provider.tasks) == {"active", "fresh"}


def test_cleanup_video_tasks_enforces_max_retained_terminal_tasks(monkeypatch):
    provider = VideoProvider()
    now = time.time()
    provider.tasks = {
        "first": {"id": "first", "status": "succeeded", "created": now - 3, "completed_at": now - 3},
        "second": {"id": "second", "status": "failed", "created": now - 2, "completed_at": now - 2},
        "third": {"id": "third", "status": "succeeded", "created": now - 1, "completed_at": now - 1},
    }
    monkeypatch.setattr(settings, "VIDEO_TASK_RETENTION_SECONDS", 999999)
    monkeypatch.setattr(settings, "VIDEO_TASK_MAX_RETAINED", 2)

    removed = provider.cleanup_video_tasks()

    assert removed == 1
    assert set(provider.tasks) == {"second", "third"}


@pytest.mark.asyncio
async def test_refresh_stale_video_quotas_skips_non_available_accounts(monkeypatch):
    provider = VideoProvider()
    provider.credential_manager = CredentialManager(["cookie-a", "cookie-b", "cookie-c"], failure_threshold=10)
    await provider.credential_manager.update_quota(
        0,
        remaining=4,
        unit="video credits",
        source="video_history",
        status="available",
    )
    provider.credential_manager.report_failure(
        1,
        RuntimeError("Doubao requires browser verification (verify_scene=doubao_message_web)."),
    )
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_MAX_AGE_SECONDS", -1)
    calls = []

    async def fake_refresh(indexes=None):
        batch = list(indexes) if indexes is not None else []
        calls.append(batch)
        return {
            "checked_count": len(batch),
            "available_count": 0,
            "exhausted_count": 0,
            "unknown_count": len(batch),
            "results": [],
        }

    monkeypatch.setattr(provider, "refresh_video_quotas", fake_refresh)

    lease = await provider.credential_manager.acquire_lease()
    try:
        accounts = provider.credential_manager.snapshot()["accounts"]
        assert accounts[lease.index]["status"] == "busy"
        assert provider._account_has_video_quota(accounts[lease.index], 1) is False

        result = await provider.refresh_stale_video_quotas()
    finally:
        await lease.release()

    assert calls == [[2]]
    assert result["checked_count"] == 1


@pytest.mark.asyncio
async def test_refresh_stale_video_quotas_confirmed_only_skips_unknown_accounts(monkeypatch):
    provider = VideoProvider()
    provider.credential_manager = CredentialManager(["cookie-a", "cookie-b"], failure_threshold=10)
    await provider.credential_manager.update_quota(
        0,
        remaining=4,
        unit="video credits",
        source="video_history",
        status="available",
    )
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_MAX_AGE_SECONDS", -1)
    calls = []

    async def fake_refresh(indexes=None):
        batch = list(indexes) if indexes is not None else []
        calls.append(batch)
        return {
            "checked_count": len(batch),
            "available_count": len(batch),
            "exhausted_count": 0,
            "unknown_count": 0,
            "results": [],
        }

    monkeypatch.setattr(provider, "refresh_video_quotas", fake_refresh)

    result = await provider.refresh_stale_video_quotas(confirmed_only=True)

    assert calls == [[0]]
    assert result["checked_count"] == 1


def test_active_video_task_detection():
    provider = VideoProvider()
    provider.tasks["queued"] = {"status": "queued"}
    assert provider._has_active_video_tasks() is True

    provider.tasks["queued"]["status"] = "succeeded"
    assert provider._has_active_video_tasks() is False


@pytest.mark.asyncio
async def test_quota_refresh_skips_accounts_without_today_quota_signal(monkeypatch):
    provider = VideoProvider()
    provider.credential_manager = CredentialManager(
        ["cookie-a", "cookie-b", "cookie-c", "cookie-d"],
        failure_threshold=10,
    )
    await provider.credential_manager.update_quota(
        0,
        unit="video credits",
        source="video_history",
        status="unknown",
        error="No current-day video quota signal was found in Doubao conversation history.",
    )
    await provider.credential_manager.record_quota_usage_without_balance(3, 2, reason="video")
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_MAX_AGE_SECONDS", 1)
    calls = []

    async def fake_refresh(indexes=None):
        batch = list(indexes) if indexes is not None else []
        calls.append(batch)
        return {
            "checked_count": len(batch),
            "available_count": 0,
            "exhausted_count": 0,
            "unknown_count": len(batch),
            "results": [],
        }

    monkeypatch.setattr(provider, "refresh_video_quotas", fake_refresh)

    result = await provider.refresh_stale_video_quotas()

    assert calls == [[1, 2, 3]]
    assert result["checked_count"] == 3


@pytest.mark.asyncio
async def test_full_quota_refresh_skips_same_day_no_signal_accounts(monkeypatch):
    provider = VideoProvider()
    provider.credential_manager = CredentialManager(["cookie-a", "cookie-b"], failure_threshold=10)
    await provider.credential_manager.update_quota(
        0,
        unit="video credits",
        source="video_history",
        status="unknown",
        error="No current-day video quota signal was found in Doubao conversation history.",
    )
    refreshed = []

    async def fake_refresh_account(index):
        refreshed.append(index)
        account = await provider.credential_manager.mark_quota_error(
            index,
            "quota signal not found",
            source="video_history",
        )
        return {"account": account, "supported": True, "found": False}

    monkeypatch.setattr(provider, "refresh_account_video_quota", fake_refresh_account)

    result = await provider.refresh_video_quotas()

    assert refreshed == [1]
    assert result["checked_count"] == 1


@pytest.mark.asyncio
async def test_video_quota_refresh_status_tracks_last_run(monkeypatch):
    provider = VideoProvider()
    provider.credential_manager = CredentialManager(["cookie-a", "cookie-b"], failure_threshold=10)

    async def fake_refresh_account(index):
        if index == 0:
            account = await provider.credential_manager.update_quota(
                index,
                remaining=4,
                unit="video credits",
                source="video_history",
                status="available",
            )
        else:
            account = await provider.credential_manager.mark_quota_error(
                index,
                "No current-day video quota signal was found in Doubao conversation history.",
                source="video_history",
            )
        return {"account": account, "supported": True, "found": index == 0}

    monkeypatch.setattr(provider, "refresh_account_video_quota", fake_refresh_account)

    result = await provider.refresh_video_quotas()
    status = provider.quota_refresh_status()

    assert result["checked_count"] == 2
    assert result["available_count"] == 1
    assert result["unknown_count"] == 1
    assert status["in_progress"] is False
    assert status["started_at"] is not None
    assert status["completed_at"] >= status["started_at"]
    assert status["last_error"] is None
    assert status["last_result"]["checked_count"] == 2
    assert status["last_result"]["available_count"] == 1


@pytest.mark.asyncio
async def test_targeted_quota_refresh_can_run_during_background_refresh(monkeypatch):
    provider = VideoProvider()
    provider.credential_manager = CredentialManager(["cookie-a", "cookie-b", "cookie-c"], failure_threshold=10)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_REFRESH_CONCURRENCY", 1)
    started = []
    release = {index: asyncio.Event() for index in range(3)}

    async def fake_refresh_account(index):
        started.append(index)
        await release[index].wait()
        account = await provider.credential_manager.mark_quota_error(
            index,
            "quota signal not found",
            source="video_history",
        )
        return {"account": account, "supported": True, "found": False}

    async def wait_for_started_count(count):
        for _ in range(40):
            if len(started) >= count:
                return
            await asyncio.sleep(0.01)
        raise AssertionError(f"only saw refresh starts: {started}")

    monkeypatch.setattr(provider, "refresh_account_video_quota", fake_refresh_account)

    background = asyncio.create_task(provider.refresh_video_quotas())
    await wait_for_started_count(1)
    assert started == [0]

    targeted = asyncio.create_task(provider.refresh_video_quotas([2]))
    release[0].set()
    await wait_for_started_count(2)

    assert started[1] == 2
    release[2].set()
    await targeted
    release[1].set()
    await background


@pytest.mark.asyncio
async def test_ensure_video_quota_falls_back_to_unknown_accounts(monkeypatch):
    provider = VideoProvider()
    provider.credential_manager = CredentialManager(["cookie-a", "cookie-b"], failure_threshold=10)
    await provider.credential_manager.update_quota(
        0,
        remaining=1,
        unit="video credits",
        source="video_history",
        status="available",
    )
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_MAX_AGE_SECONDS", -1)
    calls = []

    async def fake_refresh(indexes=None):
        batch = list(indexes) if indexes is not None else None
        calls.append(batch)
        if batch == [0]:
            await provider.credential_manager.disable_for_quota_exhausted(
                0,
                "daily limit reached",
                source="video_history",
            )
            return {"checked_count": 1, "available_count": 0, "exhausted_count": 1, "unknown_count": 0}
        if batch == [1]:
            await provider.credential_manager.update_quota(
                1,
                remaining=3,
                unit="video credits",
                source="video_history",
                status="available",
            )
            return {"checked_count": 1, "available_count": 1, "exhausted_count": 0, "unknown_count": 0}
        raise AssertionError(f"unexpected refresh batch: {batch}")

    monkeypatch.setattr(provider, "refresh_video_quotas", fake_refresh)

    result = await provider.ensure_video_quota(2, probe_unknown=True)

    assert result["eligible"] is True
    assert result["eligible_count"] == 1
    assert result["checked_count"] == 2
    assert calls == [[0], [1]]
    accounts = provider.credential_manager.snapshot()["accounts"]
    assert accounts[0]["status"] == "disabled"
    assert accounts[1]["quota"]["remaining"] == 3


@pytest.mark.asyncio
async def test_ensure_video_quota_skips_same_day_no_signal_accounts(monkeypatch):
    provider = VideoProvider()
    provider.credential_manager = CredentialManager(["cookie-a", "cookie-b"], failure_threshold=10)
    await provider.credential_manager.update_quota(
        0,
        unit="video credits",
        source="video_history",
        status="unknown",
        error="No current-day video quota signal was found in Doubao conversation history.",
    )
    calls = []

    async def fake_refresh(indexes=None):
        batch = list(indexes) if indexes is not None else []
        calls.append(batch)
        if batch == [1]:
            await provider.credential_manager.update_quota(
                1,
                remaining=3,
                unit="video credits",
                source="video_history",
                status="available",
            )
            return {"checked_count": 1, "available_count": 1, "exhausted_count": 0, "unknown_count": 0}
        raise AssertionError(f"unexpected refresh batch: {batch}")

    monkeypatch.setattr(provider, "refresh_video_quotas", fake_refresh)

    result = await provider.ensure_video_quota(2, probe_unknown=True)

    assert result["eligible"] is True
    assert calls == [[1]]


@pytest.mark.asyncio
async def test_ensure_video_quota_stops_after_first_eligible_account(monkeypatch):
    provider = VideoProvider()
    provider.credential_manager = CredentialManager(["cookie-a", "cookie-b", "cookie-c"], failure_threshold=10)
    calls = []

    async def fake_refresh(indexes=None):
        batch = list(indexes) if indexes is not None else []
        calls.append(batch)
        index = batch[0]
        if index == 1:
            await provider.credential_manager.update_quota(
                index,
                remaining=4,
                unit="video credits",
                source="video_history",
                status="available",
            )
            return {"checked_count": 1, "available_count": 1, "exhausted_count": 0, "unknown_count": 0}
        await provider.credential_manager.mark_quota_error(index, "quota signal not found", source="video_history")
        return {"checked_count": 1, "available_count": 0, "exhausted_count": 0, "unknown_count": 1}

    monkeypatch.setattr(provider, "refresh_video_quotas", fake_refresh)

    result = await provider.ensure_video_quota(4, probe_unknown=True)

    assert result["eligible"] is True
    assert result["checked_count"] == 2
    assert calls == [[0], [1]]


@pytest.mark.asyncio
async def test_ensure_video_quota_does_not_probe_unknown_accounts_by_default(monkeypatch):
    provider = VideoProvider()
    provider.credential_manager = CredentialManager([f"cookie-{index}" for index in range(2)])
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_ALLOW_UNKNOWN_QUOTA_ON_GENERATE", False)
    calls = []

    async def fake_refresh(indexes=None):
        calls.append(list(indexes) if indexes is not None else None)
        raise AssertionError("generation preflight should not probe unknown accounts by default")

    monkeypatch.setattr(provider, "refresh_video_quotas", fake_refresh)

    result = await provider.ensure_video_quota(2)

    assert result["eligible"] is False
    assert result["eligible_count"] == 0
    assert result["provisional"] is False
    assert result["provisional_allowed"] is False
    assert result["provisional_count"] == 0
    assert result["checked_count"] == 0
    assert calls == []


@pytest.mark.asyncio
async def test_ensure_video_quota_reports_provisional_after_probe_without_marking_it_eligible(monkeypatch):
    provider = VideoProvider()
    provider.credential_manager = CredentialManager([f"cookie-{index}" for index in range(5)])
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_ACCOUNT_RETRY_LIMIT", 2)
    calls = []

    async def fake_refresh(indexes=None):
        batch = list(indexes) if indexes is not None else []
        calls.append(batch)
        await provider.credential_manager.update_quota(
            batch[0],
            unit="video credits",
            source="video_history",
            status="unknown",
            error="No current-day video quota signal was found in Doubao conversation history.",
        )
        return {"checked_count": 1, "available_count": 0, "exhausted_count": 0, "unknown_count": 1}

    monkeypatch.setattr(provider, "refresh_video_quotas", fake_refresh)

    result = await provider.ensure_video_quota(2, probe_unknown=True)

    assert result["eligible"] is False
    assert result["eligible_count"] == 0
    assert result["provisional"] is True
    assert result["provisional_allowed"] is True
    assert result["checked_count"] == 2
    assert calls == [[0], [1]]


@pytest.mark.asyncio
async def test_run_doubao_web_task_does_not_probe_unknown_quota_by_default(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    provider.playwright_manager = object()
    provider.credential_manager = CredentialManager(["cookie-a"], failure_threshold=10)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 2)
    monkeypatch.setattr(settings, "VIDEO_LONG_FORM_SEGMENT_SECONDS", 10)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_ALLOW_UNKNOWN_QUOTA_ON_GENERATE", False)

    async def fake_ensure(required_quota, *, probe_unknown=None):
        assert probe_unknown is False
        return {
            "refreshed": False,
            "eligible": False,
            "eligible_count": 0,
            "provisional": True,
            "provisional_allowed": False,
            "provisional_count": 1,
            "checked_count": 0,
            "available_count": 0,
            "exhausted_count": 0,
            "unknown_count": 1,
        }

    calls = []

    async def fake_segment(task, request_data, log_task_id, cookie):
        calls.append(cookie)
        raise AssertionError("unknown-quota account should not be used by default")

    monkeypatch.setattr(provider, "ensure_video_quota", fake_ensure)
    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "params": {"duration": 10},
        "debug": {"events": [], "signals": empty_video_signals()},
        "reference_image": None,
    }

    await provider._run_doubao_web_task(task, "vid-test", {}, "http://testserver")

    assert calls == []
    assert task["status"] == "failed"
    assert task["error"]["code"] == "credential_pool_busy"
    assert task["debug"]["quota_preflight"]["provisional"] is True
    assert task["debug"]["quota_preflight"]["provisional_allowed"] is False


@pytest.mark.asyncio
async def test_run_doubao_web_task_uses_provisional_quota_when_generation_probe_is_enabled(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    provider.playwright_manager = object()
    provider.credential_manager = CredentialManager(["cookie-a"], failure_threshold=10)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 2)
    monkeypatch.setattr(settings, "VIDEO_LONG_FORM_SEGMENT_SECONDS", 10)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_ALLOW_UNKNOWN_QUOTA_ON_GENERATE", True)
    await provider.credential_manager.update_quota(
        0,
        unit="video credits",
        source="video_history",
        status="unknown",
        error="No current-day video quota signal was found in Doubao conversation history.",
    )

    async def fake_ensure(required_quota, *, probe_unknown=None):
        assert probe_unknown is True
        return {
            "refreshed": True,
            "eligible": False,
            "eligible_count": 0,
            "provisional": True,
            "provisional_allowed": True,
            "provisional_count": 1,
            "checked_count": 1,
            "available_count": 0,
            "exhausted_count": 0,
            "unknown_count": 1,
        }

    calls = []

    async def fake_segment(task, request_data, log_task_id, cookie):
        calls.append(cookie)
        task["result"] = {
            "url": "https://example.test/video.mp4",
            "upstream_url": "https://example.test/video.mp4",
            "content_type": "video/mp4",
        }
        task["status"] = "succeeded"
        return task["result"]

    monkeypatch.setattr(provider, "ensure_video_quota", fake_ensure)
    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "params": {"duration": 10},
        "debug": {"events": [], "signals": empty_video_signals()},
        "reference_image": None,
    }

    await provider._run_doubao_web_task(task, "vid-test", {}, "http://testserver")

    assert calls == ["cookie-a"]
    assert task["status"] == "succeeded"
    assert task["error"] is None
    assert task["debug"]["quota_preflight"]["provisional"] is True
    assert task["debug"]["quota_preflight"]["provisional_allowed"] is True
    assert provider.credential_manager.snapshot()["accounts"][0]["quota"]["status"] == "pending_refresh"


def test_pending_refresh_timeout_account_allows_provisional_video_quota():
    account = {
        "status": "available",
        "quota": {
            "status": "pending_refresh",
            "source": "video_history",
            "updated_at": time.time(),
            "last_error": "Video quota refresh timed out after 30s.",
        },
    }

    assert VideoProvider._account_allows_provisional_video_quota(account) is True


def test_required_video_quota_scales_with_duration(monkeypatch):
    provider = VideoProvider()
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 4)
    monkeypatch.setattr(settings, "VIDEO_LONG_FORM_SEGMENT_SECONDS", 10)

    assert provider._required_video_quota({"params": {"duration": 5}}) == 2
    assert provider._required_video_quota({"params": {"duration": 10}}) == 4
    assert provider._required_video_quota({"params": {"duration": 30}}) == 12


def test_video_history_candidates_prioritize_latest_conversation(monkeypatch):
    now = int(time.time())
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_HISTORY_CONVERSATIONS", 50)
    payload = {
        "downlink_body": {
            "pull_recent_conv_chain_downlink_body": {
                "cells": [
                    {
                        "conversation": {
                            "conversation_id": "older-video-title",
                            "name": "生成视频",
                            "update_time": str(now - 60),
                        }
                    },
                    {
                        "conversation": {
                            "conversation_id": "newer-generic-title",
                            "name": "新对话",
                            "update_time": str(now),
                        }
                    },
                ]
            }
        }
    }

    candidates = VideoProvider._video_history_candidates(payload)

    assert [item["conversation_id"] for item in candidates] == [
        "newer-generic-title",
        "older-video-title",
    ]


def test_normalize_prepare_upload_data_accepts_nested_camel_case_auth():
    prepared = normalize_prepare_upload_data(
        {
            "Result": {
                "ServiceId": "imagex-service",
                "UploadAuthToken": {
                    "AccessKeyId": "ak",
                    "SecretAccessKey": "sk",
                    "SessionToken": "session",
                },
            }
        }
    )

    assert prepared == {
        "service_id": "imagex-service",
        "upload_auth_token": {
            "access_key": "ak",
            "secret_key": "sk",
            "session_token": "session",
        },
    }


@pytest.mark.asyncio
async def test_video_segment_retries_retryable_prepare_upload_error(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    closed_sessions = []

    class FakePlaywrightManager:
        async def close_account_session(self, cookie):
            closed_sessions.append(cookie)
            return True

    provider.playwright_manager = FakePlaywrightManager()
    provider.credential_manager = CredentialManager(["cookie-a", "cookie-b"], failure_threshold=10)
    for index in (0, 1):
        await provider.credential_manager.update_quota(
            index,
            remaining=4,
            unit="video credits",
            source="video_history",
            status="available",
        )

    calls = []

    async def fake_segment(task, request_data, log_task_id, cookie):
        calls.append(cookie)
        if len(calls) == 1:
            raise RetryableUploadAuthError("prepare_upload did not return service_id.")
        task["result"] = {
            "url": "https://example.test/video.mp4",
            "upstream_url": "https://example.test/video.mp4",
            "content_type": "video/mp4",
        }
        task["status"] = "succeeded"
        return task["result"]

    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 1)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "params": {"duration": 10},
        "debug": {"events": [], "signals": empty_video_signals()},
        "reference_image": None,
    }

    result = await provider._complete_doubao_web_segment(task, {}, "vid-test")

    assert result["url"] == "https://example.test/video.mp4"
    assert len(calls) == 2
    assert closed_sessions == ["cookie-a", "cookie-b"]
    assert task["debug"]["credential_retries"][0]["account_index"] == 0


def test_video_upload_dns_error_is_retryable():
    provider = VideoProvider()

    assert provider._is_retryable_upload_error("[Errno -5] No address associated with hostname")
    assert provider._is_retryable_upload_error("TOS image upload network error: ConnectError")


@pytest.mark.asyncio
async def test_reference_image_upload_retries_alternate_tos_upload_host(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    provider.playwright_manager = object()
    provider.credential_manager = object()

    async def fake_reference_image_bytes(reference_image):
        return b"image-bytes"

    async def fake_prepare(cookie):
        assert cookie == "cookie-a"
        return {
            "service_id": "imagex-service",
            "upload_auth_token": {
                "access_key": "ak",
                "secret_key": "sk",
                "session_token": "session",
            },
        }

    async def fake_apply(service_id, auth_token, file_size, extension):
        assert service_id == "imagex-service"
        assert file_size == len(b"image-bytes")
        assert extension == ".png"
        return {
            "Result": {
                "UploadAddress": {
                    "StoreInfos": [{"StoreUri": "tos/bad.png", "Auth": "bad-auth"}],
                    "UploadHosts": ["bad.upload.test"],
                    "SessionKey": "bad-session",
                },
                "InnerUploadAddress": {
                    "UploadNodes": [
                        {
                            "StoreInfos": [{"StoreUri": "tos/good.png", "Auth": "good-auth"}],
                            "UploadHosts": ["good.upload.test"],
                            "SessionKey": "good-session",
                        }
                    ]
                },
            }
        }

    upload_calls = []

    async def fake_post(upload_host, store_uri, store_auth, raw):
        upload_calls.append((upload_host, store_uri, store_auth, raw))
        if upload_host == "bad.upload.test":
            raise RetryableUploadAuthError(
                "TOS image upload network error: [Errno -5] No address associated with hostname"
            )

    commit_calls = []

    async def fake_commit(service_id, auth_token, session_key):
        commit_calls.append(session_key)
        return {
            "Result": {
                "PluginResult": [
                    {
                        "ImageUri": "tos/good.png",
                        "ImageWidth": 640,
                        "ImageHeight": 360,
                        "ImageMd5": "md5",
                    }
                ]
            }
        }

    monkeypatch.setattr(provider, "_reference_image_bytes", fake_reference_image_bytes)
    monkeypatch.setattr(provider, "_prepare_doubao_image_upload", fake_prepare)
    monkeypatch.setattr(provider, "_apply_doubao_image_upload", fake_apply)
    monkeypatch.setattr(provider, "_post_doubao_image_bytes", fake_post)
    monkeypatch.setattr(provider, "_commit_doubao_image_upload", fake_commit)

    uploaded = await provider._upload_reference_image_to_doubao(
        {"file_name": "reference.png", "mime_type": "image/png"},
        cookie="cookie-a",
    )

    assert [call[0] for call in upload_calls] == ["bad.upload.test", "good.upload.test"]
    assert upload_calls[1] == ("good.upload.test", "tos/good.png", "good-auth", b"image-bytes")
    assert commit_calls == ["good-session"]
    assert uploaded["fileKey"] == "tos/good.png"
    assert uploaded["imageWidth"] == 640
    assert uploaded["imageHeight"] == 360


@pytest.mark.asyncio
async def test_confirmed_video_quota_signal_is_not_deducted_twice(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    provider.playwright_manager = object()
    provider.credential_manager = CredentialManager(["cookie-a"], failure_threshold=10)
    await provider.credential_manager.update_quota(
        0,
        remaining=5,
        unit="video credits",
        source="video_history",
        status="available",
    )

    async def fake_segment(task, request_data, log_task_id, cookie):
        await provider.credential_manager.update_quota(
            0,
            remaining=4,
            unit="video credits",
            source="video_signal",
            status="available",
        )
        task.setdefault("debug", {}).setdefault("quota_sync", []).append(
            {"account_index": 0, "remaining": 4}
        )
        task["result"] = {
            "url": "https://example.test/video.mp4",
            "upstream_url": "https://example.test/video.mp4",
            "content_type": "video/mp4",
        }
        task["status"] = "succeeded"
        return task["result"]

    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 1)

    task = {
        "id": "vid-test",
        "status": "running",
        "error": None,
        "result": None,
        "params": {"duration": 10},
        "debug": {"events": [], "signals": empty_video_signals()},
        "reference_image": None,
    }

    await provider._complete_doubao_web_segment(task, {}, "vid-test")

    account = provider.credential_manager.snapshot()["accounts"][0]
    assert account["quota"]["remaining"] == 4
    assert account["quota"]["source"] == "video_signal"


@pytest.mark.asyncio
async def test_success_without_balance_records_usage_and_rotates_account(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    provider.client = object()
    provider.playwright_manager = object()
    provider.credential_manager = CredentialManager(["cookie-a", "cookie-b"], failure_threshold=10)
    await provider.credential_manager.update_quota(
        0,
        remaining=4,
        unit="video credits",
        source="video_history",
        status="available",
    )
    await provider.credential_manager.update_quota(
        1,
        remaining=4,
        unit="video credits",
        source="video_history",
        status="available",
    )
    calls = []

    async def fake_segment(task, request_data, log_task_id, cookie):
        calls.append(cookie)
        task["result"] = {
            "url": "https://example.test/video.mp4",
            "upstream_url": "https://example.test/video.mp4",
            "content_type": "video/mp4",
        }
        task["status"] = "succeeded"
        return task["result"]

    monkeypatch.setattr(provider, "_complete_doubao_web_segment_with_cookie", fake_segment)
    monkeypatch.setattr(settings, "DOUBAO_VIDEO_QUOTA_COST", 2)

    for task_id in ("vid-first", "vid-second"):
        task = {
            "id": task_id,
            "status": "running",
            "error": None,
            "result": None,
            "params": {"duration": 10},
            "debug": {"events": [], "signals": empty_video_signals()},
            "reference_image": None,
        }
        await provider._complete_doubao_web_segment(task, {}, task_id)

    assert calls == ["cookie-a", "cookie-b"]
    accounts = provider.credential_manager.snapshot()["accounts"]
    assert [account["quota"]["status"] for account in accounts] == [
        "estimated",
        "estimated",
    ]
    assert [account["quota"]["remaining"] for account in accounts] == [2, 2]
    assert [account["quota"]["used"] for account in accounts] == [2, 2]


def test_doubao_i2v_payload_uses_web_attachment_block():
    provider = VideoProvider()
    payload = provider._prepare_doubao_video_payload(
        {
            "model": "doubao-seedance-2-0",
            "aspect_ratio": "9:16",
            "resolution": "1080p",
            "duration": 5,
            "reference_image": {
                "fileKey": "tos-cn-i-a9rns2rl98/test/reference.png",
                "localKey": "local_test_reference",
                "fileName": "reference.png",
                "mimeType": "image/png",
                "size": 1234,
                "imageWidth": 636,
                "imageHeight": 1143,
                "md5": "abc123",
            },
        },
        "Animate this reference image.",
        "doubao-seedance-2-0",
        request_fingerprint="account-specific-fp",
    )

    assert len(payload["messages"]) == 2
    attachment_message = payload["messages"][0]
    text_message = payload["messages"][1]
    blocks = attachment_message["content_block"]
    assert [block["block_type"] for block in blocks] == [DOUBAO_BLOCK_ATTACHMENT]
    assert text_message["content_block"][0]["block_type"] == DOUBAO_BLOCK_TEXT

    attachment = blocks[0]["content"]["attachment_block"]["attachments"][0]
    assert attachment["type"] == 1
    assert attachment["identifier"] != "local_test_reference"
    assert attachment["image"]["uri"] == "tos-cn-i-a9rns2rl98/test/reference.png"
    assert attachment["image"]["image_ori"]["width"] == 636
    assert attachment["image"]["image_ori"]["height"] == 1143
    assert attachment["parse_state"] == 0
    assert attachment["review_state"] == 1
    assert attachment["upload_status"] == 1

    ability_param = json_loads(payload["chat_ability"]["ability_param"])
    assert ability_param == {"model": "seedance_v2.0", "duration": 5}
    assert set(attachment_message) == {"local_message_id", "content_block", "message_status"}
    assert set(text_message) == {"local_message_id", "content_block", "message_status"}
    assert text_message["content_block"][0]["content"]["text_block"]["text"] == (
        "生成视频：Animate this reference image."
    )
    assert payload["ext"]["fp"] == "account-specific-fp"
    assert payload["option"]["collect_id"] == payload["ext"]["collection_id"]
    assert set(payload["ext"]) == {
        "answer_with_suggest",
        "fp",
        "sub_conv_firstmet_type",
        "collection_id",
        "conversation_init_option",
        "commerce_credit_config_enable",
    }


def test_extract_video_signals_detects_doubao_creation_block_video():
    signals = extract_video_signals(
        {
            "content_block": [
                {
                    "block_type": 2074,
                    "content": {
                        "creation_block": {
                            "creations": [
                                {
                                    "id": "47325972784275714",
                                    "video": {
                                        "status": 3,
                                        "video_type": "mp4",
                                        "download_url": "https://v3-default.douyin.com/video/tos/example/?download=true",
                                        "video_model": '{"status":10,"message":"success"}',
                                    },
                                }
                            ]
                        }
                    },
                }
            ],
            "ext": {
                "ai_creation_res_code": "0",
                "ai_creation_tool_list": '[{"task_id":47325972784275714,"status":4,"fail_code":0}]',
            },
        }
    )

    assert signals["task_ids"] == ["47325972784275714"]
    assert signals["video_urls"] == ["https://v3-default.douyin.com/video/tos/example/?download=true"]
    assert signals["failures"] == []
    assert signals["status"] == "4"


def test_extract_video_signals_prefers_download_url_over_play_url():
    play_url = "https://v3-default.douyin.com/video/tos/preview/?watermark=true"
    download_url = "https://v3-default.douyin.com/video/tos/original/?download=true"

    signals = extract_video_signals(
        {
            "video": {
                "play_url": play_url,
                "download_url": download_url,
            }
        }
    )

    assert signals["video_urls"][:2] == [download_url, play_url]


def test_merge_video_signals_promotes_later_download_url_over_play_url():
    provider = VideoProvider()
    play_url = "https://v3-default.douyin.com/video/tos/preview/?watermark=true"
    download_url = "https://v3-default.douyin.com/video/tos/original/?download=true"
    task = {"debug": {"signals": empty_video_signals()}}

    provider._merge_signals(task, extract_video_signals({"video": {"play_url": play_url}}))
    provider._merge_signals(task, extract_video_signals({"video": {"download_url": download_url}}))

    assert task["debug"]["signals"]["video_urls"][:2] == [download_url, play_url]


def test_watermarked_video_urls_are_penalized_against_clean_urls():
    watermarked_url = "https://v3-default.douyin.com/video/tos/preview/?lr=video_gen_watermark_dyn"
    clean_url = "https://v3-default.douyin.com/video/tos/original/?download=true"

    signals = extract_video_signals(
        {
            "video": {
                "download_url": watermarked_url,
                "play_url": clean_url,
            }
        }
    )

    assert _is_watermarked_video_url(watermarked_url) is True
    assert signals["video_urls"][:2] == [clean_url, watermarked_url]


def test_extract_video_signals_captures_video_id_from_video_model():
    video_id = "v0369cg10004d8p657aljhtabvocj170"
    signals = extract_video_signals({"video_model": json.dumps({"video_id": video_id})})

    assert signals["video_ids"] == [video_id]


def test_extract_video_signals_reads_original_media_main_url():
    clean_url = "https://v26-videoweb.doubao.com/video/tos/original/?x-expires=123"
    signals = extract_video_signals({"data": {"original_media_info": {"main_url": clean_url}}})

    assert signals["video_urls"] == [clean_url]


@pytest.mark.asyncio
async def test_watermarked_result_resolves_doubao_nomark_original_media_url(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    watermarked_url = "https://v3-default.douyin.com/video/tos/preview/?lr=video_gen_watermark_dyn"
    candidate_url = "https://v26-videoweb.doubao.com/video/tos/original/?x-expires=123"
    calls = []

    async def fake_fetch(cookie, video_id):
        calls.append((cookie, video_id))
        return candidate_url, {
            "video_id": video_id,
            "resolved": True,
            "candidate_without_marker": True,
            "candidate_source": "samantha_media_get_play_info.original_media_info",
            "candidate_url": candidate_url,
        }

    monkeypatch.setattr(provider, "_fetch_doubao_original_media_url", fake_fetch)
    monkeypatch.setattr(provider, "_write_upstream_debug", lambda task: None)
    task = {
        "id": "vid-test",
        "params": {"watermark": False},
        "debug": {"signals": {"video_ids": ["v0369cg10004d8p657aljhtabvocj170"]}},
        "result": {
            "url": watermarked_url,
            "upstream_url": watermarked_url,
            "content_type": "video/mp4",
        },
    }

    await provider._resolve_no_watermark_result(task, "cookie-a")

    assert calls == [("cookie-a", "v0369cg10004d8p657aljhtabvocj170")]
    assert task["result"]["url"] == candidate_url
    assert task["result"]["upstream_url"] == candidate_url
    assert task["result"]["no_watermark_source"] == "samantha_media_get_play_info.original_media_info"
    assert "file_path" not in task["result"]
    assert task["debug"]["no_watermark_resolution"]["resolved"] is True
    assert task["debug"]["no_watermark_resolution"]["attempts"][0]["candidate_without_marker"] is True


@pytest.mark.asyncio
async def test_doubao_nomark_fetch_prefers_original_media_info_over_media_info():
    provider = VideoProvider()
    media_url = "https://v26-videoweb.doubao.com/video/tos/playback/?download=true"
    original_url = "https://v26-videoweb.doubao.com/video/tos/original/?download=true"

    class FakePlaywrightManager:
        async def post_json(self, *args, **kwargs):
            return {
                "status_code": 200,
                "text": json.dumps(
                    {
                        "code": 0,
                        "data": {
                            "media_info": [
                                {
                                    "meta": {"width": "720", "height": "1280", "definition": "720p"},
                                    "main_url": media_url,
                                }
                            ],
                            "original_media_info": {
                                "meta": {"width": "720", "height": "1280", "definition": "720p"},
                                "main_url": original_url,
                            },
                        },
                    }
                ),
            }

    provider.playwright_manager = FakePlaywrightManager()

    clean_url, attempt = await provider._fetch_doubao_original_media_url(
        "cookie-a",
        "v0369cg10004d8p657aljhtabvocj170",
    )

    assert clean_url == original_url
    assert attempt["resolved"] is True
    assert attempt["candidate_source"] == "samantha_media_get_play_info.original_media_info"
    assert attempt["candidate_url_key"] == "main_url"


@pytest.mark.asyncio
async def test_clean_result_does_not_trigger_no_watermark_resolution(monkeypatch, tmp_path):
    provider = VideoProvider()
    provider.output_dir = tmp_path
    clean_url = "https://v3-default.douyin.com/video/tos/original/?download=true"

    async def fail_fetch(cookie, video_id):
        raise AssertionError("clean URL should not be resolved again")

    monkeypatch.setattr(provider, "_fetch_doubao_original_media_url", fail_fetch)
    task = {
        "id": "vid-test",
        "params": {"watermark": False},
        "debug": {},
        "result": {
            "url": clean_url,
            "upstream_url": clean_url,
            "content_type": "video/mp4",
        },
    }

    await provider._resolve_no_watermark_result(task, "cookie-a")

    assert "file_path" not in task["result"]


def test_extract_video_signals_detects_completed_image_instead_of_video():
    signals = extract_video_signals(
        {
            "content_block": [
                {
                    "block_type": 2074,
                    "content": {
                        "creation_block": {
                            "creations": [
                                {
                                    "type": 1,
                                    "id": "47362995619014914",
                                    "gen_detail": {"task_type": 2},
                                    "image": {
                                        "status": 2,
                                        "placeholder": {"description": "Seedream 4.5"},
                                    },
                                }
                            ]
                        }
                    },
                }
            ],
            "ext": {
                "ai_creation_tool_list": (
                    '[{"task_id":47362995619014914,"tool_name":"image_edit",'
                    '"req_key":"seedream_v43_flow","status":4,"fail_code":0}]'
                ),
            },
        }
    )

    assert signals["task_ids"] == ["47362995619014914"]
    assert signals["video_urls"] == []
    assert signals["failures"] == []
    assert signals["non_video_results"]
    assert "instead of a video" in signals["non_video_results"][0]["message"]


def test_doubao_payload_preserves_prompt_and_uses_video_tool_context():
    provider = VideoProvider()
    payload = provider._prepare_doubao_video_payload(
        {
            "model": "doubao-seedance-2-0",
            "aspect_ratio": "9:16",
            "resolution": "720p",
            "duration": 10,
            "reference_image": {
                "fileKey": "tos-cn-i-a9rns2rl98/test/reference.png",
                "localKey": "local_test_reference",
                "fileName": "reference.png",
                "mimeType": "image/png",
                "imageWidth": 636,
                "imageHeight": 1143,
            },
        },
        "跳舞",
        "doubao-seedance-2-0",
    )

    text = payload["messages"][1]["content_block"][0]["content"]["text_block"]["text"]
    assert "跳舞" in text
    assert text.startswith("生成视频：")

    ability_param = json_loads(payload["chat_ability"]["ability_param"])
    assert ability_param == {"model": "seedance_v2.0", "duration": 10}


def test_doubao_payload_keeps_already_video_specific_prompt():
    provider = VideoProvider()
    payload = provider._prepare_doubao_video_payload(
        {
            "model": "doubao-seedance-2-0",
            "aspect_ratio": "16:9",
            "resolution": "720p",
            "duration": 10,
        },
        "把参考图生成10秒视频，人物自然跳舞",
        "doubao-seedance-2-0",
    )

    text = payload["messages"][0]["content_block"][0]["content"]["text_block"]["text"]
    assert text == "把参考图生成10秒视频，人物自然跳舞"


    ability_param = json_loads(payload["chat_ability"]["ability_param"])
    assert ability_param["watermark"] is False


def test_extract_reference_image_prefers_uploaded_file_key_over_empty_bytes():
    provider = VideoProvider()

    reference = provider._extract_reference_image(
        {
            "reference_image": {
                "fileKey": "tos-cn-i-a9rns2rl98/test/reference.png",
                "localKey": "local_test_reference",
                "fileName": "reference.png",
                "mimeType": "image/png",
                "size": 1234,
                "imageWidth": 636,
                "imageHeight": 1143,
                "md5": "abc123",
                "bytes": None,
            }
        }
    )

    assert reference["kind"] == "doubao_uploaded"
    assert reference["file_key"] == "tos-cn-i-a9rns2rl98/test/reference.png"
    assert reference["local_key"] == "local_test_reference"
    assert reference["bytes"] is None


def json_loads(value):
    import json

    return json.loads(value)
