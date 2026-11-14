#!/usr/bin/env bash
# Starts / stops / checks the whole stack for local development.
#   scripts/dev-all.sh start | stop | status | logs <name>
# Layout expected: SmartSpec/, WorkHub/ and ForgeBridge/ side by side. Needs Docker, Node >= 22.13, JDK 21+.
# Data lives in Docker volumes (Mongo, Postgres) and ForgeBridge/data, so it survives restarts.
set -uo pipefail

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${FORGE_ROOT:-$(cd "$BRIDGE_DIR/.." && pwd)}"
RUN="${FORGE_RUN_DIR:-$ROOT/.forge-run}"
mkdir -p "$RUN"

# Development-only secrets. Override them (export before running) outside local development.
BRIDGE_SECRET="${BRIDGE_SECRET:-dev-only-bridge-secret-change-me}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-dev-only-webhook-secret}"

start_one() { # name, dir, command...
  local name="$1" dir="$2"; shift 2
  if [ -f "$RUN/$name.pid" ] && kill -0 "$(cat "$RUN/$name.pid")" 2>/dev/null; then echo "• $name already running"; return; fi
  # `;` (not &&) so only nohup is backgrounded: a backgrounded `cd && …` list would keep our stdout pipe open
  (cd "$dir" || exit 1; nohup "$@" > "$RUN/$name.log" 2>&1 < /dev/null & echo $! > "$RUN/$name.pid")
  echo "• started $name (log: $RUN/$name.log)"
}

wait_http() { # name, url, seconds
  for _ in $(seq 1 "$3"); do curl -s -o /dev/null "$2" && { echo "  ✓ $1 is up"; return 0; }; sleep 1; done
  echo "  ✗ $1 did not come up in $3s — see $RUN/$1.log"; return 1
}

case "${1:-}" in
  start)
    echo "Databases (Docker)…"
    (cd "$ROOT/SmartSpec" && docker compose up -d) >/dev/null 2>&1 || echo "  ! SmartSpec compose failed"
    (cd "$ROOT/WorkHub" && docker compose up -d) >/dev/null 2>&1 || echo "  ! WorkHub compose failed"
    sleep 8

    start_one workhub-backend "$ROOT/WorkHub/backend" env SPRING_PROFILES_ACTIVE=postgres RATE_LIMIT_ENABLED=false \
      INTEGRATION_WEBHOOK_URL=http://localhost:8090/webhooks/workhub INTEGRATION_WEBHOOK_SECRET="$WEBHOOK_SECRET" ./mvnw -q spring-boot:run
    start_one workhub-frontend "$ROOT/WorkHub/frontend" npx vite
    start_one forgebridge "$BRIDGE_DIR" env PORT=8090 BRIDGE_SECRET="$BRIDGE_SECRET" WORKHUB_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
      WORKHUB_API_URL=http://localhost:8080 WORKHUB_PUBLIC_URL=http://localhost:5173 SMARTSPEC_API_URL=http://localhost:8000 npx tsx src/main.ts
    start_one smartspec-backend "$ROOT/SmartSpec/backend" env PORT=8000 DEV=true CLIENT_URL=http://localhost:5174 \
      'MONGO_URI=mongodb://localhost:27017/smartspec?directConnection=true' REDIS_URI=redis://localhost:6488 \
      JWT_SECRET="${SS_JWT_SECRET:-dev-jwt-access-secret-change-me}" JWT_REFRESH_SECRET="${SS_JWT_REFRESH_SECRET:-dev-jwt-refresh-secret-change-me}" \
      JWT_OTP_SECRET=dev-jwt-otp-secret JWT_EMAIL_SECRET=dev-jwt-email-secret UPLOADS_PATH=./uploads \
      GOOGLE_OAUTH_CLIENT_ID="${GOOGLE_OAUTH_CLIENT_ID:-unset}" GOOGLE_OAUTH_CLIENT_SECRET="${GOOGLE_OAUTH_CLIENT_SECRET:-unset}" \
      GOOGLE_OAUTH_REDIRECT_URL=http://localhost:8000/api/auth/google/oauth \
      BRIDGE_URL=http://localhost:8090 BRIDGE_SECRET="$BRIDGE_SECRET" npx ts-node executable/command-ingress/main.ts
    start_one smartspec-frontend "$ROOT/SmartSpec/frontend" env VITE_API_TARGET=http://localhost:8000 npx vite

    wait_http workhub-backend http://localhost:8080/actuator/health 120
    wait_http forgebridge http://localhost:8090/health 30
    wait_http smartspec-backend http://localhost:8000/api/workhub/status 90
    wait_http smartspec-frontend http://localhost:5174 30
    wait_http workhub-frontend http://localhost:5173 30
    cat <<MSG

  SmartSpec  http://localhost:5174     (backend :8000)
  WorkHub    http://localhost:5173     (backend :8080)
  ForgeBridge http://localhost:8090

  Stop: $0 stop
MSG
    ;;
  stop)
    for f in "$RUN"/*.pid; do
      [ -e "$f" ] || continue
      pid="$(cat "$f")"; name="$(basename "$f" .pid)"
      # kill the whole process group of the launcher (npx/mvnw spawn children)
      pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null && echo "• stopped $name"; rm -f "$f"
    done
    pkill -f "spring-boot:run" 2>/dev/null; pkill -f WorkhubApplication 2>/dev/null
    pkill -f "command-ingress/main.ts" 2>/dev/null; pkill -f "src/main.ts" 2>/dev/null
    echo "Databases are left running; stop them with: (cd SmartSpec && docker compose down); (cd WorkHub && docker compose down)"
    ;;
  status)
    for u in "WorkHub backend|http://localhost:8080/actuator/health" "WorkHub frontend|http://localhost:5173" "ForgeBridge|http://localhost:8090/health" \
             "SmartSpec backend|http://localhost:8000/api/workhub/status" "SmartSpec frontend|http://localhost:5174"; do
      curl -s -o /dev/null "${u#*|}" && echo "✓ ${u%%|*}" || echo "✗ ${u%%|*}"
    done
    ;;
  logs) tail -n 60 -f "$RUN/${2:?name, e.g. forgebridge}.log" ;;
  *) echo "usage: $0 start|stop|status|logs <name>"; exit 1 ;;
esac
