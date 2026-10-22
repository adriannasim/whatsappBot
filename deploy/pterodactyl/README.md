# GitHub Actions and Pterodactyl

Use this setup when you control a Pterodactyl 1.x node. It supplies the bot's
runtime image and egg; no existing server or GitHub repository has been changed
by generating these files.

The release path is:

```text
Push main → dependency/runtime checks and tests → publish GHCR image → preflight Panel
          → stop bot → record tested revision → start bot → check process state
```

Code and locked dependencies live in the image at `/opt/bot`. Pterodactyl mounts
persistent server data at `/home/container`, containing `.env`, `.chatgpt-auth`,
and `.baileys-auth` (or your configured `WA_AUTH_DIR`). Deployments replace the image and preserve
that volume. Back up the volume securely; do not commit it or put it in Actions
artifacts. Panel environment values override values in `.env`.

## 1. Push the source to GitHub

Create a repository and push this project, including hidden files such as
`.github`, `.dockerignore`, and `.gitignore`. Use a private repository if desired.
Commit `package-lock.json` so image builds use the same dependency versions.
Before pushing, review `git status`: `.env`, credentials, WhatsApp session files,
`node_modules`, and ZIP archives must be excluded. Custom `CHATGPT_AUTH_DIR` and
`WA_AUTH_DIR` locations need matching ignore rules if they are inside the repository.

In GitHub, open Settings → Secrets and variables → Actions → Variables and set:

```text
PTERODACTYL_PUBLISH_ENABLED=true
```

Leave `PTERODACTYL_DEPLOY_ENABLED` unset during initial setup. Run the **Test and
deploy to Pterodactyl** workflow on `main`, or push a new commit. This runs tests
and publishes the image without contacting your panel. The image names are:

```text
ghcr.io/your-github-owner/your-repository:production
ghcr.io/your-github-owner/your-repository:<full-commit-sha>
```

The workflow derives the lowercase owner/repository name automatically and uses
GitHub's built-in publishing token. The template builds `linux/amd64`; change
`platforms` in the workflow if your Wings node uses a different architecture.

