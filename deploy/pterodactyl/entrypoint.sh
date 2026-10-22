#!/bin/sh
set -eu
umask 077
cd /home/container

revision=$(cat /opt/bot/REVISION)
if [ -n "${EXPECTED_REVISION:-}" ]; then
    case "$EXPECTED_REVISION" in
        *[!a-f0-9]*|'')
            echo 'EXPECTED_REVISION must be a full lowercase Git commit SHA.' >&2
            exit 1
            ;;
    esac
    if [ "${#EXPECTED_REVISION}" -ne 40 ] && [ "${#EXPECTED_REVISION}" -ne 64 ]; then
        echo 'EXPECTED_REVISION must be a full lowercase Git commit SHA.' >&2
        exit 1
    fi
    if [ "$revision" != "$EXPECTED_REVISION" ]; then
        echo 'Image revision does not match EXPECTED_REVISION. Refusing to run stale code; check the image pull and deployment.' >&2
        exit 1
    fi
fi

# Pterodactyl supplies STARTUP, but this image uses only these explicit modes.
# Nothing from STARTUP or other panel variables is evaluated as shell code.
case "${BOT_MODE:-run}" in
    run)
        exec node --env-file-if-exists=/home/container/.env /opt/bot/src/index.js
        ;;
    groups)
        exec node --env-file-if-exists=/home/container/.env /opt/bot/src/index.js --list-groups
        ;;
    models|account|login|logout)
        exec node --env-file-if-exists=/home/container/.env /opt/bot/src/chatgpt-cli.js "$BOT_MODE"
        ;;
    check)
        exec node --env-file-if-exists=/home/container/.env /opt/bot/scripts/check-runtime.mjs
        ;;
    *)
        echo 'BOT_MODE must be run, groups, models, account, check, login, or logout.' >&2
        exit 1
        ;;
esac
