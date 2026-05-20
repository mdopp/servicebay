#!/bin/sh
# Nginx Inspector — v2.
#
# Walks NPM / nginx config locations and emits a JSON array of
# `{host, targetService, targetPort, ssl}` rows for every proxied
# host that resolves a forwarding target. The agent ships this
# script into the running nginx container, executes it, then deletes
# it. Output is parsed by `agent.py:fetch_proxy_routes()` and rolled
# into the digital-twin `proxyState.routes` array.
#
# Why a separate file (#723):
#   The script used to live as a triple-quoted Python string in
#   agent.py. Keeping shell-script grammar inside Python quoting
#   meant every `$`, `"` and `\` had to be re-escaped by hand, and
#   the editor lost syntax highlighting. Lifting it out gives shell
#   tools (shellcheck, shfmt) a real surface to inspect while still
#   shipping as part of the agent — the build inliner in
#   `agent/handler.ts` substitutes the contents back into the agent
#   source at delivery time.

echo "["
FIRST=1
# Broaden search paths
SEARCH_PATHS="/etc/nginx/conf.d/*.conf /data/nginx/proxy_host/*.conf /etc/nginx/sites-enabled/* /config/nginx/proxy-confs/*.subdomain.conf"

for file in $SEARCH_PATHS; do
    [ -e "$file" ] || continue
    if [ -d "$file" ]; then continue; fi

    SERVER_NAME=$(grep -m1 "server_name" "$file" | awk '{print $2}' | sed 's/;//' | head -n 1)

    NPM_SERVER=$(grep "set \$server" "$file" | awk '{print $3}' | sed 's/"//g' | sed 's/;//' | head -n 1)
    NPM_PORT=$(grep "set \$port" "$file" | awk '{print $3}' | sed 's/"//g' | sed 's/;//' | head -n 1)

    if [ ! -z "$NPM_SERVER" ] && [ ! -z "$NPM_PORT" ]; then
        PROXY_PASS="$NPM_SERVER:$NPM_PORT"
    else
        PROXY_PASS=$(grep "proxy_pass" "$file" | grep -v '^\s*#' | head -n 1 | awk '{print $2}' | sed 's/;//' | sed 's/http:\/\///' | sed 's/https:\/\///')
    fi

    if [ ! -z "$SERVER_NAME" ] && [ ! -z "$PROXY_PASS" ]; then
        if [ "$FIRST" -eq 0 ]; then echo ","; fi
        TARGET=$(echo "$PROXY_PASS" | sed 's/\/$//')

        # Extract Port
        PORT=80
        if echo "$TARGET" | grep -q ":"; then
             PORT=$(echo "$TARGET" | awk -F: '{print $NF}' | sed 's/[^0-9]*//g')
        fi
        [ -z "$PORT" ] && PORT=80

        LISTEN_SSL=$(grep -q "listen 443" "$file" && echo "true" || echo "false")

        echo "  {"
        echo "    \"host\": \"$SERVER_NAME\","
        echo "    \"targetService\": \"$TARGET\","
        echo "    \"targetPort\": $PORT,"
        echo "    \"ssl\": $LISTEN_SSL"
        echo "  }"
        FIRST=0
    fi
done
echo "]"
