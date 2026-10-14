"""Save generated text to output/<generator>-<timestamp>.txt."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

SEPARATOR = "\n\n" + "=" * 40 + "\n\n"


def add_args(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--out-dir", default="output",
                    help="folder the generated text is saved to (default: output/)")
    ap.add_argument("--no-save", action="store_true",
                    help="only print, don't write a .txt file")


def save(name: str, texts: list[str], args: argparse.Namespace) -> Path | None:
    if args.no_save or not texts:
        return None
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{name}-{time.strftime('%Y%m%d-%H%M%S')}.txt"
    path.write_text(SEPARATOR.join(t.strip() for t in texts) + "\n", encoding="utf-8")
    print(f"saved {path}", file=sys.stderr)
    return path