GHCR packages may initially be private. Either deliberately make the package
public or configure the Wings node's `docker.registries` entry for `ghcr.io`
with a credential that can read that package. Use a separate read-only registry
credential; do not copy the Actions publishing token to Wings. See the
[Wings registry configuration](https://docs.pterodactyl.io/v1/wings/configuration).

## 2. Import the egg and create the server

1. Import `egg-whatsapp-summary-bot.json` into a nest in your Panel.
2. Replace `ghcr.io/OWNER/REPO:production` in the egg's Docker Images with the
   real image name from step 1. Keep that same image selected on the server.
3. Create the server with this egg. About 1–2 GB RAM is a reasonable starting
   allocation for modest group traffic; monitor your actual load and adjust it.
   Keep enough persistent disk for authentication state and logs. Pterodactyl may
   require a primary allocation; the normal bot does not expose a public port.
4. Keep `BOT_MODE=check`, `WA_AUTH_DIR=./.baileys-auth`, and `EXPECTED_REVISION`
   blank for bootstrap. Start the server and inspect its console.

The image contains Node 24, Baileys dependencies, CA certificates, and `tini`.
WhatsApp connects directly through Baileys; no Chrome installation, browser
process, or browser sandbox setting is required. Some Baileys dependencies use
native binaries, so the image architecture must match the Wings node.

Check mode imports dependencies without opening a socket or accessing login
files. Success prints `Runtime check passed.` and exits normally. Returning to
offline is expected for this setup command. It confirms dependency loading,
not live WhatsApp connectivity, history availability, or resource sufficiency.

### Upgrading an existing whatsapp-web.js deployment

Pause automatic deployment and stop the old bot. Publish the Baileys image,
update/import the egg, and remove obsolete `CHROME_EXECUTABLE_PATH` and
`CHROME_NO_SANDBOX` settings. Keep the persistent volume and ChatGPT credentials.
Set `EXPECTED_REVISION` to the new image's full commit SHA before starting it;
the previous image's SHA will intentionally reject the new image.
The new runtime does not read or migrate `.wwebjs_auth` or `.wwebjs_cache`; leave
old session folders private while retiring the old linked device.

Start once in `check` mode, then use `groups` mode to pair a new Baileys device.
Recheck the group IDs and change back to `run` before enabling automatic deployment.
The new WhatsApp authentication directory is `.baileys-auth` by default. A new QR
pairing is required even though the old server volume has a WhatsApp Web session.

## 3. Sign in to ChatGPT on the server

The bot's OAuth callback stays bound to `127.0.0.1`. The Pterodactyl console is
stdin for the running process, not a shell. A public server allocation cannot
reach a listener bound to the container's loopback interface.

As node administrator, use a temporary maintenance container with host networking
and the **same bot volume**, while the Pterodactyl server is stopped. This lets
an SSH tunnel reach the callback and creates the bot's registration directly in
its server storage. There is no need to copy another computer's tokens or host ID.

On your own computer, open a terminal and connect to the Wings node:

```sh
ssh -L 17778:127.0.0.1:17778 your-user@your-node
```

In that SSH session, select the exact data directory mounted at `/home/container`
for this bot server. Check the node's configured volume path or the container's
mounts; do not use the volume of another server. Then run:

```sh
BOT_VOLUME=/actual/host/path/to/this-server-volume
BOT_IMAGE=ghcr.io/your-github-owner/your-repository:production

docker run --rm -it --network host \
  --mount "type=bind,src=$BOT_VOLUME,dst=/home/container" \
  --env BOT_MODE=login \
  --env AI_AUTH_MODE=chatgpt \
  --env CHATGPT_LOGIN_PORT=17778 \
  "$BOT_IMAGE"
```

The image runs as UID/GID 1000. If Wings uses another runtime UID/GID, pass that
matching non-root `--user UID:GID` to Docker and ensure it can write the volume.
Keep the SSH tunnel open, copy the printed authorization URL into a browser on
**your own computer**, and complete consent there. Its redirect goes through
the tunnel to the temporary container. The container exits after login; the
credential files remain in the persistent volume. Do not run this maintenance
container alongside the bot or another credential-management process.

If you need to authorize plan usage again, use the same mount/tunnel with an
explicit maintenance entrypoint (repeat the same UID override if applicable):

```sh
docker run --rm -it --network host \
  --mount "type=bind,src=$BOT_VOLUME,dst=/home/container" \
  --env AI_AUTH_MODE=chatgpt --env CHATGPT_LOGIN_PORT=17778 \
  --entrypoint node "$BOT_IMAGE" \
  --env-file-if-exists=/home/container/.env \
  /opt/bot/src/chatgpt-cli.js login --enable-plan
```

The first maintenance command may need `docker login ghcr.io` on the node for a
private image; the Docker CLI and Wings do not necessarily share registry login
configuration. Do not publish the OAuth callback or attach your laptop's whole
`.chatgpt-auth` directory to the server.

## 4. Pair WhatsApp and choose the model/groups

Change `BOT_MODE` in the Panel Startup settings, then start the server for each
setup action. These modes run to completion and exit:

| Mode | Result |
| --- | --- |
| `account` | Shows the connected ChatGPT account |
| `models` | Lists models available to that account |
| `groups` | Displays WhatsApp QR if needed, then lists group IDs |
| `check` | Imports Node/Baileys dependencies without connecting |

Set `OPENAI_MODEL` to an exact returned ID, or leave it blank for the first visible
model. In `groups` mode, scan the QR using the **bot phone** → WhatsApp → Linked
devices. Set `ALLOWED_GROUP_IDS` to the selected IDs, comma-separated. Then set
`BOT_MODE=run` and start the server. Confirm the console reaches `Ready in ...`
and try a quoted, mentioned `!summarise` command in an allowed group. Keep the
bot account's primary phone online: Baileys on-demand history requests depend on
that phone responding. Set `HISTORY_TIMEOUT_MS` in the Panel Startup settings
from 5,000 to 120,000 milliseconds; the default is 60,000 (60 seconds). The panel
value overrides `.env`. A longer timeout cannot recover history missing from the
phone.

`AI_AUTH_MODE=chatgpt` uses the authorized ChatGPT plan. Optional `api-key` mode
requires a separate billed API key in the server's private `.env`. Keep secrets
out of egg exports, GitHub source, and image build arguments.

## 5. Enable continuous deployment

Create a dedicated Panel subuser with access only to this bot server. Give it:

- `startup.read` and `startup.update`
- `control.stop` and `control.start`

Create a **Client API key** for that subuser. Do not use an Application/admin API
key. In GitHub Actions repository secrets, add:

| Secret | Value |
| --- | --- |
| `PANEL_URL` | HTTPS Panel base URL, e.g. `https://panel.example.com` |
| `PTERODACTYL_SERVER_ID` | Server identifier from `/server/xxxxxxxx`, or full UUID; not numeric admin ID |
| `PTERODACTYL_API_KEY` | Dedicated subuser's Client API key |

The GitHub runner must be able to reach the panel's HTTPS API and trust its
certificate. For a private panel, use an appropriately connected runner or
private network integration; do not disable TLS checks. Review whether granting
the runner private-network access is appropriate for your repository.

Finally set this GitHub Actions repository variable:

```text
PTERODACTYL_DEPLOY_ENABLED=true
```

This also enables publication, so the separate publish-only variable may remain
or be removed. Deployment preflight requires the egg's editable
`EXPECTED_REVISION` and `BOT_MODE=run`, so it does not interrupt setup modes.
Every passing `main` release then publishes and replaces the runtime. Pull
requests run dependency/runtime checks and tests without publishing or deploying. Keep merge access and workflow changes restricted to
people you trust with production deployment.

Main releases are serialized, and the entrypoint compares the image's embedded
revision with the exact tested SHA set through the API. If Wings cannot pull the
new image and falls back to a cached one, a mismatched image refuses to start.
This can leave the bot offline until the pull problem is fixed; it never silently
runs a different revision as the requested deployment.

The deployment script stops gracefully, waits for offline, changes the revision,
then starts and waits for running. The final API check confirms a process state;
it does not verify WhatsApp authentication or successful summarisation. Check the
console after a release. Failed or ambiguous power requests are not blindly
retried, and failed deployment does not automatically roll back.

## Operations and recovery

- Pause Actions deployment before changing setup mode, logging in/out, or restoring
  session files. Stop the bot before credential maintenance; restart afterward.
- To roll back source, revert the change on `main` and let CI build a new revision.
  For an urgent manual rollback, first pause CD, stop the server, select a retained
  immutable image in the egg/server, and set its matching `EXPECTED_REVISION`.
  Restore the `:production` image selection before enabling CD again.
- After a ChatGPT plan-limit pause, restore access and restart the bot.
- Deleting/reinstalling a server or deleting its volume can erase login sessions.
  Image replacement alone preserves them; do not use reinstall as a deploy step.
- The image entrypoint accepts only the documented `BOT_MODE` values. Changing
  the displayed `STARTUP` command does not execute arbitrary shell commands.
- Run one active instance for a WhatsApp session and one credential owner per
  ChatGPT registration. Do not share the same session volume between replicas.

## Included checks and limitations

`npm test` covers the bot and mocked deployment flow, including wrong configuration,
setup-mode rejection, stopped/running transitions, timeouts, API failures, and
credential redaction. The runtime files also have syntax/JSON validation. Live
GitHub publication, Panel deployment, account pairing, and on-demand phone history
retrieval require your actual repository, node, and WhatsApp account. They are not
implied by offline checks. `npm run runtime:check` imports the installed packages
without connecting to WhatsApp or reading credentials.

Primary references: [Pterodactyl custom eggs](https://docs.pterodactyl.io/v1/guides/egg-creation/creating-custom-egg),
[Wings image lifecycle](https://github.com/pterodactyl/wings/blob/develop/environment/docker/container.go),
[Baileys documentation](https://baileys.wiki/), and
[ChatGPT on self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms).
