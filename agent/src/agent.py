"""
Pass-1 research agent.

Brain: DeepSeek v4-flash, via the opencode.ai zen/go OpenAI-compatible gateway.
Hands: Composio SDK, COMPOSIO_SEARCH toolkit (Tavily search + URL fetch),
       Composio-managed auth — no connected account needed.

Tool-calling loop: model searches/fetches via Composio, then calls
`submit_app_research` (a local, non-Composio tool) with a structured record
matching schemas/initial-app-research.schema.json. We validate that record
against the real JSON Schema file and write it to data/apps/<app_id>-research.json.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import jsonschema
from dotenv import load_dotenv
from openai import OpenAI
from composio import Composio

from schema_tool import SUBMIT_APP_RESEARCH_TOOL

load_dotenv()

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "schemas" / "initial-app-research.schema.json"
DATA_DIR = ROOT / "data" / "apps"
LOG_DIR = ROOT / "logs"

COMPOSIO_API_KEY = os.environ["COMPOSIO_API_KEY"]
OPENCODE_API_KEY = os.environ["OPENCODE_API_KEY"]
OPENCODE_BASE_URL = "https://opencode.ai/zen/go/v1"
MODEL = "deepseek-v4-flash"
USER_ID = "composio-toolkit-research"

RESEARCH_TOOL_SLUGS = [
    "COMPOSIO_SEARCH_TAVILY",             # web search
    "COMPOSIO_SEARCH_FETCH_URL_CONTENT",  # fetch/scrape a specific URL
]

SYSTEM_PROMPT = """You are a research agent evaluating third-party apps for \
whether they can be built into an AI agent toolkit today.

For the app you are given, research:
1. Category and a one-line description of what it does.
2. Auth method(s): OAuth2, API key, Basic auth, token, or other, and which \
one is primary/recommended for a programmatic agent integration.
3. Self-serve vs gated: can a developer get API credentials themselves for \
free or on a trial, or does it require a paid plan, admin approval, or a \
partnership / contact-sales gate? What specific gates exist (company email \
required, phone verification, waitlist, etc)?
4. API surface: is there a documented public REST or GraphQL API, how broad \
is it, and does an official or community MCP server already exist?
5. Buildability verdict: could this be an agent toolkit today? If not, what \
is the main blocker?

