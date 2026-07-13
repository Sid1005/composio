"""
Browser verification — the second, independent extraction pass described in
browser-check.md.

Renders the same pages pass-1 cited with a real Chromium (Playwright), takes
screenshots, and asks DeepSeek to independently re-derive answers to the same
schema fields purely from that rendered evidence — not from trusting pass-1's
claims — then diffs against pass-1's findings. Purely observational: it reads
pages, it does not fill in forms or click through signup/behavioral probes
(that was deliberately scoped out, see browser-check.md).

Usage:
    python3 browser_check.py <app_id> [<app_id> ...]
    python3 browser_check.py --sample   # runs every app_id in sample.md
"""

import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import jsonschema
from dotenv import load_dotenv
from openai import OpenAI
from playwright.sync_api import sync_playwright

from agent import ROOT, OPENCODE_API_KEY, OPENCODE_BASE_URL, MODEL, prune_unknown_properties, parse_tool_arguments
from verification_schema_tool import SUBMIT_BROWSER_VERIFICATION_TOOL

load_dotenv()

RESEARCH_DIR = ROOT / "data" / "apps"
VERIFICATION_DIR = ROOT / "data" / "verification"
SCREENSHOT_DIR = ROOT / "data" / "screenshots"
VERIFICATION_SCHEMA_PATH = ROOT / "schemas" / "app-verification.schema.json"

MAX_PAGES = 6
PAGE_TEXT_CHARS = 6000
PRIORITY_SOURCE_TYPES = [
    "official_auth_docs",
    "official_pricing",
    "official_api_docs",
    "official_mcp_docs",
    "official_product_page",
    "official_help_center",
    "official_changelog",
    "official_github",
    "composio_catalogue",
    "secondary_source",
]

CHECK_FIELDS = [
    "classification.researched_category",
    "authentication.methods",
    "access.credential_access",
    "api_surface.public_api_and_breadth",
    "agent_interface.mcp",
    "buildability.verdict",
]

SYSTEM_PROMPT = """You are an independent verifier. You are given:
1. A pass-1 research agent's claimed findings about a third-party app (as JSON).
2. The actual rendered text content of the primary source pages, captured just \
now with a real browser (not a text-scraper — this sees the true rendered DOM, \
including things like pricing-matrix checkmarks that text-scraping can miss).

Your job is to independently judge, for each field in the checklist, whether \
the pass-1 claim is confirmed, contradicted, or something in between — based \
ONLY on the rendered page content you were given, not on trusting pass-1's \
claim. If the rendered pages don't cover a field at all, mark it inconclusive \
rather than guessing.

Checklist fields:
- classification.researched_category — is the category/one-liner accurate?
- authentication.methods — do the rendered docs actually describe these auth methods?
- access.credential_access — does the rendered pricing/signup page support the \
self-serve/gated claim? Look carefully at plan comparison tables — checkmarks \
and feature availability by plan are exactly the kind of thing pass-1's \
text-scraping could have gotten wrong or missed.
- api_surface.public_api_and_breadth — does the rendered docs page support the \
claimed API surface and breadth?
- agent_interface.mcp — does the rendered content confirm an MCP server exists \
(official/community/none)?
- buildability.verdict — given everything rendered, does the verdict hold up?

Only propose a correction if the rendered evidence actually contradicts or \
materially undermines a claim. If you simply can't verify something from what \
was rendered, use result='inconclusive', not a correction.

Call submit_browser_verification exactly once when done.
"""


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def load_research_record(app_id: str) -> dict:
    path = RESEARCH_DIR / f"{app_id}-research.json"
    if not path.exists():
        raise FileNotFoundError(f"No pass-1 research record for '{app_id}' at {path}")
    return json.loads(path.read_text())


def pick_target_urls(record: dict) -> list[dict]:
    sources = record.get("sources", {})
    scored = []
    for source_id, source in sources.items():
        priority = PRIORITY_SOURCE_TYPES.index(source["source_type"]) if source["source_type"] in PRIORITY_SOURCE_TYPES else 99
        scored.append((priority, source_id, source))
    scored.sort(key=lambda t: t[0])

    seen_urls = set()
    picked = []
    for _, source_id, source in scored:
        if source["url"] in seen_urls:
            continue
        seen_urls.add(source["url"])
        picked.append(source)
        if len(picked) >= MAX_PAGES:
            break
    return picked


def render_pages(app_id: str, urls: list[dict]) -> list[dict]:
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    rendered = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1400, "height": 1000})

        for i, source in enumerate(urls, 1):
            url = source["url"]
            entry = {"url": url, "source_type": source["source_type"], "ok": False}
            try:
                page.goto(url, timeout=25000, wait_until="load")
                page.wait_for_timeout(1000)  # let client-rendered content settle
                text = page.inner_text("body")
                entry["text"] = text[:PAGE_TEXT_CHARS]

                screenshot_path = SCREENSHOT_DIR / f"{app_id}-{i}.png"
                page.screenshot(path=str(screenshot_path), full_page=False)
                entry["screenshot_path"] = str(screenshot_path.relative_to(ROOT))
                entry["ok"] = True
            except Exception as e:  # noqa: BLE001
                entry["error"] = f"{type(e).__name__}: {e}"
                print(f"  render FAILED for {url}: {entry['error']}", file=sys.stderr)

            rendered.append(entry)
            print(f"  rendered [{i}/{len(urls)}] {url} ok={entry['ok']}", file=sys.stderr)

        browser.close()

    return rendered


