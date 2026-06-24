from types import SimpleNamespace

import pytest

from app.services import doubao_captcha_solver as solver


def _config(**overrides):
    config = {
        "backend": "openai",
        "enabled": True,
        "base_url": "",
        "api_key": "EMPTY",
        "model": "",
        "zhenxun_model": "",
        "zhenxun_import_path": "",
        "zhenxun_plugin_module": "ai_creation.engines.doubao.captcha_solver",
        "timeout": 1,
        "retries": 1,
    }
    config.update(overrides)
    return config


def test_solver_configuration_rules():
    assert solver._solver_is_configured(_config(backend="openai", base_url="http://solver/v1", model="vlm"))
    assert not solver._solver_is_configured(_config(backend="openai", base_url="http://solver/v1", model=""))
    assert solver._solver_is_configured(_config(backend="http_json", base_url="http://solver/solve"))
    assert solver._solver_is_configured(_config(backend="zhenxun"))
    assert solver._solver_is_configured(_config(backend="zhenxun_plugin"))


def test_indices_from_solution_accepts_zhenxun_and_zero_based_shapes():
    assert solver._indices_from_solution({"success": True, "indices": [1, "5", 8]}) == [1, 5, 8]
    assert solver._indices_from_solution({"success": True, "objects": [0, 2]}) == [1, 3]
    assert solver._indices_from_solution({"success": False, "answer": ["bad"]}) == []


@pytest.mark.asyncio
async def test_http_json_backend_posts_bridge_payload(monkeypatch):
    calls = []

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"success": True, "indices": [1, 4]}

    class FakeAsyncClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, headers, json):
            calls.append({"url": url, "headers": headers, "json": json})
            return FakeResponse()

    monkeypatch.setattr(solver.httpx, "AsyncClient", FakeAsyncClient)

    config = _config(backend="http_json", base_url="http://solver/solve", api_key="secret")
    result = solver._classification_result(config)
    output = await solver._classify_with_http_json("pick cats", b"image-bytes", config, result)

    assert output["success"] is True
    assert output["indices"] == [1, 4]
    assert calls[0]["url"] == "http://solver/solve"
    assert calls[0]["headers"]["Authorization"] == "Bearer secret"
    assert calls[0]["json"]["prompt"] == "pick cats"
    assert calls[0]["json"]["image_mime"] == "image/png"


@pytest.mark.asyncio
async def test_zhenxun_backend_uses_generate_structured(monkeypatch):
    async def fake_generate_structured(message, response_model, instruction, model):
        assert message == {"text": "Question: 'pick cats'", "images": [b"image-bytes"]}
        assert response_model is solver.CaptchaSolution
        assert instruction == solver.CAPTCHA_SYSTEM_PROMPT
        assert model == "Gemini/gemini-2.5-flash"
        return SimpleNamespace(success=True, indices=[2, 3])

    fake_llm = SimpleNamespace(
        create_multimodal_message=lambda text, images: {"text": text, "images": images},
        generate_structured=fake_generate_structured,
    )
    monkeypatch.setattr(solver.importlib, "import_module", lambda name: fake_llm)

    config = _config(backend="zhenxun", zhenxun_model="Gemini/gemini-2.5-flash")
    result = solver._classification_result(config)
    output = await solver._classify_with_zhenxun_llm("pick cats", b"image-bytes", config, result)

    assert output["success"] is True
    assert output["indices"] == [2, 3]
