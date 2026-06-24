import os
import sys
from pathlib import Path

import pytest


os.environ.setdefault("VIDEO_PROVIDER", "mock")
os.environ.setdefault("DOUBAO_COOKIE_1", "sessionid=test")
os.environ.setdefault("DOUBAO_DISABLED_CREDENTIAL_STORE_PATH", ".generated/test-disabled-credentials.json")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture(autouse=True)
def isolate_disabled_credential_store(monkeypatch, tmp_path):
    path = tmp_path / "disabled_credentials.json"
    quota_path = tmp_path / "video_quotas.json"
    monkeypatch.setenv("DOUBAO_DISABLED_CREDENTIAL_STORE_PATH", str(path))
    monkeypatch.setattr(
        "app.services.credential_manager.settings.DOUBAO_DISABLED_CREDENTIAL_STORE_PATH",
        str(path),
        raising=False,
    )
    monkeypatch.setenv("DOUBAO_VIDEO_QUOTA_STORE_PATH", str(quota_path))
    monkeypatch.setattr(
        "app.services.credential_manager.settings.DOUBAO_VIDEO_QUOTA_STORE_PATH",
        str(quota_path),
        raising=False,
    )
