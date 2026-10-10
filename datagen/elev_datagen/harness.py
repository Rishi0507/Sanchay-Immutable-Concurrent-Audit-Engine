"""Build an audit engine over a generated dataset directory (fixture mode)."""

from __future__ import annotations

import tomllib
from pathlib import Path

from audit_engine.config import Settings
from audit_engine.engine import Engine


def engine_for(dataset_dir: str | Path, audit_db: str | Path, output_dir: str | Path | None = None) -> Engine:
    ds = Path(dataset_dir)
    s = Settings(
        audit_db_url=f"sqlite:///{Path(audit_db).as_posix()}",
        business_source=f"fixture:{(ds / 'fixture').as_posix()}",
        files=f"dir:{(ds / 'files').as_posix()}",
        output_dir=str(output_dir or (Path(audit_db).parent / "outputs")),
    )
    company = ds / "company.toml"
    if company.exists():
        s.company = tomllib.loads(company.read_text(encoding="utf-8"))
    return Engine(settings=s)
