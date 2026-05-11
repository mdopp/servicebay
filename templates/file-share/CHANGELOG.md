# File Share — template changelog

Tracks breaking changes to the `file-share` template's pod structure /
variable shape. Each H2 corresponds to a value of
`servicebay.schema-version` in `template.yml`.

## v2

**FileBrowser bind address fix.**

FileBrowser was previously configured to bind on `127.0.0.1`. Because
the `nginx` template runs in its own pod netns (not hostNetwork),
NPM's `proxy_pass` to the host LAN IP could never reach a
loopback-only listener — `files.<domain>` always failed with a
502 / connection refused.

FB now binds on `0.0.0.0`. Auth bypass is still prevented by FB's
proxy-auth mode: any request without the `Remote-User` header set by
NPM's `auth_request` snippet is rejected with 403, so direct LAN hits
on `:8088` can't get past the login.

Required action: re-deploy the `file-share` template. Existing data
(Syncthing config, Samba shares, FileBrowser DB) is preserved.

## v1

Initial release. Bundled Syncthing + Samba + FileBrowser into a
single pod with the shared `/data` volume.
