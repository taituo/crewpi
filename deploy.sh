#!/usr/bin/env bash
# Build the image, load it into k3s and (re)deploy Keycloak + the workspace + a broken demo app.
# Idempotent: secrets are generated once and kept in the cluster.
#   BASE_DOMAIN   required; hostnames are crew.<BASE_DOMAIN> and auth.<BASE_DOMAIN> (e.g. 203.0.113.10.nip.io)
#   OPENAI_API_KEY  if set, stored as secret ai-workspace/inference and used by the agents
#   RESET=1       wipe chat history, agent memory, the repo and Temporal history, and break checkout-api again (fresh demo)
set -euo pipefail
cd "$(dirname "$0")"
[ -f .deploy.env ] && . ./.deploy.env   # local defaults (not secrets), e.g. LOCAL_LLM_*

# LOCAL_LLM_BASE_URL / LOCAL_LLM_MODEL / LOCAL_LLM_API_KEY_FILE  any OpenAI-compatible endpoint (vLLM, a gateway...)
: "${BASE_DOMAIN:?set BASE_DOMAIN (copy .deploy.env.example to .deploy.env), e.g. 203.0.113.10.nip.io}"
export BASE_DOMAIN
export BRAND_NAME="${BRAND_NAME:-Crew}"
export BRAND_WORKSPACE="${BRAND_WORKSPACE:-Demo Company}"
export BRAND_ACCENT="${BRAND_ACCENT:-#6d5efc}"
export LOCAL_LLM_BASE_URL="${LOCAL_LLM_BASE_URL:-}"
export LOCAL_LLM_MODEL="${LOCAL_LLM_MODEL:-}"
export OPENROUTER_BUDGET_USD="${OPENROUTER_BUDGET_USD:-5}"
export AGENT_OPS_MODEL="${AGENT_OPS_MODEL:-}" AGENT_DEVELOPER_MODEL="${AGENT_DEVELOPER_MODEL:-}" AGENT_REVIEWER_MODEL="${AGENT_REVIEWER_MODEL:-}" AGENT_INSIGHT_MODEL="${AGENT_INSIGHT_MODEL:-}" OPTCHAT_MODEL="${OPTCHAT_MODEL:-}"
# A synthetic world that runs inside the workspace and shows up as the read-only channel #world-<name> (empty = off).
export WORLD_AUTORUN="${WORLD_AUTORUN:-}" WORLD_TICK_MS="${WORLD_TICK_MS:-4000}" WORLD_TEAM="${WORLD_TEAM:-ops=3,dev=2}" WORLD_FAULTS="${WORLD_FAULTS:-heavy}" WORLD_BRAIN="${WORLD_BRAIN:-rules}" WORLD_MODEL="${WORLD_MODEL:-}" WORLD_BUDGET="${WORLD_BUDGET:-}"
export COMPACT_KEEP_RECENT_TOKENS="${COMPACT_KEEP_RECENT_TOKENS:-20000}"   # lower it (e.g. 1500) to see compaction in short demos
export OPTCHAT_VIEW_BYTES="${OPTCHAT_VIEW_BYTES:-6000}"
export IMAGE="localhost/crew-workspace:$(date +%Y%m%d-%H%M%S)"
NS=ai-workspace
rand() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

# Refuse to ship code that does not typecheck (only when dev dependencies are installed locally).
if [ -d node_modules/typescript ] && [ "${SKIP_TYPECHECK:-}" != "1" ]; then
  echo "==> typecheck"
  podman run --rm -v "$PWD:/app:Z" -w /app docker.io/library/node:22-slim npx tsc -p . >/tmp/crew-tsc.log 2>&1 \
    || { echo "typecheck failed:"; head -20 /tmp/crew-tsc.log; exit 1; }
fi

echo "==> build $IMAGE"
podman build -q -t "$IMAGE" . >/dev/null
podman save "$IMAGE" | sudo -n k3s ctr -n k8s.io images import - >/dev/null
export SANDBOX_IMAGE="localhost/crew-sandbox:$(date +%Y%m%d-%H%M%S)"
echo "==> build $SANDBOX_IMAGE"
podman build -q -f Dockerfile.sandbox -t "$SANDBOX_IMAGE" . >/dev/null
podman save "$SANDBOX_IMAGE" | sudo -n k3s ctr -n k8s.io images import - >/dev/null

echo "==> namespaces"
kubectl apply -f k8s/00-namespaces.yaml >/dev/null

