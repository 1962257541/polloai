#!/bin/sh
set -eu

DISPLAY_VALUE="${DISPLAY:-:99}"
XVFB_SCREEN_VALUE="${XVFB_SCREEN:-1280x720x24}"
export DISPLAY="${DISPLAY_VALUE}"

if [ "${PERSONAL_BROWSER_HEADLESS:-1}" = "0" ]; then
    display_suffix="$(printf '%s' "${DISPLAY}" | sed 's/^://; s/\..*$//')"
    socket_path="/tmp/.X11-unix/X${display_suffix}"
    mkdir -p /tmp/.X11-unix
    rm -f "/tmp/.X${display_suffix}-lock"

    Xvfb "${DISPLAY}" -screen 0 "${XVFB_SCREEN_VALUE}" -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
    waited=0
    while [ ! -S "${socket_path}" ] && [ "${waited}" -lt 100 ]; do
        sleep 0.1
        waited=$((waited + 1))
    done
    if [ ! -S "${socket_path}" ]; then
        echo "Xvfb did not start on ${DISPLAY}" >&2
        exit 1
    fi
    fluxbox >/tmp/fluxbox.log 2>&1 &
fi

exec uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
