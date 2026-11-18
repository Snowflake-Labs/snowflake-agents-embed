#!/usr/bin/env bash
# Copyright 2026 Snowflake Inc.
# SPDX-License-Identifier: Apache-2.0
# deploy-spcs.sh — rebuild & redeploy the SPCS server container (packages/server)
#
# Builds the Docker image for linux/amd64 (SPCS is x86 — an ARM/Mac build fails
# with "exec format error"), pushes it to the Snowflake image registry, and
# rolls the running service onto the new image.
#
# IMPORTANT: the AGENTS_TEAMS service pins a specific image *digest* (sha256) in
# its spec, so `ALTER SERVICE ... SUSPEND/RESUME` does NOT pick up a freshly
# pushed :latest — SPCS just re-pulls the same pinned digest. This script fetches
# the live spec, swaps in the newly-pushed digest, and reapplies it, which is
# what actually forces the new image to roll out.
#
# With NETWORK_MODE (public|hybrid|privatelink) in apps/teams/.env, the same
# rewrite also sets SNOWFLAKE_HOST_MODE (account unless SPCS_HOST_MODE=internal) and
# enableCustomCredentials to match.
#
# Usage:
#   ./scripts/deploy-spcs.sh                 # uses the default snow connection
#   ./scripts/deploy-spcs.sh -c MY_CONN      # named connection from ~/.snowflake/config.toml
#   ./scripts/deploy-spcs.sh --no-build      # reuse the local image, just push + roll
#   ./scripts/deploy-spcs.sh --skip-validate # skip validate-env.sh (legacy installs only)
#
# Prerequisites:
#   - docker (Desktop or engine) with buildx
#   - Snowflake CLI (snow) authenticated to the account that hosts the service
#     (the default connection must be able to run SQL + `snow spcs image-registry login`)
#
# NOTE: this deploys the *server* only. Tab (frontend) changes deploy separately
# with the edge Worker:  bash apps/teams/scripts/deploy-tab.sh

set -euo pipefail

# ── Config (override via environment if the account/service ever changes) ──────
SERVICE="${SERVICE:-AGENTS_TEAMS_APP_DB.PUBLIC.AGENTS_TEAMS}"
LOCAL_IMAGE="${LOCAL_IMAGE:-agents-teams-app:latest}"
READY_TIMEOUT_SECS="${READY_TIMEOUT_SECS:-180}"

# ── Colours / helpers ─────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
step() { echo -e "\n${GREEN}▶ $*${NC}"; }
info() { echo -e "  $*"; }
warn() { echo -e "${YELLOW}!  $*${NC}"; }
die()  { echo -e "${RED}✗  $*${NC}" >&2; exit 1; }

# ── Args ──────────────────────────────────────────────────────────────────────
CONN=""; DO_BUILD=1; VALIDATE=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--connection) CONN="$2"; shift 2 ;;
    --no-build)      DO_BUILD=0; shift ;;
    --skip-validate) VALIDATE=0; shift ;;
    -h|--help)       sed -n '2,29p' "$0"; exit 0 ;;
    *)               die "unknown argument: $1" ;;
  esac
done

SNOW=(snow)
[[ -n "$CONN" ]] && SNOW=(snow -c "$CONN")

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

if (( VALIDATE )); then
  step "Validating apps/teams/.env"
  bash "$REPO_ROOT/apps/teams/scripts/validate-env.sh" || die "validate-env.sh failed; fix the errors above (or --skip-validate)"
fi
ENV_FILE="${REPO_ROOT}/apps/teams/.env"

if [[ -f "$ENV_FILE" ]]; then
  # Load into this shell only; export the handful of keys child processes need
  # (never the PAT / Entra secrets).
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      printf -v "${BASH_REMATCH[1]}" '%s' "${BASH_REMATCH[2]}"
    fi
  done < "$ENV_FILE"
  export SNOWFLAKE_ACCOUNT TAB_BASE_URL NETWORK_MODE SPCS_HOST_MODE SNOWFLAKE_REGISTRY_HOST
fi
: "${SNOWFLAKE_ACCOUNT:?SNOWFLAKE_ACCOUNT is not set — see apps/teams/.env.example}"
: "${TAB_BASE_URL:?TAB_BASE_URL is not set — see apps/teams/.env.example}"
TAB_HOST="${TAB_BASE_URL#https://}"; TAB_HOST="${TAB_HOST#http://}"; TAB_HOST="${TAB_HOST%%/*}"
# shellcheck source=lib/preflight.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/preflight.sh"
case "$TAB_HOST" in *.pages.dev) warn "TAB_BASE_URL is a legacy pages.dev host; deploy-tab.sh now deploys a Worker. See docs/teams/teams-install.md section 6." ;; esac
# Optional. When set, step 4 also forces SNOWFLAKE_HOST_MODE and
# capabilities.securityContext.enableCustomCredentials to match; when unset the
# live spec keeps whatever it has.
NETWORK_MODE="${NETWORK_MODE:-}"
# 'account' (default, every NETWORK_MODE) sends forwarded user tokens over SPCS egress.
# 'internal' only accepts the SPCS service token (Snowflake 395090 for user tokens), so it
# is an explicit opt-in for service-identity-only deployments.
SPCS_HOST_MODE="${SPCS_HOST_MODE:-account}"
case "$SPCS_HOST_MODE" in
  account|internal) ;;
  *) die "SPCS_HOST_MODE must be account or internal (got '$SPCS_HOST_MODE')" ;;
