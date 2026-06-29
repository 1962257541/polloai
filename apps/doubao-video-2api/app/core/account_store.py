import json
from pathlib import Path
from typing import Any, Optional

from loguru import logger

try:
    import psycopg
except ImportError:  # pragma: no cover - database persistence is optional.
    psycopg = None


VALID_BACKENDS = {"auto", "file", "database"}


def normalize_backend(value: str | None) -> str:
    backend = str(value or "auto").strip().lower()
    return backend if backend in VALID_BACKENDS else "auto"


def account_store_location(
    *,
    file_path: str,
    backend: str,
    database_url: Optional[str],
    store_key: str,
) -> dict[str, Any]:
    effective = _effective_backend(backend, database_url)
    return {
        "backend": effective,
        "configured_backend": normalize_backend(backend),
        "path": str(file_path),
        "database_key": store_key if effective == "database" else None,
        "database_available": bool(database_url and psycopg is not None),
    }


def load_account_records(
    *,
    file_path: str,
    backend: str,
    database_url: Optional[str],
    store_key: str,
) -> list[dict[str, Any]]:
    configured = normalize_backend(backend)
    if configured in {"auto", "database"} and database_url:
        try:
            records = _load_database_records(database_url, store_key)
            if records or configured == "database":
                return records
        except Exception as exc:
            if configured == "database":
                logger.warning(f"Unable to read Doubao account store from database: {exc}")
                return []
            logger.warning(f"Unable to read Doubao account store from database, falling back to file: {exc}")

    return _load_file_records(Path(file_path))


def save_account_records(
    records: list[dict[str, Any]],
    *,
    file_path: str,
    backend: str,
    database_url: Optional[str],
    store_key: str,
) -> None:
    configured = normalize_backend(backend)
    if configured in {"auto", "database"} and database_url:
        try:
            _save_database_records(database_url, store_key, records)
            return
        except Exception as exc:
            if configured == "database":
                raise OSError(f"database account store is unavailable: {exc}") from exc
            logger.warning(f"Unable to write Doubao account store to database, falling back to file: {exc}")

    _save_file_records(Path(file_path), records)


def _effective_backend(backend: str, database_url: Optional[str]) -> str:
    configured = normalize_backend(backend)
    if configured == "database":
        return "database"
    if configured == "auto" and database_url and psycopg is not None:
        return "database"
    return "file"


def _load_file_records(path: Path) -> list[dict[str, Any]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (json.JSONDecodeError, OSError):
        return []

    records = payload.get("accounts") if isinstance(payload, dict) else payload
    if not isinstance(records, list):
        return []
    return [dict(record) for record in records if isinstance(record, dict)]


def _save_file_records(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"version": 1, "accounts": records}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _load_database_records(database_url: str, store_key: str) -> list[dict[str, Any]]:
    if psycopg is None:
        raise RuntimeError("psycopg is not installed")

    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT "valuePlain" FROM "SystemConfig" WHERE "key" = %s', (store_key,))
            row = cur.fetchone()

    if not row or not row[0]:
        return []
    payload = json.loads(str(row[0]))
    records = payload.get("accounts") if isinstance(payload, dict) else payload
    if not isinstance(records, list):
        return []
    return [dict(record) for record in records if isinstance(record, dict)]


def _save_database_records(database_url: str, store_key: str, records: list[dict[str, Any]]) -> None:
    if psycopg is None:
        raise RuntimeError("psycopg is not installed")

    payload = json.dumps({"version": 1, "accounts": records}, ensure_ascii=False)
    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO "SystemConfig"
                    ("key", "category", "isSecret", "valuePlain", "updatedBy", "createdAt", "updatedAt")
                VALUES
                    (%s, 'doubao-video-2api', TRUE, %s, 'doubao-video-2api', NOW(), NOW())
                ON CONFLICT ("key") DO UPDATE SET
                    "category" = EXCLUDED."category",
                    "isSecret" = TRUE,
                    "valuePlain" = EXCLUDED."valuePlain",
                    "updatedBy" = EXCLUDED."updatedBy",
                    "updatedAt" = NOW()
                """,
                (store_key, payload),
            )
        conn.commit()
