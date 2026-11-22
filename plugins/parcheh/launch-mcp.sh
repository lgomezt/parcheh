#!/bin/sh
set -eu
umask 077
plugin=${0%/*}
digest=3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32
cache="$HOME/Library/Caches/Parcheh/runtimes/$digest"
node="$cache/node"
if [ ! -x "$node" ]; then
  /bin/mkdir -p "$cache"
  unpacked=$(/usr/bin/mktemp "$cache/node.XXXXXXXX")
  trap '/bin/rm -f "$unpacked"' EXIT
  trap 'exit 1' HUP INT TERM
  /usr/bin/gzip -dc "$plugin/runtime/node.gz" > "$unpacked"
  actual=$(/usr/bin/shasum -a 256 < "$unpacked")
  if [ "${actual%% *}" != "$digest" ]; then
    echo "The bundled Parcheh runtime failed verification." >&2
    exit 1
  fi
  /bin/chmod 700 "$unpacked"
  # A complete, verified executable becomes visible in one rename.
  /bin/mv -f "$unpacked" "$node"
  trap - EXIT HUP INT TERM
fi
exec "$node" "$plugin/src/mcp.mjs"
