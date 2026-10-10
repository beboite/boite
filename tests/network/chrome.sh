#!/usr/bin/env bash
# Chrome as the e2e launcher calls it, adapted to a namespace: uid 0 inside a
# user namespace needs --no-sandbox, the host's AMD GPU replaces d3d11, and the
# resolver rules come from BENCH_RESOLVER_RULES instead of blocking every name.
args=()
for a in "$@"; do
  case "$a" in
    --host-resolver-rules=*) [ -n "${BENCH_RESOLVER_RULES:-}" ] && args+=("--host-resolver-rules=$BENCH_RESOLVER_RULES") ;;
    --use-angle=*) args+=(--use-angle=gl-egl) ;;
    *) args+=("$a") ;;
  esac
done
exec /usr/bin/google-chrome --no-sandbox --enable-gpu --disable-software-rasterizer ${BENCH_CHROME_ARGS:-} "${args[@]}"
