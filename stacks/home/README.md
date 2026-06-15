# Home stack

Smart-home automation.

## Included Services

- [x] home-assistant — HA core + Z-Wave + Matter bridges

## Voice

The app-specific voice pipeline was retired from ServiceBay in #1876.
Solaris (mdopp/solarisbay) now owns the full voice pipeline; ServiceBay
keeps only the generic platform plumbing (GPU/CDI passthrough,
hostNetwork carveout, companion-quadlet machinery), which is not
voice-specific.

## Dependencies

Requires the `basic` stack (nginx + auth + adguard) — HA's web UI
is proxied at `home.<domain>` and authenticates against LLDAP for
family accounts.
