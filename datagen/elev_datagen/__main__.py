"""Command line: python -m elev_datagen <command>."""

from __future__ import annotations

import argparse
import json
import sys


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="elev_datagen")
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate", help="Generate a dataset into a directory")
    g.add_argument("--dataset", choices=["clean", "planted"], default="planted")
    g.add_argument("--seed", type=int, default=7)
    g.add_argument("--scale", type=float, default=1.0)
    g.add_argument("--out", required=True)
    g.add_argument("--mcp-url", default=None, help="Load through the client tools of a running system, for example "
                                                   "http://localhost:8080")
    g.add_argument("--token", default="client-demo-token", help="client_employee bearer token for --mcp-url")
    r = sub.add_parser("respond", help="As the client, upload evidence for every pending request")
    r.add_argument("--mcp-url", default="http://localhost:8080")
    r.add_argument("--token", default="client-demo-token")
    r.add_argument("--dataset", required=True, help="Directory written by generate, the client's own records")
    r.add_argument("--plant", action="store_true", help="Plant forged and reused documents among the uploads")
    args = ap.parse_args(argv)
    if args.cmd == "respond":
        from .respond import respond

        out = respond(args.mcp_url, args.token, args.dataset, plant=args.plant)
        json.dump(out, sys.stdout, indent=2)
        print()
        return 0

    if args.cmd == "generate":
        from .generate import generate

        sink = None
        if args.mcp_url:
            from .mcp_sink import McpSink

            from .generate import FixtureSink

            sink = McpSink(args.mcp_url, args.token, args.out, tee=FixtureSink(args.out))
        meta = generate(args.out, args.dataset, args.seed, args.scale, sink=sink)
        if args.mcp_url:
            from .mcp_sink import upload_file

            from pathlib import Path

            upload_file(args.mcp_url, args.token, (Path(args.out) / "company.toml").read_bytes(), "company.toml")
        json.dump(meta, sys.stdout, indent=2)
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
