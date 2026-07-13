"""
Builds the OpenAI-style function-calling tool definition for
`submit_app_research`, inlined (no $ref) so it works reliably as a
tool-call parameter schema, and mirrors
schemas/initial-app-research.schema.json's `findings` + `sources` shape.

Kept as a separate module because the inlined tool schema and the
$ref-based JSON Schema file used for validation are two different
representations of the same shape and it's worth being able to see
that mapping in one place.
"""

CLAIM = {
    "type": "object",
    "required": ["value", "evidence_ids"],
    "properties": {
        "value": {
            "description": "The claimed value. Use the literal string 'unknown' if no evidence was found.",
        },
        "evidence_ids": {
            "type": "array",
            "items": {"type": "string"},
            "minItems": 1,
            "description": "Keys into the top-level `sources` object that support this claim. Every claim must cite at least one source, even a source you use to justify 'unknown'.",
        },
        "notes": {"type": "string"},
    },
}

SOURCE = {
    "type": "object",
    "required": ["url", "quote", "source_type", "accessed_at"],
    "properties": {
        "url": {"type": "string", "description": "The exact URL you fetched."},
        "quote": {
            "type": "string",
            "maxLength": 1200,
            "description": "A short verbatim quote from the page that supports the claim(s) citing this source.",
        },
        "source_type": {
            "type": "string",
            "enum": [
                "official_api_docs",
                "official_auth_docs",
                "official_pricing",
                "official_product_page",
                "official_mcp_docs",
                "official_changelog",
                "official_help_center",
                "official_github",
                "composio_catalogue",
                "secondary_source",
            ],
        },
        "accessed_at": {
            "type": "string",
            "description": "ISO 8601 timestamp for when you fetched this, e.g. 2026-07-13T12:00:00Z.",
        },
        "title": {"type": "string"},
        "retrieval_method": {
            "type": "string",
            "enum": ["composio_fetch", "composio_search", "browser", "manual"],
        },
    },
}

FINDINGS = {
    "type": "object",
    "required": ["classification", "authentication", "access", "api_surface", "agent_interface", "buildability"],
    "properties": {
        "classification": {
            "type": "object",
            "required": ["researched_category", "one_liner"],
            "properties": {
                "researched_category": CLAIM,
                "one_liner": CLAIM,
            },
        },
        "authentication": {
            "type": "object",
            "required": ["methods", "primary_for_agent_toolkit"],
            "properties": {
                "methods": {
                    **CLAIM,
                    "properties": {
                        **CLAIM["properties"],
                        "value": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "enum": [
                                    "oauth2", "api_key", "basic", "bearer_token",
                                    "personal_access_token", "session_cookie", "custom", "unknown",
                                ],
                            },
                            "minItems": 1,
                        },
                    },
                },
                "primary_for_agent_toolkit": {
                    "type": "string",
                    "enum": ["oauth2", "api_key", "basic", "bearer_token", "personal_access_token", "custom", "unknown"],
                },
            },
        },
        "access": {
            "type": "object",
            "required": ["credential_access", "gates", "signup_friction", "paid_plan_required_for_api", "admin_approval_required", "evidence_ids"],
            "properties": {
                "credential_access": {
                    "type": "string",
                    "enum": ["self_serve_free", "self_serve_trial", "self_serve_paid", "admin_gated", "partner_gated", "sales_gated", "region_gated", "unknown"],
                },
                "gates": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["account_signup", "company_email", "phone_verification", "workspace_admin", "paid_plan", "app_review", "partner_approval", "sales_contract", "regional_eligibility", "waitlist"],
                    },
                },
                "signup_friction": {
                    "type": "string",
                    "enum": ["none_observed", "company_email_required", "phone_verification", "waitlist", "invite_required", "regional_restriction", "unknown"],
                },
                "paid_plan_required_for_api": {"type": "string", "enum": ["yes", "no", "plan_dependent", "unknown"]},
                "admin_approval_required": {"type": "string", "enum": ["yes", "no", "plan_or_role_dependent", "unknown"]},
                "evidence_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "notes": {"type": "string"},
            },
        },
        "api_surface": {
            "type": "object",
            "required": ["public_api", "protocols", "breadth", "summary"],
            "properties": {
                "public_api": {"type": "string", "enum": ["yes", "no", "unknown"]},
                "protocols": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["rest", "graphql", "soap", "grpc", "webhooks", "event_streaming", "sdk_only", "cli", "undocumented"],
                    },
                },
                "breadth": {"type": "string", "enum": ["narrow", "moderate", "broad", "unknown"]},
                "summary": CLAIM,
                "api_docs_url": {"type": ["string", "null"]},
            },
        },
        "agent_interface": {
            "type": "object",
            "required": ["mcp", "existing_agent_skills", "evidence_ids"],
            "properties": {
                "mcp": {"type": "string", "enum": ["official", "community", "composio_only", "none_found", "unknown"]},
                "mcp_endpoint": {"type": ["string", "null"]},
                "existing_agent_skills": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["official_sdk", "official_cli", "official_agent_api", "composio_toolkit", "community_skill"],
                    },
                },
                "evidence_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "notes": {"type": "string"},
            },
        },
        "buildability": {
            "type": "object",
            "required": ["verdict", "main_blocker", "rationale"],
            "properties": {
                "verdict": {
                    "type": "string",
                    "enum": ["buildable_today", "buildable_with_access", "technically_possible_but_gated", "not_buildable_from_public_api", "insufficient_evidence"],
                },
                "main_blocker": {
                    "type": "string",
                    "enum": ["none_material", "no_public_api", "paid_api_entitlement", "admin_approval", "partner_approval", "sales_contract", "restricted_api_scope", "undocumented_api", "rate_limit_or_policy", "unknown"],
                },
                "rationale": CLAIM,
            },
        },
    },
}

SUBMIT_APP_RESEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "submit_app_research",
        "description": (
            "Submit your completed research record for this app. Call this exactly "
            "once, only after you have gathered enough evidence from search/fetch "
            "tool calls to fill in every required field (use 'unknown' for anything "
            "you could not find evidence for — never guess). Every claim's "
            "evidence_ids must point to a key you define in `sources`."
        ),
        "parameters": {
            "type": "object",
            "required": ["findings", "sources"],
            "properties": {
                "findings": FINDINGS,
                "sources": {
                    "type": "object",
                    "description": (
                        "Map of source_id -> source. source_id is a short key you invent "
                        "(e.g. 's1', 's2'), referenced by claims' evidence_ids."
                    ),
                    "additionalProperties": SOURCE,
                    "minProperties": 1,
                },
                "limitations": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Anything you could not verify, tools that failed, or caveats worth flagging.",
                },
            },
        },
    },
}
