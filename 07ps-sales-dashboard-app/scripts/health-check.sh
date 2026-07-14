#!/bin/bash
# Post-deployment validation for the 07ps Sales Dashboard VPS stack.
# Usage: bash scripts/health-check.sh [domain]   (default: benmussa-invest.com)
#
# Frontend and backend are checked externally (over HTTPS, via Nginx + the real domain/subdomain).
# The ETL API is internal-only by design (see docker/nginx.conf) - it's checked over localhost, so
# this script must run ON the VPS host itself, not from your workstation.
set -u

DOMAIN="${1:-benmussa-invest.com}"
FAILURES=0

check() {
  local label="$1" url="$2"
  if curl -sf "$url" > /dev/null; then
    echo "  OK   $label ($url)"
  else
    echo "  FAIL $label ($url)"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "=== 07ps Sales Dashboard health check: $DOMAIN ==="
echo ""
echo "1. Frontend"
check "frontend" "https://$DOMAIN/"

echo "2. Backend API"
check "backend /health" "https://api.$DOMAIN/health"

echo "3. ETL Flask API (internal-only - must run on the VPS host)"
check "etl-api /health" "http://127.0.0.1:5001/health"

echo "4. Redis"
if docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
  echo "  OK   redis"
else
  echo "  FAIL redis"
  FAILURES=$((FAILURES + 1))
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== All checks passed ==="
  exit 0
else
  echo "=== $FAILURES check(s) failed - see docs/vps-deployment.md#troubleshooting ==="
  exit 1
fi
