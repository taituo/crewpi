#!/usr/bin/env bash
# Print the generated demo credentials from the cluster secret (they are never written to disk).
set -euo pipefail
sec() { kubectl -n ai-workspace get secret workspace-secrets -o "jsonpath={.data.$1}" | base64 -d; }
for u in alice bob carol dave; do printf '%-6s %s\n' "$u" "$(sec pw-$u)"; done
printf '%-6s %s  (Keycloak admin console)\n' admin "$(sec keycloak-admin-password)"
