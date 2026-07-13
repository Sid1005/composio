"""
Batch runner for the pass-1 research agent across all 100 apps.

Skips apps that already have a data/apps/<app_id>-research.json (so it's
safe to re-run after a partial batch or after adding new apps). Runs with
bounded concurrency (agent.run_agent is network I/O bound — search/scrape
calls and DeepSeek completions — so threads are enough, no need for
multiprocessing). Retries each app up to RETRIES times on failure before
giving up and logging it.

Usage:
    python3 run_batch.py [--workers N] [--limit N]

Progress and failures are appended to logs/batch-progress.jsonl as each
app finishes, so you can tail it to watch the run live.
"""

import argparse
import json
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

from apps_list import APPS
from agent import run_agent, slugify, ROOT, DATA_DIR, LOG_DIR

RETRIES = 3
RETRY_BACKOFF_S = 15

PROGRESS_PATH = LOG_DIR / "batch-progress.jsonl"
_progress_lock = Lock()


def log_progress(event: dict):
    event["ts"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with _progress_lock:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with PROGRESS_PATH.open("a") as f:
            f.write(json.dumps(event) + "\n")


def already_done(app_name: str) -> bool:
    return (DATA_DIR / f"{slugify(app_name)}-research.json").exists()


def process_app(app_name: str, app_url: str) -> dict:
    app_id = slugify(app_name)

    if already_done(app_name):
        return {"app": app_name, "app_id": app_id, "status": "skipped_existing"}

    last_error = None
    for attempt in range(1, RETRIES + 1):
        try:
            path = run_agent(app_name, app_url)
            log_progress({"app": app_name, "app_id": app_id, "status": "ok", "attempt": attempt, "path": str(path)})
            return {"app": app_name, "app_id": app_id, "status": "ok", "attempt": attempt}
        except Exception as e:  # noqa: BLE001
            last_error = f"{type(e).__name__}: {e}"
            log_progress(
                {
                    "app": app_name,
                    "app_id": app_id,
                    "status": "retry" if attempt < RETRIES else "failed",
                    "attempt": attempt,
                    "error": last_error,
                }
            )
            if attempt < RETRIES:
                time.sleep(RETRY_BACKOFF_S)

    return {"app": app_name, "app_id": app_id, "status": "failed", "error": last_error}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=5)
    parser.add_argument("--limit", type=int, default=None, help="only process the first N pending apps (for testing)")
    args = parser.parse_args()

    pending = [(name, url) for name, url in APPS if not already_done(name)]
    if args.limit:
        pending = pending[: args.limit]

    print(f"{len(APPS)} total apps, {len(APPS) - len(pending)} already done, {len(pending)} to run "
          f"with {args.workers} workers", file=sys.stderr)

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(process_app, name, url): name for name, url in pending}
        for i, future in enumerate(as_completed(futures), 1):
            name = futures[future]
            try:
                result = future.result()
            except Exception:  # noqa: BLE001
                result = {"app": name, "status": "crashed", "error": traceback.format_exc()}
            results.append(result)
            print(f"[{i}/{len(pending)}] {name}: {result['status']}", file=sys.stderr)

    ok = [r for r in results if r["status"] == "ok"]
    skipped = [r for r in results if r["status"] == "skipped_existing"]
    failed = [r for r in results if r["status"] in ("failed", "crashed")]

    summary = {
        "total_apps": len(APPS),
        "processed": len(results),
        "ok": len(ok),
        "skipped_existing": len(skipped),
        "failed": len(failed),
        "failed_apps": [{"app": r["app"], "error": r.get("error")} for r in failed],
    }
    summary_path = LOG_DIR / "batch-summary.json"
    summary_path.write_text(json.dumps(summary, indent=2))
    print(f"\n=== DONE: {len(ok)} ok, {len(skipped)} skipped, {len(failed)} failed ===", file=sys.stderr)
    print(f"summary written to {summary_path}", file=sys.stderr)
    if failed:
        print("FAILED APPS:", [r["app"] for r in failed], file=sys.stderr)


if __name__ == "__main__":
    main()
