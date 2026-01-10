#!/bin/sh
set -e

STARTUP_DELAY_MAX="${STARTUP_DELAY_MAX:-30}"

DELAY=$(awk -v max="$STARTUP_DELAY_MAX" 'BEGIN{srand(); print int(rand()*(max+1))}')

echo "Startup delay: ${DELAY}s (max=${STARTUP_DELAY_MAX}s)"
sleep "$DELAY"

exec "$@"
