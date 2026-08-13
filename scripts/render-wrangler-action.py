#!/usr/bin/env python3
"""Render the production Wrangler template from validated GitHub Actions env vars."""

import json
import os
import re
import sys
from pathlib import Path


def render(path: Path) -> None:
    config = path.read_text()

    def drop_array_section(name: str) -> None:
        nonlocal config
        config = re.sub(
            rf"(?ms)^\[\[{re.escape(name)}\]\]\n.*?(?=^\[|\Z)",
            "",
            config,
        )

    if not os.environ.get("CUSTOM_DOMAIN"):
        drop_array_section("routes")
    if not os.environ.get("R2_BUCKET_NAME"):
        drop_array_section("r2_buckets")
    if os.environ.get("CF_EMAIL_SEND_ENABLED") != "true":
        drop_array_section("send_email")
    if os.environ.get("WORKERS_AI_ENABLED") != "true":
        config = re.sub(r"(?ms)^\[ai\]\n.*?(?=^\[|\Z)", "", config)
    if os.environ.get("AI_EMAIL_AGENT_ENABLED") != "true":
        drop_array_section("durable_objects.bindings")
        drop_array_section("migrations")
    if not os.environ.get("EMAIL_EVENTS_QUEUE"):
        drop_array_section("queues.consumers")
    elif not os.environ.get("EMAIL_EVENTS_DEAD_LETTER_QUEUE"):
        config = re.sub(r"(?m)^dead_letter_queue = .*\n", "", config)
    if not os.environ.get("PROJECT_LINK"):
        config = re.sub(r"(?m)^project_link = .*\n", "", config)
    if not os.environ.get("ORM_LOG"):
        config = re.sub(r"(?m)^orm_log = .*\n", "", config)
    if not os.environ.get("MAIL_BRIDGE_URL"):
        config = re.sub(r"(?m)^MAIL_BRIDGE_URL = .*\n", "", config)
    if not (os.environ.get("LINUXDO_CLIENT_ID") and os.environ.get("LINUXDO_CALLBACK_URL")):
        config = re.sub(r"(?m)^linuxdo_(?:client_id|callback_url|switch) = .*\n", "", config)

    domain = json.loads(os.environ["DOMAIN"])
    config = config.replace('"${DOMAIN}"', json.dumps(domain, ensure_ascii=False))

    values = {
        "NAME": os.environ["NAME"],
        "CUSTOM_DOMAIN": os.environ.get("CUSTOM_DOMAIN", ""),
        "ADMIN": os.environ["ADMIN"],
        "D1_DATABASE_NAME": os.environ["D1_DATABASE_NAME"],
        "D1_DATABASE_ID": os.environ["RESOLVED_D1_DATABASE_ID"],
        "KV_NAMESPACE_ID": os.environ["RESOLVED_KV_NAMESPACE_ID"],
        "R2_BUCKET_NAME": os.environ.get("R2_BUCKET_NAME", ""),
        "EMAIL_EVENTS_QUEUE": os.environ.get("EMAIL_EVENTS_QUEUE", ""),
        "EMAIL_EVENTS_DEAD_LETTER_QUEUE": os.environ.get("EMAIL_EVENTS_DEAD_LETTER_QUEUE", ""),
        "PROJECT_LINK": os.environ.get("PROJECT_LINK", ""),
        "ORM_LOG": os.environ.get("ORM_LOG", ""),
        "MAIL_BRIDGE_URL": os.environ.get("MAIL_BRIDGE_URL", ""),
        "LINUXDO_CLIENT_ID": os.environ.get("LINUXDO_CLIENT_ID", ""),
        "LINUXDO_CALLBACK_URL": os.environ.get("LINUXDO_CALLBACK_URL", ""),
        "LINUXDO_SWITCH": os.environ.get("LINUXDO_SWITCH", "false"),
        "AUTHELIA_SSO_SWITCH": os.environ["AUTHELIA_SSO_SWITCH"],
        "AUTHELIA_ISSUER": os.environ.get("AUTHELIA_ISSUER", ""),
        "AUTHELIA_DISCOVERY_URL": os.environ.get("AUTHELIA_DISCOVERY_URL", ""),
        "AUTHELIA_CLIENT_ID": os.environ.get("AUTHELIA_CLIENT_ID", ""),
        "AUTHELIA_REDIRECT_URI": os.environ.get("AUTHELIA_REDIRECT_URI", ""),
        "AUTHELIA_SCOPES": os.environ["AUTHELIA_SCOPES"],
        "AUTHELIA_AUTO_CREATE_USER": os.environ["AUTHELIA_AUTO_CREATE_USER"],
        "AUTHELIA_REQUIRE_VERIFIED_EMAIL": os.environ["AUTHELIA_REQUIRE_VERIFIED_EMAIL"],
        "AUTHELIA_TOKEN_ENDPOINT_AUTH_METHOD": os.environ["AUTHELIA_TOKEN_ENDPOINT_AUTH_METHOD"],
        "AUTHELIA_ID_TOKEN_SIGNING_ALG": os.environ["AUTHELIA_ID_TOKEN_SIGNING_ALG"],
        "AUTHELIA_LOGOUT_ENABLED": os.environ["AUTHELIA_LOGOUT_ENABLED"],
        "AUTHELIA_LOGOUT_URL": os.environ.get("AUTHELIA_LOGOUT_URL", ""),
    }
    for key, value in values.items():
        placeholder = '"${' + key + '}"'
        config = config.replace(placeholder, json.dumps(value, ensure_ascii=False))

    if os.environ.get("ORM_LOG"):
        config = re.sub(
            r'(?m)^orm_log = "(true|false)"$',
            r"orm_log = \1",
            config,
        )

    if "${" in config:
        raise SystemExit(f"Unresolved placeholder remains in {path}")
    path.write_text(config)


if __name__ == "__main__":
    render(Path(sys.argv[1] if len(sys.argv) > 1 else "wrangler-action.toml"))
