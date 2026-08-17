"""Download evxl.app's client JS chunks into tools/_bundle/.

evxl is a SvelteKit SPA that renders entirely client-side, so its benchmark registry
is only reachable by reading the shipped bundle. We fetch the HTML shell, find the
entry module, then pull every route/chunk it references.

This is a one-off build-time step, not a runtime dependency: the extracted registry is
committed to data/ so the app never needs evxl to be reachable.
"""

from __future__ import annotations

import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tools" / "_bundle"
BASE = "https://evxl.app"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": BASE + "/"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)

    html = get(BASE + "/").decode("utf-8", "replace")
    entries = sorted(set(re.findall(r"_app/immutable/entry/[A-Za-z0-9_.-]+\.js", html)))
    if not entries:
        print("could not find entry modules in the HTML shell", file=sys.stderr)
        return 1

    queue: list[str] = [f"_app/immutable/{e.split('_app/immutable/')[1]}" for e in entries]
    seen: set[str] = set()

    while queue:
        rel = queue.pop()
        if rel in seen:
            continue
        seen.add(rel)

        try:
            body = get(f"{BASE}/{rel}").decode("utf-8", "replace")
        except Exception as exc:
            print(f"  !! {rel}: {exc}", file=sys.stderr)
            continue

        (OUT / rel.split("_app/immutable/")[1].replace("/", "_")).write_text(
            body, encoding="utf-8"
        )

        # Chunks reference siblings with relative "../nodes/x.js" specifiers.
        for ref in re.findall(r"\.\./(?:nodes|chunks)/[A-Za-z0-9_.-]+\.js", body):
            queue.append("_app/immutable/" + ref.replace("../", ""))

        time.sleep(0.05)

    print(f"downloaded {len(seen)} modules -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
