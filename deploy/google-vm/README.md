# GitHub Actions and a Google Cloud Ubuntu VM

This setup runs the bot directly on your Ubuntu VM, including ARM64 machines.
Node.js 24+, Git, and systemd are used. Deployments install dependencies on the VM
so they match its CPU architecture.

```text
git push main → GitHub checks/tests → upload the tested commit → install on VM
              → switch release → restart the systemd service
```

The workflow is [google-vm.yml](../../.github/workflows/google-vm.yml). Deployments
stay disabled until you finish pairing and set `GOOGLE_VM_DEPLOY_ENABLED=true`.
Keep `PTERODACTYL_PUBLISH_ENABLED` and `PTERODACTYL_DEPLOY_ENABLED` unset or false
when using this direct VM setup. Run only one bot process for the WhatsApp session.

## 1. Put the project in your GitHub repository

The repository for this setup is
[adriannasim/whatsappBot](https://github.com/adriannasim/whatsappBot).
If it is still empty, open a terminal in the complete project folder on your
computer and run:

```sh
git init -b main
git add .
git status --short
```

Review the staged paths before committing. Include the hidden `.github` directory,
`.gitignore`, source, tests, deployment files, and lockfile. Do not stage `.env`,
login/session folders, `node_modules`, or SSH keys. The supplied `.gitignore`
excludes the default credential locations; custom locations need their own rules.

Then push the first commit, using your normal GitHub sign-in:

```sh
git commit -m "Add WhatsApp summary bot and VM deployment"
git remote add origin https://github.com/adriannasim/whatsappBot.git
git push -u origin main
```

These initialization commands are for a new local checkout. If it already has Git
history or an `origin`, inspect `git status` and `git remote -v` and use the existing
repository instead. After the first push, routine updates are commits and pushes;
you do not upload ZIP files to the VM for releases.

## 2. Clone and prepare the first release on the VM

SSH into the VM as the non-root account that will own the bot. It needs sudo for
the initial service setup. First check the Node installation:

```sh
node -v
npm -v
uname -m
```

Use Node 24 or newer. `aarch64` means ARM64. Keep `node` and `npm` in the same
binary directory; a normal Node installation or an active nvm version does this.

```sh
sudo apt update
sudo apt install -y git ca-certificates util-linux
mkdir -p ~/src
git clone https://github.com/adriannasim/whatsappBot.git ~/src/whatsapp-summary-bot
cd ~/src/whatsapp-summary-bot
git switch main

umask 077
BOT_ROOT="$HOME/apps/whatsapp-summary-bot"
BOT_REVISION=$(git rev-parse HEAD)
BOT_NODE_DIR=$(dirname "$(command -v node)")
mkdir -p "$BOT_ROOT/shared" "$BOT_ROOT/incoming/$BOT_REVISION"
printf '%s\n' "$BOT_NODE_DIR" > "$BOT_ROOT/shared/node-bin"

git archive --format=tar --output="$BOT_ROOT/incoming/$BOT_REVISION/source.tar" \
  "$BOT_REVISION" package.json package-lock.json src scripts/check-runtime.mjs
bash deploy/google-vm/deploy.sh "$BOT_REVISION" \
  "$BOT_ROOT/incoming/$BOT_REVISION/source.tar" --prepare

cp -n .env.example "$BOT_ROOT/shared/.env"
chmod 600 "$BOT_ROOT/shared/.env"
```

The helper installs locked dependencies and checks their imports before selecting
the release. It does not log in or start WhatsApp. The layout is:

```text
~/apps/whatsapp-summary-bot/
  shared/           .env, node-bin, .chatgpt-auth, .baileys-auth
  releases/<sha>/   source and dependencies for each deployed commit
  current -> releases/<sha>
  incoming/<sha>/   deployment uploads
```

The checkout in `~/src` is only needed for bootstrap and manual maintenance.
Actions sends the exact tested commit for later releases; it does not run a
moving-branch `git pull` on the running application.

## 3. Connect ChatGPT and WhatsApp

All setup commands must run **inside `shared`**, where the persistent credentials
belong. Do not run the checkout's `npm run login` or `npm run groups`; that would
use a different working directory and create a separate session.

```sh
cd ~/apps/whatsapp-summary-bot/shared
nano .env
```

Set these values, leaving the model and group IDs blank until you list them:

```dotenv
AI_AUTH_MODE=chatgpt
CHATGPT_LOGIN_PORT=17778
CHATGPT_AUTH_DIR=./.chatgpt-auth
WA_AUTH_DIR=./.baileys-auth
OPENAI_MODEL=
ALLOWED_GROUP_IDS=
```

The ChatGPT callback listens only on the VM's loopback address. On **your own
computer**, with the Google Cloud CLI installed and signed into your Google Cloud
project, open an SSH tunnel. Replace the VM name, zone, and project ID:

```sh
gcloud compute ssh VM_NAME --zone=ZONE --project=PROJECT_ID -- -L 17778:127.0.0.1:17778
```

Connect as the same VM user used in step 2; specify `USER@VM_NAME` if needed. In
that SSH session:

```sh
cd ~/apps/whatsapp-summary-bot/shared
node --env-file=.env ../current/src/chatgpt-cli.js login
```

Open the printed URL in your computer's browser and authorise ChatGPT plan usage.
Keep the tunnel open until login completes. Google browser SSH or Cloud Shell
alone does not forward your computer's localhost. Do not expose port 17778 through
a public firewall rule. If plan usage was not granted, rerun the same command with
`login --enable-plan` instead of `login`.

Now list models and pair the bot account:

```sh
node --env-file=.env ../current/src/chatgpt-cli.js account
node --env-file=.env ../current/src/chatgpt-cli.js models
node --env-file=.env ../current/src/index.js --list-groups
```

On the bot phone, use WhatsApp → Linked devices → Link a device to scan the QR.
Add that account to the group if needed and rerun the group command. Edit `.env`
with an exact returned `OPENAI_MODEL` and the selected `ALLOWED_GROUP_IDS`, including
their `@g.us` suffixes. Separate multiple groups with commas.

Test in the foreground:

```sh
node --env-file=.env ../current/src/index.js
```

From your own WhatsApp account, reply to a starting message, select the bot using
the actual mention picker, and send `!summarise`. Keep the bot phone online for
history requests. After the test succeeds, press Ctrl+C before creating the service.

## 4. Keep the bot running with systemd

Run these setup commands on the VM as the same non-root account. They create a
service using its exact Node path and the persistent working directory:

```sh
BOT_ROOT="$HOME/apps/whatsapp-summary-bot"
BOT_USER=$(id -un)
BOT_NODE_DIR=$(cat "$BOT_ROOT/shared/node-bin")

sudo tee /etc/systemd/system/whatsapp-summary-bot.service >/dev/null <<EOF
[Unit]
Description=WhatsApp group summary bot
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$BOT_USER
WorkingDirectory=$BOT_ROOT/shared
ExecStart="$BOT_NODE_DIR/node" --env-file=.env "$BOT_ROOT/current/src/index.js"
UMask=0077
KillSignal=SIGINT
TimeoutStopSec=30
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo chmod 644 /etc/systemd/system/whatsapp-summary-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now whatsapp-summary-bot.service
sudo systemctl status whatsapp-summary-bot.service --no-pager
```

Grant the deployment account passwordless permission for only the restart command
used by the helper:

```sh
printf '%s ALL=(root) NOPASSWD: /usr/bin/systemctl restart whatsapp-summary-bot.service\n' \
  "$BOT_USER" | sudo tee /etc/sudoers.d/whatsapp-summary-bot >/dev/null
sudo chmod 440 /etc/sudoers.d/whatsapp-summary-bot
sudo visudo -cf /etc/sudoers.d/whatsapp-summary-bot
sudo -n -l /usr/bin/systemctl restart whatsapp-summary-bot.service
```

Check logs with `sudo journalctl -u whatsapp-summary-bot.service -n 50 --no-pager`.
Look for `Ready in ...` and test a summary again. Service state alone does not
verify WhatsApp authentication or history retrieval.

## 5. Configure GitHub's SSH access

The hosted Actions runner must be able to reach the VM's SSH host and port. A
stable external IP or DNS name avoids changing the secret after VM restarts.
Browser SSH access alone does not establish access for an ordinary SSH key. If the
VM has no reachable SSH endpoint, or Google OS Login prevents local
`authorized_keys` use, configure an appropriate deployment access method first;
the supplied workflow uses ordinary SSH, not Google IAM/IAP authentication.

Create a dedicated Actions key on your own computer:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/whatsappbot_actions -C github-actions-whatsappBot -N ""
```

Append its `.pub` content to the **same VM user's** `~/.ssh/authorized_keys`, with
`restrict ` before `ssh-ed25519`. Preserve existing keys. Keep `~/.ssh` at mode
700 and `authorized_keys` at 600. `restrict` disables forwarding and PTY features
that this deployment does not need. Do not use this restricted key for the
interactive ChatGPT login tunnel.

Obtain the VM's public host key through your existing trusted VM console:

```sh
sudo cat /etc/ssh/ssh_host_ed25519_key.pub
```

In the repository's Settings → Secrets and variables → Actions, create:

| Secret | Value |
| --- | --- |
| `VM_HOST` | Reachable VM IPv4 address or DNS name |
| `VM_USER` | The non-root VM user from the setup above |
| `VM_SSH_KEY` | Complete private contents of `whatsappbot_actions`, including the key headers |
| `VM_KNOWN_HOSTS` | A known-hosts line: `VM_HOST ssh-ed25519 PUBLIC_HOST_KEY` |

For a nondefault SSH port, set repository variable `VM_SSH_PORT`; its default is
22. Use `[VM_HOST]:PORT` as the hostname field in `VM_KNOWN_HOSTS` for a nondefault
port. The public host key must match the one obtained through the trusted console;
the workflow does not discover and trust a key automatically during deployment.

Never commit the Actions private key, `.env`, or credential folders. GitHub access
to a private source repository is handled by Actions; the VM does not need a
GitHub token for ongoing deployment.

## 6. Enable automatic deployment

Once login, pairing, foreground testing, and the service are working, set this
GitHub repository **variable**:

```text
GOOGLE_VM_DEPLOY_ENABLED=true
```

Run **Test and deploy to Google VM** from Actions on `main`, or push the next
commit to `main`. Pull requests run checks only. Main releases are serialized.
The VM installs and checks the new release before switching `current` and
restarting the service. The workflow waits briefly for a stable systemd process;
check the journal and a real summary after your first release.

## Updates and recovery

- Commit and push normal code changes through GitHub. Keep merge access and
  workflow changes limited to people trusted with the bot account and credentials.
- Pause deployment by setting `GOOGLE_VM_DEPLOY_ENABLED=false` before stopping the
  service for login/logout, configuration changes, or session maintenance. Run any
  maintenance CLI from `shared`, then restart the service and re-enable deployment.
- Back up `shared` privately. Deployments preserve it, but deleting the VM or disk
  does not. New code still runs with access to these credentials.
- Failed installation/import checks leave `current` and the existing service
  alone. A failure after switching/restarting can leave the bot unavailable; no
  automatic rollback is attempted. Previous releases remain available for diagnosis.
- Prefer a Git revert and a new passing deployment for rollback. For an urgent
  manual rollback, disable CD, stop the service, use the trusted checkout's helper
  with a retained revision/archive and `--prepare`, then start the service again.
- Incoming archives and older releases are retained. Monitor disk space and remove
  only releases/uploads you no longer need, while deployment is paused. Never
  remove `shared` or the release selected by `current`.
- If the Node installation path changes, update `shared/node-bin` and the unit's
  `ExecStart` together, then run `sudo systemctl daemon-reload` and restart.

Offline tests check deployment failure and activation paths with fixtures. They
do not verify your Google firewall/SSH setup, live login, or WhatsApp history.