Rules:
- Use the search and fetch-url tools to find and read primary sources \
(official docs, pricing pages, developer/API pages). Do not guess.
- Every claim must be backed by a specific URL you actually fetched, recorded \
in `sources` with a verbatim short quote.
- If you cannot find evidence for something after a reasonable search, use the \
literal value "unknown" for that field rather than guessing — this is a \
correct, honest answer, not a failure.
- Budget your research: 4-6 tool calls is normally enough. Do not keep \
searching for marginal confirmation once you already have a documented \
answer with a URL for a point.
- Every enum-valued field (auth methods, source_type, credential_access, etc) \
MUST use one of the exact allowed values given in submit_app_research's \
schema. Never invent a new value (e.g. an auth style that doesn't cleanly \
fit any listed method should be reported as "custom" with a note explaining \
what it actually is, or "unknown" if you have no evidence at all — not a \
made-up value like "public_key"). If literally no auth method applies (e.g. \
the app is a CLI tool with no API auth), authentication.methods.value must \
still contain at least one entry — use ["unknown"], never an empty array. \
The `source_type` enum and the `existing_agent_skills` enum are different \
fields with different allowed values — do not mix them up (e.g. \
"community_skill" is only valid in existing_agent_skills, never in \
source_type).
- When you have enough evidence, call `submit_app_research` exactly once with \
your complete findings and sources. Do not call it more than once, and do not \
call any other tool after calling it.
"""


def parse_tool_arguments(raw_args: str, tool_name: str) -> dict:
    """Parse a tool call's JSON arguments, tolerating trailing junk after a
    complete JSON value (seen from deepseek-v4-flash on long structured
    outputs — the object itself is well-formed, something gets appended
    after it). Falls back to raw_decode which only consumes the first valid
    JSON value and ignores anything after it."""
    try:
        return json.loads(raw_args)
    except json.JSONDecodeError as e:
        try:
            obj, end = json.JSONDecoder().raw_decode(raw_args)
            print(
                f"  JSON had {len(raw_args) - end} trailing bytes after a valid "
                f"object for {tool_name}; recovered via raw_decode.",
                file=sys.stderr,
            )
            return obj
        except json.JSONDecodeError:
            dump_path = LOG_DIR / f"unparseable-{tool_name}-{datetime.now(timezone.utc).timestamp():.0f}.txt"
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            dump_path.write_text(raw_args)
            print(f"  JSON PARSE FAILED for {tool_name}: {e}. Raw dumped to {dump_path}", file=sys.stderr)
            return {}


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text())


def prune_unknown_properties(value, subschema: dict, resolver: jsonschema.RefResolver):
    """Recursively drop object keys the model invented that aren't declared in
    `subschema`. Models don't always respect additionalProperties:false in a
    tool-call schema, and the real schema files use it everywhere, so we
    align the submitted record to the schema shape before validating rather
    than failing pass-1 runs on harmless extra fields (e.g. a stray 'notes')."""
    if "$ref" in subschema:
        _, resolved = resolver.resolve(subschema["$ref"])
        return prune_unknown_properties(value, resolved, resolver)

    if "allOf" in subschema:
        # allOf branches are an intersection of constraints, not a pipeline —
        # merge their `properties` first, and only treat the key set as closed
        # if some branch actually declares additionalProperties: false.
        merged_properties = {}
        any_closed = False
        for sub in subschema["allOf"]:
            resolved_sub = sub
            if "$ref" in resolved_sub:
                _, resolved_sub = resolver.resolve(resolved_sub["$ref"])
            if resolved_sub.get("additionalProperties") is False:
                any_closed = True
            merged_properties.update(resolved_sub.get("properties", {}))

        if isinstance(value, dict) and merged_properties:
            items = value.items()
            if any_closed:
                items = [(k, v) for k, v in items if k in merged_properties]
            return {
                k: prune_unknown_properties(v, merged_properties[k], resolver) if k in merged_properties else v
                for k, v in items
            }
        return value

    if isinstance(value, dict) and "properties" in subschema:
        allowed = subschema["properties"]
        return {
            k: prune_unknown_properties(v, allowed[k], resolver)
            for k, v in value.items()
            if k in allowed
        }

    if isinstance(value, dict) and isinstance(subschema.get("additionalProperties"), dict):
        # a map keyed by arbitrary ids (e.g. `sources`), each value validated
        # against the same sub-schema
        item_schema = subschema["additionalProperties"]
        return {k: prune_unknown_properties(v, item_schema, resolver) for k, v in value.items()}

    if isinstance(value, list) and "items" in subschema:
        return [prune_unknown_properties(v, subschema["items"], resolver) for v in value]

    return value


def get_research_tools(composio: Composio):
    composio_tools = composio.tools.get(user_id=USER_ID, tools=RESEARCH_TOOL_SLUGS)
    return list(composio_tools) + [SUBMIT_APP_RESEARCH_TOOL]


def run_agent(app_name: str, app_url: str | None = None, max_turns: int = 14) -> Path:
    composio = Composio(api_key=COMPOSIO_API_KEY)
    client = OpenAI(api_key=OPENCODE_API_KEY, base_url=OPENCODE_BASE_URL)

    tools = get_research_tools(composio)
    app_id = slugify(app_name)

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    trace_path = LOG_DIR / f"{app_id}-trace.jsonl"
    trace_file = trace_path.open("w")

    def trace(event: dict):
        trace_file.write(json.dumps(event, default=str) + "\n")
        trace_file.flush()

    user_prompt = f"Research the app: {app_name}."
    if app_url:
        user_prompt += f" Its website is {app_url}."

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]

    tool_call_count = 0

    for turn in range(1, max_turns + 1):
        print(f"\n--- turn {turn} ---", file=sys.stderr)

        force_submit = turn == max_turns
        if force_submit:
            messages.append(
                {
                    "role": "user",
                    "content": "Stop researching now and call submit_app_research "
                    "with whatever evidence you have gathered so far. Mark any "
                    "field you could not find evidence for as 'unknown'.",
                }
            )

        response = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            # NOTE: forced tool_choice ({"type":"function","function":{"name":...}})
            # is broken on this gateway — returns a 400 "Upstream request failed"
            # even for trivial requests. Restrict the offered tool list instead of
            # forcing a specific one; "auto" with a single available tool has the
            # same effect and actually works.
            tools=[SUBMIT_APP_RESEARCH_TOOL] if force_submit else tools,
            tool_choice="auto",
            max_tokens=11000,
        )
        choice = response.choices[0]
        msg = choice.message
        print(f"  finish_reason={choice.finish_reason} usage={response.usage}", file=sys.stderr)

        if msg.content:
            print(f"[reasoning]: {msg.content[:300]}", file=sys.stderr)

        if not (choice.finish_reason == "tool_calls" and msg.tool_calls):
            # Model gave plain text instead of calling a tool — nudge it back.
            messages.append({"role": "assistant", "content": msg.content or ""})
            messages.append(
                {
                    "role": "user",
                    "content": "Please continue by calling a tool — either search/fetch "
                    "for more evidence, or submit_app_research if you're done.",
                }
            )
            continue

        messages.append(
            {
                "role": "assistant",
                "content": msg.content or "",
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                    }
                    for tc in msg.tool_calls
                ],
            }
        )

        for tc in msg.tool_calls:
            name = tc.function.name
            raw_args = tc.function.arguments or ""
            args = parse_tool_arguments(raw_args, name)

            tool_call_count += 1
            print(f"  tool_call: {name}(...) raw_len={len(raw_args)}", file=sys.stderr)
            trace({"turn": turn, "tool": name, "arguments": args, "raw_len": len(raw_args)})

            if name == "submit_app_research":
                trace_file.close()
                return finalize_record(app_id, args, tool_call_count, tools, trace_path)

            try:
                result = composio.tools.execute(
                    name, args, user_id=USER_ID, dangerously_skip_version_check=True,
                )
                result_str = json.dumps(result, default=str)
            except Exception as e:  # noqa: BLE001
                result_str = json.dumps({"error": str(e)})
                print(f"  tool_call FAILED: {e}", file=sys.stderr)

            trace({"turn": turn, "tool": name, "result_len": len(result_str)})

            if len(result_str) > 12000:
                result_str = result_str[:12000] + "...[truncated]"

            messages.append({"role": "tool", "tool_call_id": tc.id, "content": result_str})

    trace_file.close()
    raise RuntimeError(f"{app_name}: hit max_turns ({max_turns}) without a submit_app_research call")


def finalize_record(app_id: str, submitted: dict, tool_call_count: int, tools, trace_path: Path) -> Path:
    record = {
        "schema_version": "1.0",
        "app_id": app_id,
        "researched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "research_run": {
            "agent": "initial_research_agent",
            "model": MODEL,
            "tools": sorted({t["function"]["name"] for t in tools}),
            "tool_calls": tool_call_count,
            "trace_path": str(trace_path.relative_to(ROOT)),
        },
        "findings": submitted.get("findings"),
        "sources": submitted.get("sources"),
    }
    if submitted.get("limitations"):
        record["limitations"] = submitted["limitations"]

    schema = load_schema()
    resolver = jsonschema.RefResolver.from_schema(schema)
    record = prune_unknown_properties(record, schema, resolver)
    jsonschema.validate(instance=record, schema=schema)

    out_path = DATA_DIR / f"{app_id}-research.json"
    out_path.write_text(json.dumps(record, indent=2))
    print(f"\n=== VALID — wrote {out_path.relative_to(ROOT)} ===", file=sys.stderr)
    return out_path


if __name__ == "__main__":
    app_name = sys.argv[1] if len(sys.argv) > 1 else "Attio"
    app_url = sys.argv[2] if len(sys.argv) > 2 else None

    try:
        path = run_agent(app_name, app_url)
        print(f"OK: {path}")
    except jsonschema.ValidationError as e:
        print(f"SCHEMA VALIDATION FAILED for {app_name}: {e.message}", file=sys.stderr)
        print(f"  at path: {list(e.absolute_path)}", file=sys.stderr)
        sys.exit(1)