esac
case "$NETWORK_MODE" in
  ""|public|hybrid|privatelink) ;;
  *) die "NETWORK_MODE must be public, hybrid or privatelink (got '$NETWORK_MODE')" ;;
esac
REGISTRY_HOST="${SNOWFLAKE_REGISTRY_HOST:-${SNOWFLAKE_ACCOUNT//_/-}.registry.snowflakecomputing.com}"
REGISTRY_IMAGE="${REGISTRY_IMAGE:-${REGISTRY_HOST}/agents_teams_app_db/public/image_repo/agents-teams-app}"

command -v docker >/dev/null || die "docker not found on PATH"
command -v snow   >/dev/null || die "snow (Snowflake CLI) not found on PATH"
command -v python3 >/dev/null || die "python3 not found on PATH"

# ── 1. Build (linux/amd64) ──────────────────────────────────────────────────
if [[ "$DO_BUILD" == 1 ]]; then
  step "Building $LOCAL_IMAGE for linux/amd64"
  docker build --platform linux/amd64 -f apps/teams/Dockerfile -t "$LOCAL_IMAGE" .
else
  warn "Skipping build (--no-build); using existing $LOCAL_IMAGE"
fi

# ── 2. Registry login ─────────────────────────────────────────────────────────
step "Logging in to the Snowflake image registry"
"${SNOW[@]}" spcs image-registry login

# ── 3. Tag + push (latest + a traceable tag) ───────────────────────────────────
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
STAMP="$(date +%Y%m%d-%H%M%S)"
TRACE_TAG="deploy-${SHA}-${STAMP}"
step "Pushing $REGISTRY_IMAGE (:latest and :$TRACE_TAG)"
docker tag "$LOCAL_IMAGE" "$REGISTRY_IMAGE:latest"
docker tag "$LOCAL_IMAGE" "$REGISTRY_IMAGE:$TRACE_TAG"
docker push "$REGISTRY_IMAGE:$TRACE_TAG" >/dev/null
# Capture the digest from the :latest push (portable across docker versions).
PUSH_OUT="$(docker push "$REGISTRY_IMAGE:latest")"
echo "$PUSH_OUT" | tail -1
NEW_DIGEST="$(echo "$PUSH_OUT" | grep -oE 'sha256:[0-9a-f]{64}' | tail -1)"
[[ -n "$NEW_DIGEST" ]] || die "could not determine pushed image digest"
info "New digest: $NEW_DIGEST"

# ── 4. Fetch live spec, swap the pinned digest, reapply ────────────────────────
step "Rolling $SERVICE onto the new digest"
SPEC_FILE="$(mktemp -t agents_spec.XXXXXX.yml)"
ALTER_FILE="$(mktemp -t agents_alter.XXXXXX.sql)"
trap 'rm -f "$SPEC_FILE" "$ALTER_FILE"' EXIT

"${SNOW[@]}" sql --format json -q "DESCRIBE SERVICE $SERVICE" \
  | SPEC_OUT="$SPEC_FILE" TAB_HOST="$TAB_HOST" NEW_DIGEST="$NEW_DIGEST" NETWORK_MODE="$NETWORK_MODE" SPCS_HOST_MODE="$SPCS_HOST_MODE" python3 -c "
import sys, os, re, json
d = json.load(sys.stdin)
spec = d[0]['spec']
new = os.environ['NEW_DIGEST']
if '@sha256:' in spec:
    spec = re.sub(r'@sha256:[0-9a-f]+', '@' + new, spec)   # repin to the new image
else:
    # No pinned digest yet — add one so the roll is deterministic.
    spec = re.sub(r'(image:\s*\"[^\"]+\")', r'\1\n    sha256: \"@' + new + '\"', spec, count=1)
# Keep the CORS origin in step with TAB_BASE_URL (a host change otherwise leaves the old origin live).
q = chr(34)
spec = re.sub(r'(Access-Control-Allow-Origin:\s*\[)[^\]]*(\])', lambda m: m.group(1) + q + 'https://' + os.environ['TAB_HOST'] + q + m.group(2), spec)
spec = re.sub(r'(Access-Control-Allow-Origin:[ \t]*\n[ \t]*- )[^\n]*', lambda m: m.group(1) + q + 'https://' + os.environ['TAB_HOST'] + q, spec)
spec = spec.lstrip()
if spec.startswith('---'):
    spec = spec.split('\n', 1)[1]