if [ "${RESET:-}" = "1" ]; then
  echo "==> RESET: wiping workspace state (chat, agent memory, repo) and re-breaking checkout-api"
  kubectl -n $NS delete deploy/workspace --ignore-not-found --wait=true >/dev/null
  kubectl -n $NS delete pvc/workspace-data --ignore-not-found --wait=true >/dev/null
  kubectl -n demo-apps delete cm/checkout-config deploy/checkout-api --ignore-not-found >/dev/null
  # Temporal keeps workflow history on its own volume; stale workflows would refer to channels that no longer exist.
  kubectl -n ai-workflows delete deploy/temporal pvc/temporal-data --ignore-not-found --wait=true >/dev/null 2>&1 || true
fi

if ! kubectl -n $NS get secret workspace-secrets >/dev/null 2>&1; then
  echo "==> generating secrets"
  kubectl -n $NS create secret generic workspace-secrets \
    --from-literal=session-secret="$(rand 48)" \
    --from-literal=oidc-client-secret="$(rand 40)" \
    --from-literal=keycloak-admin-password="$(rand 24)" \
    --from-literal=pw-alice="$(rand 14)" --from-literal=pw-bob="$(rand 14)" \
    --from-literal=pw-carol="$(rand 14)" --from-literal=pw-dave="$(rand 14)" >/dev/null
fi
sec() { kubectl -n $NS get secret workspace-secrets -o "jsonpath={.data.$1}" | base64 -d; }
export OIDC_CLIENT_SECRET="$(sec oidc-client-secret)"
export PW_ALICE="$(sec pw-alice)" PW_BOB="$(sec pw-bob)" PW_CAROL="$(sec pw-carol)" PW_DAVE="$(sec pw-dave)"

# Optional inference secrets (kept in the cluster, never printed)
if [ -n "${OPENAI_API_KEY:-}" ] || [ -n "${LOCAL_LLM_API_KEY_FILE:-}" ] || [ -n "${OPENROUTER_API_KEY_FILE:-}" ]; then
  echo "==> storing inference secrets"
  args=()
  [ -n "${OPENAI_API_KEY:-}" ] && args+=(--from-literal=openai-api-key="$OPENAI_API_KEY")
  [ -n "${LOCAL_LLM_API_KEY_FILE:-}" ] && args+=(--from-file=local-api-key="$LOCAL_LLM_API_KEY_FILE")
  [ -n "${OPENROUTER_API_KEY_FILE:-}" ] && args+=(--from-literal=openrouter-api-key="$(tr -d " \n\r" < "$OPENROUTER_API_KEY_FILE")")
  kubectl -n $NS create secret generic inference "${args[@]}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
fi

echo "==> keycloak realm"
envsubst '${BRAND_NAME} ${BASE_DOMAIN} ${OIDC_CLIENT_SECRET} ${PW_ALICE} ${PW_BOB} ${PW_CAROL} ${PW_DAVE}' \
  < keycloak/realm.json.tmpl > /tmp/crew-realm.json
kubectl -n $NS create configmap keycloak-realm --from-file=realm.json=/tmp/crew-realm.json \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
rm -f /tmp/crew-realm.json

echo "==> apply"
for f in k8s/50-temporal.yaml k8s/40-sandboxes.yaml k8s/10-keycloak.yaml k8s/20-workspace.yaml k8s/30-demo-app.yaml; do
  envsubst '${BASE_DOMAIN} ${IMAGE} ${BRAND_NAME} ${BRAND_WORKSPACE} ${BRAND_ACCENT} ${LOCAL_LLM_BASE_URL} ${LOCAL_LLM_MODEL} ${COMPACT_KEEP_RECENT_TOKENS} ${OPTCHAT_VIEW_BYTES} ${OPENROUTER_BUDGET_USD} ${AGENT_OPS_MODEL} ${AGENT_DEVELOPER_MODEL} ${AGENT_REVIEWER_MODEL} ${AGENT_INSIGHT_MODEL} ${OPTCHAT_MODEL} ${SANDBOX_IMAGE} ${WORLD_AUTORUN} ${WORLD_TICK_MS} ${WORLD_TEAM} ${WORLD_FAULTS} ${WORLD_BRAIN} ${WORLD_MODEL} ${WORLD_BUDGET}' < "$f" | kubectl apply -f - >/dev/null
done

echo "==> waiting for rollout"
kubectl -n $NS rollout status deploy/keycloak --timeout=300s
kubectl -n $NS rollout status deploy/workspace --timeout=180s

cat <<EOF

Workspace : http://crew.${BASE_DOMAIN}
Keycloak  : http://auth.${BASE_DOMAIN}   (admin console: user admin)
Users     : alice (approver), bob (operator), carol (viewer), dave (admin)
Passwords : ./show-credentials.sh
EOF
