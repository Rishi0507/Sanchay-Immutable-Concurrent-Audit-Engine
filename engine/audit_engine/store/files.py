"""Content-addressed file storage (SHA-256). Files are stored, never executed (22.4)."""

from __future__ import annotations

import hashlib
import io
from pathlib import Path
from typing import Protocol


class FileStore(Protocol):
    def put(self, data: bytes) -> str: ...
    def get(self, file_hash: str) -> bytes: ...
    def exists(self, file_hash: str) -> bool: ...


class DirFileStore:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, h: str) -> Path:
        return self.root / h[:2] / h

    def put(self, data: bytes) -> str:
        h = hashlib.sha256(data).hexdigest()
        p = self._path(h)
        if not p.exists():
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".tmp")
            tmp.write_bytes(data)
            tmp.replace(p)
        return h

    def get(self, file_hash: str) -> bytes:
        p = self._path(file_hash)
        if not p.exists():
            raise FileNotFoundError(file_hash)
        data = p.read_bytes()
        if hashlib.sha256(data).hexdigest() != file_hash:
            raise ValueError(f"Stored file {file_hash} does not match its hash")
        return data

    def exists(self, file_hash: str) -> bool:
        return self._path(file_hash).exists()


class MinioFileStore:
    """minio://access:secret@host:port/bucket"""

    def __init__(self, url: str):
        from urllib.parse import urlparse

        from minio import Minio

        u = urlparse(url)
        self.bucket = u.path.strip("/") or "files"
        self.client = Minio(f"{u.hostname}:{u.port or 9000}", access_key=u.username, secret_key=u.password,
                            secure=False)

    def put(self, data: bytes) -> str:
        h = hashlib.sha256(data).hexdigest()
        if not self.exists(h):
            if not self.client.bucket_exists(self.bucket):
                self.client.make_bucket(self.bucket)
            self.client.put_object(self.bucket, h, io.BytesIO(data), len(data))
        return h

    def get(self, file_hash: str) -> bytes:
        resp = self.client.get_object(self.bucket, file_hash)
        try:
            data = resp.read()
        finally:
            resp.close()
            resp.release_conn()
        if hashlib.sha256(data).hexdigest() != file_hash:
            raise ValueError(f"Stored file {file_hash} does not match its hash")
        return data

    def exists(self, file_hash: str) -> bool:
        try:
            self.client.stat_object(self.bucket, file_hash)
            return True
        except Exception:
            return False


def open_file_store(spec: str) -> FileStore:
    if spec.startswith("dir:"):
        return DirFileStore(spec[4:])
    if spec.startswith("minio://"):
        return MinioFileStore(spec)
    return DirFileStore(spec)
