"""Runtime settings from the environment, and thresholds from one file (DT-6)."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

_DEFAULT_THRESHOLDS = Path(__file__).with_name("thresholds.toml")


@lru_cache(maxsize=4)
def load_thresholds(path: str | None = None) -> dict:
    p = Path(path or os.environ.get("ENGINE_THRESHOLDS") or _DEFAULT_THRESHOLDS)
    with p.open("rb") as fh:
        return tomllib.load(fh)


@dataclass
class Settings:
    audit_db_url: str = "sqlite:///var/audit.db"
    business_source: str = "fixture:var/fixture"
    files: str = "dir:var/files"
    output_dir: str = "var/outputs"
    ledger_url: str | None = None
    ollama_url: str | None = None
    ollama_model: str = "llama3.2:3b"
    detector_workers: int = 0
    service_token: str | None = None
    company: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "Settings":
        db = os.environ.get("DATABASE_URL")
        files_dir = os.environ.get("FILES_DIR")
        s = cls(
            audit_db_url=os.environ.get("ENGINE_AUDIT_DB") or db or cls.audit_db_url,
            business_source=os.environ.get("ENGINE_BUSINESS_SOURCE") or db or cls.business_source,
            files=os.environ.get("ENGINE_FILES") or (f"dir:{files_dir}" if files_dir else cls.files),
            service_token=os.environ.get("SERVICE_TOKEN") or None,
            output_dir=os.environ.get("ENGINE_OUTPUT_DIR", cls.output_dir),
            ledger_url=os.environ.get("LEDGER_URL") or None,
            ollama_url=os.environ.get("OLLAMA_URL") or None,
            ollama_model=os.environ.get("OLLAMA_MODEL", cls.ollama_model),
            detector_workers=int(os.environ.get("ENGINE_DETECTOR_WORKERS", "0")),
        )
        company_file = os.environ.get("ENGINE_COMPANY_FILE") or (
            os.path.join(files_dir, "company.toml") if files_dir else None)
        if company_file and Path(company_file).exists():
            with open(company_file, "rb") as fh:
                s.company = tomllib.load(fh)
        return s
