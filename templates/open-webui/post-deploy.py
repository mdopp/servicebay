#!/usr/bin/env python3
"""
post-deploy hook for the `open-webui` template (#1030).

One responsibility: print a one-liner pointing the operator at the
admin-bootstrap URL. Open WebUI's first account is the admin; we
can't pre-seed it (no headless admin-create API at install time),
so the install log nudges the operator to go visit and create one.

No state writes, no API calls — keep it small.

See lib/registry.ts:getTemplatePostDeployScript for the script
protocol.
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    subdomain = os.environ.get("OPEN_WEBUI_SUBDOMAIN", "chat")
    public_domain = os.environ.get("PUBLIC_DOMAIN", "")
    lan_domain = os.environ.get("LAN_DOMAIN", "")
    domain = public_domain or lan_domain or "<your-domain>"
    url = f"https://{subdomain}.{domain}/"

    print(f"✅ Open WebUI is live at {url}")
    print(f"   First visit: Authelia 1FA login → Open WebUI's admin-create form.")
    print(f"   The first account you create becomes the in-app admin; add family members from Settings → Users.")
    print(f"   Backend Ollama: http://127.0.0.1:{os.environ.get('OLLAMA_PORT', '11434')} (auto-discovered).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
