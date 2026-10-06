#!/usr/bin/env bash
# Run before making the repository public. Exits non-zero if anything needs attention.
# Looks at the WHOLE history, not just the working tree: a secret removed later is still in the past commits.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
note() { printf '  %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }

section "secrets anywhere in history"
if git log -p --all -G'sk-or-v1-[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[bap]-' --oneline | grep -q .; then
  note "FOUND secret-looking strings in history (inspect with: git log -p --all -G'<pattern>')"; fail=1
else note "none found"; fi

section "environment-specific values (IPs, hosts, home paths, personal gateways)"
hits=$(git grep -n -I -E '\b(10\.91\.|100\.95\.|178\.105\.)|/home/[a-z]+/|openrouter[0-9]+usd|opencode-go-gateway' -- . ':!package-lock.json' ':!scripts/public-check.sh' || true)
if [ -n "$hits" ]; then note "found:"; echo "$hits" | sed 's/^/    /'; fail=1; else note "none"; fi

section "files that must never be tracked"
if git ls-files | grep -E '(^|/)(\.deploy\.env|\.env|.*\.key|.*\.pem)$'; then fail=1; else note "none tracked"; fi

section "publishing basics"
[ -f LICENSE ] && note "LICENSE present" || { note "LICENSE missing (MIT was chosen: add it at publish time)"; fail=1; }
[ -f README.md ] && note "README present" || { note "README missing"; fail=1; }
git config user.email | grep -q noreply && note "commit email is a GitHub noreply address" || { note "commit email is not a noreply address: it would be public"; fail=1; }

section "known demo defaults to mention in the README (not blockers)"
note "sessionSecret falls back to a dev value unless SESSION_SECRET is set (deploy.sh sets one)"
note "Keycloak runs in start-dev mode; Temporal runs in dev mode; plain HTTP unless TLS is put in front"

echo; [ $fail -eq 0 ] && echo "READY to publish" || echo "NOT ready: see above"
exit $fail
