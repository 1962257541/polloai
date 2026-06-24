import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from loguru import logger


router = APIRouter(prefix="/v1", tags=["admin"])

api_key_records_cache: Optional[list[dict[str, Any]]] = None
api_key_records_cache_mtime: Optional[float] = None
api_key_records_cache_path: Optional[Path] = None


def _api_key_store_path() -> Path:
    return Path(os.getenv("API_KEY_STORE_PATH", ".generated/api_keys.json"))


def _api_key_digest(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _api_key_fingerprint(secret: str) -> str:
    return _api_key_digest(secret)[:12]


def _load_api_key_records() -> list[dict[str, Any]]:
    global api_key_records_cache, api_key_records_cache_mtime, api_key_records_cache_path

    path = _api_key_store_path()
    try:
        mtime = path.stat().st_mtime
    except FileNotFoundError:
        api_key_records_cache = []
        api_key_records_cache_mtime = None
        api_key_records_cache_path = path
        return []

    if (
        api_key_records_cache is not None
        and api_key_records_cache_mtime == mtime
        and api_key_records_cache_path == path
    ):
        return [dict(record) for record in api_key_records_cache]

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        logger.warning(f"Unable to read API key store: {path}")
        payload = {}

    records = payload.get("keys") if isinstance(payload, dict) else payload
    if not isinstance(records, list):
        records = []

    api_key_records_cache = [dict(record) for record in records if isinstance(record, dict)]
    api_key_records_cache_mtime = mtime
    api_key_records_cache_path = path
    return [dict(record) for record in api_key_records_cache]


def _save_api_key_records(records: list[dict[str, Any]]) -> None:
    global api_key_records_cache, api_key_records_cache_mtime, api_key_records_cache_path

    path = _api_key_store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"keys": records}, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        api_key_records_cache_mtime = path.stat().st_mtime
    except FileNotFoundError:
        api_key_records_cache_mtime = None
    api_key_records_cache = [dict(record) for record in records]
    api_key_records_cache_path = path


def generated_api_key_valid(secret: str) -> bool:
    if not secret:
        return False
    digest = _api_key_digest(secret)
    for record in _load_api_key_records():
        if record.get("disabled"):
            continue
        if hmac.compare_digest(str(record.get("hash") or ""), digest):
            return True
    return False


_generated_api_key_valid = generated_api_key_valid


def _public_api_key(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": record.get("id"),
        "name": record.get("name") or "Unnamed Key",
        "prefix": record.get("prefix"),
        "fingerprint": record.get("fingerprint"),
        "disabled": bool(record.get("disabled")),
        "created_at": record.get("created_at"),
    }


def _api_key_by_id(records: list[dict[str, Any]], key_id: str) -> dict[str, Any]:
    for record in records:
        if record.get("id") == key_id:
            return record
    raise HTTPException(status_code=404, detail="API key not found.")


def _bool_value(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


@router.get("/api-keys", response_class=JSONResponse)
async def list_api_keys():
    records = _load_api_key_records()
    return JSONResponse(content={"object": "api_key_list", "data": [_public_api_key(record) for record in records]})


@router.post("/api-keys", response_class=JSONResponse)
async def create_api_key(request: Request):
    data = await request.json()
    name = str(data.get("name") or "").strip() or "Unnamed Key"
    secret = f"sk-doubao-{secrets.token_urlsafe(32)}"
    now = time.time()
    record = {
        "id": secrets.token_hex(8),
        "name": name[:80],
        "hash": _api_key_digest(secret),
        "prefix": secret[:18],
        "fingerprint": _api_key_fingerprint(secret),
        "disabled": False,
        "created_at": now,
    }

    records = _load_api_key_records()
    records.append(record)
    try:
        _save_api_key_records(records)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Unable to write API key store: {exc}") from exc

    return JSONResponse(content={"object": "api_key", "data": {**_public_api_key(record), "secret": secret}})


@router.patch("/api-keys/{key_id}", response_class=JSONResponse)
async def update_api_key(key_id: str, request: Request):
    data = await request.json()
    records = _load_api_key_records()
    record = _api_key_by_id(records, key_id)
    if "name" in data:
        record["name"] = str(data.get("name") or "").strip()[:80] or "Unnamed Key"
    if "disabled" in data:
        record["disabled"] = _bool_value(data.get("disabled"), False)
    try:
        _save_api_key_records(records)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Unable to write API key store: {exc}") from exc
    return JSONResponse(content={"object": "api_key", "data": _public_api_key(record)})


@router.post("/api-keys/{key_id}/enable", response_class=JSONResponse)
async def enable_api_key(key_id: str):
    records = _load_api_key_records()
    record = _api_key_by_id(records, key_id)
    record["disabled"] = False
    try:
        _save_api_key_records(records)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Unable to write API key store: {exc}") from exc
    return JSONResponse(content={"object": "api_key", "data": _public_api_key(record)})


@router.post("/api-keys/{key_id}/disable", response_class=JSONResponse)
async def disable_api_key(key_id: str):
    records = _load_api_key_records()
    record = _api_key_by_id(records, key_id)
    record["disabled"] = True
    try:
        _save_api_key_records(records)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Unable to write API key store: {exc}") from exc
    return JSONResponse(content={"object": "api_key", "data": _public_api_key(record)})


@router.delete("/api-keys/{key_id}", response_class=JSONResponse)
async def delete_api_key(key_id: str):
    records = _load_api_key_records()
    _api_key_by_id(records, key_id)
    records = [record for record in records if record.get("id") != key_id]
    try:
        _save_api_key_records(records)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Unable to write API key store: {exc}") from exc
    return JSONResponse(content={"object": "api_key_deleted", "id": key_id})
