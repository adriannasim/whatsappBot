#!/usr/bin/env bash
set -euo pipefail
umask 077

die() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# -ge 2 && $# -le 3 ]] || die 'Usage: deploy.sh COMMIT_SHA SOURCE_TAR [--prepare]'
revision=$1
archive=$2
mode=${3:-}
[[ $revision =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ ]] || die 'Use a full lowercase Git commit SHA.'
[[ -z $mode || $mode == --prepare ]] || die 'Only --prepare is supported.'
[[ -f $archive && ! -L $archive ]] || die 'Source archive must be a regular file.'

root=${BOT_DEPLOY_ROOT:-"$HOME/apps/whatsapp-summary-bot"}
[[ $root == /* && $root != / && $root != *$'\n'* ]] || die 'Deployment root must be an absolute directory.'
shared="$root/shared"
releases="$root/releases"
service=whatsapp-summary-bot.service
# Override only for isolated offline fixtures; production uses Ubuntu's systemctl.
systemctl_bin=${BOT_SYSTEMCTL_BIN:-/usr/bin/systemctl}
[[ $systemctl_bin == /* && -x $systemctl_bin ]] || die 'systemctl is unavailable.'
for directory in "$root" "$shared" "$releases"; do
    [[ ! -L $directory ]] || die 'Deployment directories cannot be symlinks.'
done
mkdir -p "$shared" "$releases"
chmod 700 "$root" "$shared" "$releases"
exec 9>"$root/.deploy.lock"
flock -w 60 9 || die 'Another deployment is still running.'
[[ ! -e "$root/current" || -L "$root/current" ]] || die 'current must be a symlink, not a directory or file.'
[[ -f "$shared/node-bin" && ! -L "$shared/node-bin" ]] || die 'Create shared/node-bin with the absolute directory containing node and npm.'
mapfile -t node_paths < "$shared/node-bin"
[[ ${#node_paths[@]} -eq 1 ]] || die 'shared/node-bin must contain exactly one directory.'
node_bin=${node_paths[0]}
[[ $node_bin == /* && $node_bin != *:* && $node_bin != *$'\r'* && -x "$node_bin/node" && -x "$node_bin/npm" ]] || die 'shared/node-bin must name the absolute directory containing node and npm.'
export PATH="$node_bin:$PATH"
"$node_bin/node" -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || die 'Node.js 24 or later is required.'

require_inactive() {
    state=$("$systemctl_bin" is-active "$service" 2>/dev/null || true)
    case "$state" in
        inactive|failed|unknown) ;;
        *) die 'Stop the bot before preparing a release; its systemd state is not inactive.' ;;
    esac
}
if [[ $mode == --prepare ]]; then
    require_inactive
else
    [[ -f "$shared/.env" && ! -L "$shared/.env" ]] || die 'Create shared/.env and complete account pairing before enabling deployment.'
    [[ $("$systemctl_bin" show --property=LoadState --value "$service") == loaded ]] || die 'Install the whatsapp-summary-bot systemd service before enabling deployment.'
    sudo -n -l "$systemctl_bin" restart "$service" > /dev/null || die 'Allow the deployment account to restart only this service without a password.'
fi

stage=
temporary_link=
cleanup() {
    [[ -z $temporary_link ]] || rm -f -- "$temporary_link"
    [[ -z $stage ]] || rm -rf -- "$stage"
}
trap cleanup EXIT
stage=$(mktemp -d "$releases/.pending-$revision.XXXXXXXX")
# Snapshot the upload before validation so a second uploader cannot change the
# file between archive validation and extraction.
cp -- "$archive" "$stage/.source.tar"
digest=$(sha256sum "$stage/.source.tar")
digest=${digest%% *}
tar -tf "$stage/.source.tar" > "$stage/.members"
while IFS= read -r entry; do
    [[ $entry =~ ^(package\.json|package-lock\.json|src/([A-Za-z0-9_-]+\.js)?|scripts/|scripts/check-runtime\.mjs)$ ]] \
        || die 'Archive contains an unexpected path; upload only the documented source files.'
done < "$stage/.members"
tar -tvf "$stage/.source.tar" > "$stage/.types"
while IFS= read -r entry; do
    [[ $entry == -* || $entry == d* ]] || die 'Source archives must not contain symlinks, hard links, or special files.'
done < "$stage/.types"
tar --extract --file="$stage/.source.tar" --directory="$stage" --no-same-owner --no-same-permissions
for required in package.json package-lock.json src/index.js scripts/check-runtime.mjs; do
    [[ -f "$stage/$required" && ! -L "$stage/$required" ]] || die 'Source archive is missing a required file.'
done

release="$releases/$revision"
if [[ -e $release || -L $release ]]; then
    [[ -d $release && ! -L $release && -f "$release/.source-sha256" ]] || die 'An incomplete or invalid release already exists; inspect it before retrying.'
    [[ $(cat "$release/.source-sha256") == "$digest" ]] || die 'This revision already exists with different source; refusing to replace it.'
    (
        cd "$release"
        "$node_bin/node" scripts/check-runtime.mjs
    )
else
    (
        cd "$stage"
        # Install on the VM so native dependencies match ARM64 or x64.
        "$node_bin/npm" ci --omit=dev --ignore-scripts --no-audit --no-fund
        "$node_bin/node" scripts/check-runtime.mjs
    )
    printf '%s\n' "$digest" > "$stage/.source-sha256"
    rm -- "$stage/.source.tar" "$stage/.members" "$stage/.types"
    mv -- "$stage" "$release"
    stage=
fi

if [[ $mode == --prepare ]]; then require_inactive; fi
temporary_link="$root/.current-$revision-$$"
ln -s -- "$release" "$temporary_link"
mv -Tf -- "$temporary_link" "$root/current"
temporary_link=
if [[ $mode == --prepare ]]; then
    printf 'Prepared revision %s. Complete login/pairing before starting the service.\n' "$revision"
    exit 0
fi

# This is the only privileged command needed by the deployment account.
sudo -n "$systemctl_bin" restart "$service"
pid=$("$systemctl_bin" show --property=MainPID --value "$service")
[[ $pid =~ ^[1-9][0-9]*$ ]] || die 'The service has no running process; inspect journalctl. The previous release is preserved.'
for attempt in 1 2 3 4 5; do
    sleep 2
    "$systemctl_bin" is-active --quiet "$service" || die 'The service stopped after deployment; inspect journalctl. The previous release is preserved.'
    [[ $("$systemctl_bin" show --property=MainPID --value "$service") == "$pid" ]] || die 'The service restarted during the deployment check; inspect journalctl.'
done
printf 'Deployed revision %s; systemd process remained running. Verify WhatsApp readiness in the service logs.\n' "$revision"
