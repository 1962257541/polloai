from __future__ import annotations

import base64
import importlib
import os
import sys
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field


CAPTCHA_SYSTEM_PROMPT = """\
You solve Doubao drag captcha challenges.
The screenshot shows a text prompt and a grid of candidate images.
Images are numbered from 1 to 9, left to right, top to bottom.

Return strict JSON only:
{"success": true, "indices": [1, 5, 8]}

If you cannot determine the answer, return:
{"success": false, "indices": []}
"""


class SolveRequest(BaseModel):
    prompt: str = ""
    image_base64: str
    image_mime: str = "image/png"


class CaptchaSolution(BaseModel):
    success: bool = Field(..., description="Whether the captcha was recognized.")
    indices: list[int] = Field(..., description="1-based image indices to drag.")


app = FastAPI(title="zhenxun captcha solver bridge")


def _extend_import_path() -> None:
    raw_path = (
        os.environ.get("CAPTCHA_BRIDGE_IMPORT_PATH", "").strip()
        or os.environ.get("DOUBAO_CAPTCHA_ZHENXUN_IMPORT_PATH", "").strip()
    )
    if not raw_path:
        return
    for value in [part.strip() for part in raw_path.split(";") if part.strip()]:
        path = Path(value).expanduser()
        try:
            resolved = path.resolve()
        except Exception:
            resolved = path
        candidate = resolved.parent if resolved.name == "ai_creation" else resolved
        if str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))


def _load_zhenxun_llm():
    _extend_import_path()
    llm = importlib.import_module("zhenxun.services.llm")
    return getattr(llm, "create_multimodal_message"), getattr(llm, "generate_structured")


def _bridge_api_key() -> str:
    return os.environ.get("CAPTCHA_BRIDGE_API_KEY", "").strip()


def _bridge_model() -> str:
    model = (
        os.environ.get("CAPTCHA_BRIDGE_MODEL", "").strip()
        or os.environ.get("DOUBAO_CAPTCHA_ZHENXUN_MODEL", "").strip()
    )
    if model:
        return model
    try:
        _extend_import_path()
        from ai_creation.config import base_config

        return str(base_config.get("auxiliary_llm_model") or "").strip()
    except Exception:
        return ""


def _dump_solution(solution: Any) -> dict[str, Any]:
    if hasattr(solution, "model_dump"):
        return solution.model_dump()
    if hasattr(solution, "dict"):
        return solution.dict()
    if isinstance(solution, dict):
        return solution
    return {
        "success": bool(getattr(solution, "success", False)),
        "indices": list(getattr(solution, "indices", []) or []),
    }


@app.post("/solve")
async def solve(request: SolveRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    api_key = _bridge_api_key()
    if api_key and authorization != f"Bearer {api_key}":
        raise HTTPException(status_code=401, detail="Invalid bridge API key.")

    try:
        image_bytes = base64.b64decode(request.image_base64)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid image_base64: {exc}") from exc

    create_multimodal_message, generate_structured = _load_zhenxun_llm()
    message = create_multimodal_message(
        text=f"Question: '{request.prompt or ''}'",
        images=[image_bytes],
    )
    kwargs: dict[str, Any] = {
        "response_model": CaptchaSolution,
        "instruction": CAPTCHA_SYSTEM_PROMPT,
    }
    model = _bridge_model()
    if model:
        kwargs["model"] = model
    solution = await generate_structured(message, **kwargs)
    data = _dump_solution(solution)
    data["success"] = bool(data.get("success") is not False and data.get("indices"))
    return data


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "zhenxun_captcha_solver_bridge:app",
        host=os.environ.get("CAPTCHA_BRIDGE_HOST", "0.0.0.0"),
        port=int(os.environ.get("CAPTCHA_BRIDGE_PORT", "8765")),
    )
