#!/bin/sh
# Nginx Inspector Script
# This script runs INSIDE the Nginx container.
# It parses /etc/nginx/conf.d/*.conf to find proxy_pass directives and outputs JSON.

# Output generic JSON: [{"host": "app.lan", "target": "app:3000", "ssl": false}]

echo "["
FIRST=1

# Loop through all conf files (excluding default if needed, but usually we want all)
for file in /etc/nginx/conf.d/*.conf; do
    [ -e "$file" ] || continue
    
    # Simple grep/awk parsing. 
    # Assumption: Standard ServiceBay template structure or simple proxy_pass.
    # We look for 'server_name' and 'proxy_pass'.
    
    SERVER_NAME=$(grep -m1 "server_name" "$file" | awk '{print $2}' | sed 's/;//')
    PROXY_PASS=$(grep -m1 "proxy_pass" "$file" | awk '{print $2}' | sed 's/;//' | sed 's/http:\/\///' | sed 's/https:\/\///')
    LISTEN_SSL=$(grep -q "listen 443" "$file" && echo "true" || echo "false")
    
    # If we found at least a server name and a proxy pass
    if [ ! -z "$SERVER_NAME" ] && [ ! -z "$PROXY_PASS" ]; then
        if [ "$FIRST" -eq 0 ]; then
            echo ","
        fi
        
        # Clean up TARGET (remove trailing slash)
        TARGET=$(echo "$PROXY_PASS" | sed 's/\/$//')
        
        echo "  {"
        echo "    \"host\": \"$SERVER_NAME\","
        echo "    \"targetService\": \"$TARGET\","
        echo "    \"targetPort\": 0," 
        echo "    \"ssl\": $LISTEN_SSL"
        echo "  }"
        FIRST=0
    fi
done

echo "]"
