#!/bin/bash
# Cutover for the directory-record migration (ticket 05).
#
# Run this from a terminal, not from the GUI: it stops the host, and a tool shell
# living inside that host would die with it. The script builds, stops the listener
# on 3080, migrates the legacy registry, and starts the host again — even when the
# migration fails, so the page comes back and the failure can be read.
set -uo pipefail

REPO="${HOME}/dsh-plugins/digital-human"
LOG="${HOME}/.dsh/cutover.log"
PORT=3080

mkdir -p "${HOME}/.dsh"
exec > >(tee -a "${LOG}") 2>&1
echo "=== cutover $(date) ==="

cd "${REPO}" || { echo "repo not found: ${REPO}"; exit 1; }
if ! pnpm run build:host || ! pnpm run build:client; then
  echo "build failed; the host was not touched"
  exit 1
fi

PID=$(lsof -nP -tiTCP:${PORT} -sTCP:LISTEN | head -1)
echo "host pid: ${PID:-none}"
if [ -n "${PID:-}" ]; then kill "${PID}"; fi
for _ in $(seq 1 60); do
  lsof -nP -tiTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 0.5
done

node tools/migrate.mjs --dry-run
node tools/migrate.mjs
STATUS=$?
echo "migration exit: ${STATUS}"

cd "${HOME}" || exit 1
nohup "${HOME}/.n/bin/dsh" web >> "${HOME}/.dsh/web.log" 2>&1 &
echo "host restarted (pid $!)"
echo "=== done $(date) ==="
if [ "${STATUS}" -ne 0 ]; then
  echo "MIGRATION FAILED — legacy file kept; see the log above and ${LOG}"
fi