mode = os.environ.get('NETWORK_MODE', '')
if mode:
    host_mode = os.environ['SPCS_HOST_MODE']
    custom = 'true' if host_mode == 'internal' else 'false'
    if host_mode == 'internal' and re.search(r'^[ \t]+executeAsCaller:[ \t]*\W?true', spec, re.M):
        sys.exit('executeAsCaller is set: COMPUTE_POOL network rules do not cover caller tokens, refusing SPCS_HOST_MODE=internal')
    if re.search(r'^[ \t]+SNOWFLAKE_HOST_MODE:', spec, re.M):
        spec = re.sub(r'^([ \t]+SNOWFLAKE_HOST_MODE:).*$', r'\1 ' + host_mode, spec, count=1, flags=re.M)
    else:
        m = re.search(r'^[ \t]+env:[ \t]*\n([ \t]+)', spec, re.M)
        if not m:
            sys.exit('no env: block in the live spec, cannot set SNOWFLAKE_HOST_MODE')
        spec = spec[:m.start(1)] + m.group(1) + 'SNOWFLAKE_HOST_MODE: ' + host_mode + '\n' + spec[m.start(1):]
    if re.search(r'^capabilities:', spec, re.M):
        if not re.search(r'^[ \t]+enableCustomCredentials:', spec, re.M):
            if custom == 'true':
                sys.exit('capabilities: has no enableCustomCredentials key, edit the spec by hand')
        else:
            spec = re.sub(r'^([ \t]+enableCustomCredentials:).*$', r'\1 ' + custom, spec, count=1, flags=re.M)
    elif custom == 'true':
        spec = spec.rstrip('\n') + '\ncapabilities:\n  securityContext:\n    enableCustomCredentials: true\n'
    print('network mode:', mode, '(SNOWFLAKE_HOST_MODE=' + host_mode + ', enableCustomCredentials=' + custom + ')', file=sys.stderr)
open(os.environ['SPEC_OUT'], 'w').write(spec)
print('digest pinned in spec:', new, file=sys.stderr)
"

grep -q "@$NEW_DIGEST" "$SPEC_FILE" || die "digest swap failed — aborting before ALTER"
if grep -q "Access-Control-Allow-Origin" "$SPEC_FILE"; then
  { grep -q "Access-Control-Allow-Origin: \\[\"https://${TAB_HOST}\"\\]" "$SPEC_FILE" \
    || grep -A1 "Access-Control-Allow-Origin:" "$SPEC_FILE" | grep -q "\"https://${TAB_HOST}\""; } \
    || die "CORS origin rewrite failed for https://${TAB_HOST} — aborting before ALTER"
else
  warn "no Access-Control-Allow-Origin in the live spec; CORS origin not synced"
fi
if [[ -n "$NETWORK_MODE" ]]; then
  grep -qE "^[[:space:]]+SNOWFLAKE_HOST_MODE: ${SPCS_HOST_MODE}\$" "$SPEC_FILE" \
    || die "SNOWFLAKE_HOST_MODE rewrite failed — aborting before ALTER"
  [[ "$SPCS_HOST_MODE" == account ]] \
    || warn "SPCS_HOST_MODE=internal: Snowflake accepts only the SPCS service token on this host, so forwarded user tokens fail with 395090 (and the COMPUTE_POOL network rule must be on CORTEX_TEAMS_OAUTH or they fail with 390422)"
fi
printf 'ALTER SERVICE %s FROM SPECIFICATION $$\n%s$$;\n' "$SERVICE" "$(cat "$SPEC_FILE")" > "$ALTER_FILE"
"${SNOW[@]}" sql -f "$ALTER_FILE" || die "ALTER SERVICE failed (output above)"
info "Spec reapplied."
LIVE_SPEC="$("${SNOW[@]}" sql --format json -q "DESCRIBE SERVICE $SERVICE" | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['spec'])")" \
  || die "could not read back the live spec"
grep -q "@$NEW_DIGEST" <<<"$LIVE_SPEC" || die "live spec is not pinned to $NEW_DIGEST after ALTER"
info "Live spec pinned to $NEW_DIGEST."

# ── 5. Wait for READY ──────────────────────────────────────────────────────────
step "Waiting for $SERVICE to become READY (timeout ${READY_TIMEOUT_SECS}s)"
deadline=$(( $(date +%s) + READY_TIMEOUT_SECS ))
while :; do
  status="$("${SNOW[@]}" sql --format json -q "SELECT SYSTEM\$GET_SERVICE_STATUS('$SERVICE')" 2>/dev/null \
    | python3 -c "import sys,json;d=json.load(sys.stdin);r=json.loads(list(d[0].values())[0])[0];print(r['status'],'|',r.get('message',''),'| restarts=',r.get('restartCount'),'| start=',r.get('startTime'))" 2>/dev/null || echo "UNKNOWN")"
  echo "  $status"
  [[ "$status" == READY* ]] && break
  if (( $(date +%s) > deadline )); then die "service did not reach READY within ${READY_TIMEOUT_SECS}s"; fi
  sleep 8
done

step "Done — $SERVICE is running the new image (digest $NEW_DIGEST, tag $TRACE_TAG)"
step "Smoke test"
bash "$REPO_ROOT/apps/teams/scripts/smoke-test.sh" ${CONN:+-c "$CONN"} \
  || warn "smoke test reported failures (the roll itself succeeded); see above"