def build_user_prompt(record: dict, rendered: list[dict]) -> str:
    findings_summary = json.dumps(record["findings"], indent=2)

    pages_section = []
    for r in rendered:
        if r["ok"]:
            pages_section.append(f"### Rendered page: {r['url']} ({r['source_type']})\n{r['text']}")
        else:
            pages_section.append(f"### Rendered page: {r['url']} — FAILED TO LOAD ({r.get('error')})")

    return f"""App: {record['app_id']}

## Pass-1 claimed findings (JSON)
{findings_summary}

## Checklist fields to verify
{chr(10).join(f"- {f}" for f in CHECK_FIELDS)}

## Freshly rendered page content
{chr(10).join(pages_section)}
"""


def load_verification_schema() -> dict:
    return json.loads(VERIFICATION_SCHEMA_PATH.read_text())


def run_browser_check(app_id: str) -> Path:
    print(f"\n=== browser check: {app_id} ===", file=sys.stderr)
    record = load_research_record(app_id)
    target_sources = pick_target_urls(record)
    if not target_sources:
        raise RuntimeError(f"{app_id}: pass-1 record has no sources to verify against")

    rendered = render_pages(app_id, target_sources)
    ok_count = sum(1 for r in rendered if r["ok"])
    if ok_count == 0:
        raise RuntimeError(f"{app_id}: all {len(rendered)} page renders failed")

    client = OpenAI(api_key=OPENCODE_API_KEY, base_url=OPENCODE_BASE_URL)
    user_prompt = build_user_prompt(record, rendered)

    last_error = None
    args = None
    for attempt in range(1, 4):
        try:
            response = client.chat.completions.create(
                model=MODEL,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                # NOTE: forced tool_choice is broken on this gateway (400 "Upstream
                # request failed", see agent.py). "auto" with only one tool offered
                # has the same effect and works.
                tools=[SUBMIT_BROWSER_VERIFICATION_TOOL],
                tool_choice="auto",
                max_tokens=9000,
            )
        except Exception as e:  # noqa: BLE001
            last_error = f"API error: {e}"
            print(f"  DeepSeek call failed (attempt {attempt}/3): {e}", file=sys.stderr)
            if attempt < 3:
                time.sleep(10 * attempt)
            continue

        msg = response.choices[0].message
        if not msg.tool_calls:
            last_error = "model did not call submit_browser_verification"
            print(f"  {last_error} (attempt {attempt}/3)", file=sys.stderr)
            if attempt < 3:
                time.sleep(5)
            continue

        args = parse_tool_arguments(msg.tool_calls[0].function.arguments, "submit_browser_verification")
        if args:
            break
        last_error = "could not parse submit_browser_verification arguments (likely truncated)"
        print(f"  {last_error} (attempt {attempt}/3)", file=sys.stderr)
        if attempt < 3:
            time.sleep(5)

    if not args:
        raise RuntimeError(f"{app_id}: failed after 3 attempts: {last_error}")

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # attach screenshot_path to checks whose source_url matches a rendered page
    url_to_screenshot = {r["url"]: r.get("screenshot_path") for r in rendered if r["ok"]}
    checks = []
    for c in args.get("checks", []):
        check = dict(c)
        su = check.get("source_url")
        if su and su in url_to_screenshot and url_to_screenshot[su]:
            check["screenshot_path"] = url_to_screenshot[su]
        checks.append(check)

    verification_record = {
        "schema_version": "1.0",
        "app_id": app_id,
        "initial_research_path": str((RESEARCH_DIR / f"{app_id}-research.json").relative_to(ROOT)),
        "browser_verification": {
            "sampled": True,
            "result": args["overall_result"],
            "checked_at": now,
            "checks": checks,
            "screenshots": [r["screenshot_path"] for r in rendered if r.get("ok") and r.get("screenshot_path")],
        },
        "human_review": {
            "sample_group": "not_sampled",
            "result": "not_sampled",
            "checks": [],
            "reviewed_at": None,
        },
        "corrections": [
            {
                "field": c["field"],
                "initial_value": c["initial_value"],
                "final_value": c["final_value"],
                "caught_by": "browser_verification",
                "reason": c["reason"],
                "evidence": c["evidence"],
                "corrected_at": now,
            }
            for c in args.get("corrections", [])
        ],
    }

    schema = load_verification_schema()
    resolver = jsonschema.RefResolver.from_schema(schema)
    verification_record = prune_unknown_properties(verification_record, schema, resolver)
    jsonschema.validate(instance=verification_record, schema=schema)

    VERIFICATION_DIR.mkdir(parents=True, exist_ok=True)
    out_path = VERIFICATION_DIR / f"{app_id}-verification.json"
    out_path.write_text(json.dumps(verification_record, indent=2))
    print(f"=== VALID — wrote {out_path.relative_to(ROOT)} (result={args['overall_result']}, "
          f"{len(args.get('corrections', []))} corrections) ===", file=sys.stderr)
    return out_path


SAMPLE_APP_IDS = [
    "attio", "pylon", "pumble", "systeme-io", "fanbasis", "mrscraper", "neo4j",
    "linear", "paygent-connect", "reducto", "salesforce", "twenty", "dealcloud",
    "plain", "waterfall-io",
]

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--sample":
        app_ids = SAMPLE_APP_IDS
    else:
        app_ids = sys.argv[1:]

    if not app_ids:
        print("usage: python3 browser_check.py <app_id> [<app_id> ...] | --sample", file=sys.stderr)
        sys.exit(1)

    failures = []
    for app_id in app_ids:
        try:
            run_browser_check(app_id)
        except Exception as e:  # noqa: BLE001
            print(f"FAILED {app_id}: {e}", file=sys.stderr)
            failures.append((app_id, str(e)))

    if failures:
        print(f"\n{len(failures)} failures: {failures}", file=sys.stderr)
        sys.exit(1)
