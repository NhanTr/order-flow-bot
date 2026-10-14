#!/bin/sh
set -eu

require_password() {
  value=$(printenv "$1")
  case "$value" in
    (*[!A-Za-z0-9._~-]*|'') echo "$1 must contain only URL-safe characters" >&2; exit 1 ;;
  esac
  if [ "${#value}" -lt 24 ]; then
    echo "$1 must contain at least 24 characters" >&2
    exit 1
  fi
}

require_password REDIS_ADMIN_PASSWORD
require_password REDIS_API_PASSWORD
require_password REDIS_BFF_PASSWORD
require_password REDIS_WORKER_PASSWORD
REDIS_HOST=${REDIS_HOST:-redis}

if redis-cli -h "$REDIS_HOST" ping >/dev/null 2>&1; then
  redis_command() {
    redis-cli -h "$REDIS_HOST" "$@"
  }
elif REDISCLI_AUTH="$REDIS_ADMIN_PASSWORD" redis-cli -h "$REDIS_HOST" --user order_flow_admin ping >/dev/null 2>&1; then
  redis_command() {
    REDISCLI_AUTH="$REDIS_ADMIN_PASSWORD" redis-cli -h "$REDIS_HOST" --user order_flow_admin "$@"
  }
else
  echo "Redis bootstrap authentication failed" >&2
  exit 1
fi

redis_command ACL SETUSER order_flow_admin reset on ">$REDIS_ADMIN_PASSWORD" ~* +@all >/dev/null
redis_command ACL SETUSER order_flow_api reset on ">$REDIS_API_PASSWORD" \
  '~order-flow:auth-session:v1:*' '~order-flow:security:v1:*' \
  +@connection +@read +@write +@scripting >/dev/null
redis_command ACL SETUSER order_flow_bff reset on ">$REDIS_BFF_PASSWORD" \
  '~order-flow:bff-refresh:v1:*' \
  +@connection +@read +@write +@scripting >/dev/null
redis_command ACL SETUSER order_flow_worker reset on ">$REDIS_WORKER_PASSWORD" \
  '~bull:telegram-notifications:*' \
  +@all -acl -config -debug -shutdown -flushall -flushdb -keys >/dev/null
redis_command ACL SETUSER default off >/dev/null

echo "Redis runtime ACL bootstrap completed"
