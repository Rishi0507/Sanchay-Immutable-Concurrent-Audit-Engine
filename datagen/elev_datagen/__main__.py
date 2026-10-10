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
    g.add_argument("--mcp-url", default=None, help="Load through the MCP client tools instead of the emulator")
    g.add_argument("--token", default=None, help="client_employee bearer token for --mcp-url")
    args = ap.parse_args(argv)

    if args.cmd == "generate":
        from .generate import generate

        sink = None
        if args.mcp_url:
            from .mcp_sink import McpSink

            sink = McpSink(args.mcp_url, args.token, args.out)
        meta = generate(args.out, args.dataset, args.seed, args.scale, sink=sink)
        json.dump(meta, sys.stdout, indent=2)
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
