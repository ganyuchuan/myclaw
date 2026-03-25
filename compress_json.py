#!/usr/bin/env python3
"""Minify JSON files by removing insignificant whitespace."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compress (minify) a JSON file into compact one-line JSON."
    )
    parser.add_argument("input", type=Path, help="Input JSON file path")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Output file path (default: <input>.min.json)",
    )
    parser.add_argument(
        "--in-place",
        action="store_true",
        help="Overwrite the input file directly",
    )
    parser.add_argument(
        "--sort-keys",
        action="store_true",
        help="Sort object keys for deterministic output",
    )
    args = parser.parse_args()

    if args.in_place and args.output is not None:
        parser.error("--in-place cannot be used together with --output")

    return args


def get_output_path(input_path: Path, output: Path | None, in_place: bool) -> Path:
    if in_place:
        return input_path
    if output is not None:
        return output
    return input_path.with_name(f"{input_path.stem}.min.json")


def main() -> int:
    args = parse_args()
    input_path: Path = args.input

    if not input_path.exists():
        print(f"Error: input file not found: {input_path}", file=sys.stderr)
        return 1

    if not input_path.is_file():
        print(f"Error: input path is not a file: {input_path}", file=sys.stderr)
        return 1

    output_path = get_output_path(input_path, args.output, args.in_place)

    try:
        with input_path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as exc:
        print(
            f"Error: invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}",
            file=sys.stderr,
        )
        return 1
    except OSError as exc:
        print(f"Error: unable to read input file: {exc}", file=sys.stderr)
        return 1

    compact_json = json.dumps(
        data,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=args.sort_keys,
    )

    try:
        with output_path.open("w", encoding="utf-8") as f:
            f.write(compact_json)
            f.write("\n")
    except OSError as exc:
        print(f"Error: unable to write output file: {exc}", file=sys.stderr)
        return 1

    print(f"Compressed JSON written to: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
