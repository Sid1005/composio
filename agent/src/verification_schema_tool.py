"""
Inlined (no $ref) tool schema for `submit_browser_verification`, mirroring
schemas/app-verification.schema.json's `fieldChecks` / `correction` shape.
Same rationale as schema_tool.py for the pass-1 agent.
"""

VERIFICATION_RESULT_ENUM = [
    "confirmed", "partially_confirmed", "contradicted", "inconclusive", "not_run",
]

FIELD_CHECK = {
    "type": "object",
    "required": ["field", "result", "evidence"],
    "properties": {
        "field": {
            "type": "string",
            "description": "Dotted path of the finding being checked, e.g. 'authentication.methods'.",
        },
        "result": {"type": "string", "enum": VERIFICATION_RESULT_ENUM},
        "evidence": {
            "type": "string",
            "description": "What you actually saw on the rendered page that supports this result — a short quote or description.",
        },
        "source_url": {"type": "string"},
    },
}

CORRECTION = {
    "type": "object",
    "required": ["field", "initial_value", "final_value", "reason", "evidence"],
    "properties": {
        "field": {"type": "string"},
        "initial_value": {"description": "What pass-1 claimed."},
        "final_value": {"description": "What the rendered page actually shows."},
        "reason": {"type": "string"},
        "evidence": {"type": "string"},
    },
}

SUBMIT_BROWSER_VERIFICATION_TOOL = {
    "type": "function",
    "function": {
        "name": "submit_browser_verification",
        "description": (
            "Submit your independent verification of the pass-1 research record, based only on "
            "the freshly rendered page content and screenshots you were given — not on trusting "
            "pass-1's claims. Call this exactly once."
        ),
        "parameters": {
            "type": "object",
            "required": ["overall_result", "checks"],
            "properties": {
                "overall_result": {
                    "type": "string",
                    "enum": VERIFICATION_RESULT_ENUM,
                    "description": "Overall verdict across all checked fields.",
                },
                "checks": {
                    "type": "array",
                    "items": FIELD_CHECK,
                    "minItems": 1,
                    "description": "One entry per field you were asked to check.",
                },
                "corrections": {
                    "type": "array",
                    "items": CORRECTION,
                    "description": (
                        "Only include an entry here if the rendered page evidence actually "
                        "contradicts pass-1's claim (result='contradicted' or a materially "
                        "incomplete 'partially_confirmed'). Do not include a correction for "
                        "fields you merely couldn't verify — use result='inconclusive' instead."
                    ),
                },
            },
        },
    },
}
