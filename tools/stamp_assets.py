#!/usr/bin/env python3
"""Stamp local CSS/JS references in index.html with a content hash.

    python3 tools/stamp_assets.py          rewrite index.html in place
    python3 tools/stamp_assets.py --check  exit 1 if any reference is stale

``<script src="js/core.js?v=anything">`` becomes ``js/core.js?v=<8 hex chars>``,
where the hash comes from the file contents, so browsers (and the Telegram
WebView) refetch a file exactly when it changes and never otherwise. Vercel runs
this at build time (see vercel.json); CI runs it with --check.
"""
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"
REF = re.compile(r'(?P<attr>\b(?:href|src)=")(?P<path>[^"?#:]+\.(?:css|js))(?:\?v=[^"]*)?(?P<end>")')


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:8]


def stamp(html: str) -> str:
    def repl(match: re.Match) -> str:
        target = ROOT / match.group("path")
        if not target.is_file():
            return match.group(0)
        return f'{match.group("attr")}{match.group("path")}?v={digest(target)}{match.group("end")}'

    return REF.sub(repl, html)


def main(argv: list[str]) -> int:
    html = INDEX.read_text(encoding="utf-8")
    stamped = stamp(html)
    if "--check" in argv:
        if stamped != html:
            print("index.html asset versions are stale: run python3 tools/stamp_assets.py")
            return 1
        print("asset versions are up to date")
        return 0
    if stamped != html:
        INDEX.write_text(stamped, encoding="utf-8")
        print("index.html updated")
    else:
        print("index.html already up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
