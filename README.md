# WhatsApp group summary bot

Reply to the message where a summary should begin, select the bot from WhatsApp's
**@mention picker**, and send:

```text
@SummaryBot !summarise
```

The bot summarises from the quoted message **inclusive** to your command
**exclusive**, using recently received messages in its bounded local buffer first.
If that range is unavailable locally or crosses a connection gap, it requests
available history from the bot phone.
It replies in the same group. Messages after the command and the bot's previous
replies are excluded.

Replies show a compact heading, the date/time range in Malaysia time (MYT), and
the message count, followed by one bullet per topic with WhatsApp bold labels.
For example, when supported by the conversation:

```text
- *Bot test:* Adrianna tested the WhatsApp bot.
- *Dinner:* Subway salad for dinner.
```

Decisions, action items, and open questions get separate headings only when useful.

You can also send these commands in any selected group without mentioning the bot
or replying to another message:

| Command | Reply |
| --- | --- |
| `!gm` | Good morning, a real @mention of the sender, and a short encouraging message for the day. |
| `!gn` | Good night, a real @mention of the sender, and a short message about resting and appreciating the day's effort. |

Both commands are case-insensitive and choose from a built-in collection of
original phrases. They do not request chat history or use the ChatGPT allowance.
Greeting commands and the bot's replies are excluded from summaries. Replayed
commands after a reconnect or restart do not trigger another greeting.

WhatsApp connectivity uses [Baileys](https://baileys.wiki/), directly from Node.js.
No Chrome installation or browser process is needed for WhatsApp. The default AI
mode uses **Continue with ChatGPT**, with a model you can choose in `.env`, through
OpenAI's [official sign-in integration](https://developers.openai.com/siwc/token-sharing-open-source).
ChatGPT sign-in still uses a browser for consent.

The bot keeps a **bounded incoming-message buffer for allowed groups**, saved
privately on the server so it can survive deployments, restarts, and disconnects.
It retains only text/captions and the metadata needed to identify senders and range
boundaries, for up to **24 hours and 3,000 messages per group**. A **32 MiB global
retained-content cap** can evict messages earlier. The default snapshot is
`./data/recent-messages/cache.json`, controlled by `RECENT_MESSAGES_DIR`. The bot
does not download media or request a full history sync at startup. Baileys saves
authentication and encryption keys so the linked device can reconnect. A separate
small cache of outgoing bot replies supports WhatsApp delivery retries.

## What you need

- Node.js **24 or later** on a computer that stays on while the bot is in use.
- A WhatsApp account for the bot, added to your friends' group. Keep its **primary
  phone online** when older or missing messages need to be fetched from that phone.
- A ChatGPT account with permission to share plan usage with this app. Sign-in and
  model discovery determine the actual account/workspace access.
- Group members who know that requested conversation excerpts are sent to OpenAI
  for summarisation and that the summary is posted back to the group.

Baileys is an unofficial WhatsApp client. WhatsApp can restrict accounts using
unofficial clients. A dedicated bot number keeps this separate from your everyday
account. The project pins Baileys `7.0.0-rc14`; dependency changes should be tested
before deployment.

## Migrating from the previous version

Stop the old bot before installing this version. Keep your private `.env` and
`.chatgpt-auth` folder, replace the source and lockfile, and run `npm ci`.

**The old whatsapp-web.js session cannot be reused by Baileys.** Run
`npm run groups` and scan a fresh QR code. The new session defaults to
`.baileys-auth` (`WA_AUTH_DIR`); the bot does not read or convert `.wwebjs_auth`
or `.wwebjs_cache`. Keep any old session folders private while retiring the old
linked device through WhatsApp's Linked devices screen.

Remove obsolete `CHROME_EXECUTABLE_PATH` and `CHROME_NO_SANDBOX` settings from
`.env` or the panel. On Pterodactyl, import/update the new egg and publish the new
image; `BOT_MODE=check` now checks Node/Baileys dependencies. Your ChatGPT model,
authorisation, and group allowlist can stay configured, but verify the group IDs
reported by the newly linked account before starting.

## Set up

1. Extract this project and open a terminal in its directory:

   ```sh
   npm ci
   cp .env.example .env
   npm run runtime:check
   ```

   On Windows, you can copy `.env.example` using your file manager. The runtime
   check imports dependencies without opening a WhatsApp connection or reading
   authentication files.

2. Sign in with ChatGPT:

   ```sh
   npm run login
   ```

   Open the displayed URL in a browser **on the same computer** as this command.
   Choose your account/workspace and approve plan usage. The browser returns to a
   temporary local callback; the terminal confirms the connection. The app cannot
   access your existing ChatGPT conversations. For a remote server, follow the
   [Google VM login instructions](deploy/google-vm/README.md) or
   [Pterodactyl login instructions](deploy/pterodactyl/README.md).

   If identity sign-in succeeds without plan usage, run:

   ```sh
   npm run login -- --enable-plan
   ```

3. List models and edit `.env`:

   ```sh
   npm run models
   ```

   ```dotenv
   AI_AUTH_MODE=chatgpt
   OPENAI_MODEL=
   ```

   Set `OPENAI_MODEL` to an exact returned ID. Leaving it blank uses the account
   catalog's first visible model. Startup prints the selection and stops with
   guidance if an explicit model is unavailable. Restart after changing it.
   No API key is needed in ChatGPT mode.

4. Add the bot number to your group, then pair WhatsApp and list groups:

   ```sh
   npm run groups
   ```

   On the **bot's phone**, open WhatsApp → Linked devices → Link a device and scan
   the terminal QR. Keep the QR and `.baileys-auth` folder private. This command
   prints group names and IDs, then exits without sending messages. If a newly
   joined group is missing, confirm membership on the bot phone and rerun.

5. Set the allowed groups and retrieval limits in `.env`:

   ```dotenv
   ALLOWED_GROUP_IDS=your_group_id_from_the_list
   WA_AUTH_DIR=./.baileys-auth
   RECENT_MESSAGES_DIR=./data/recent-messages
   MAX_HISTORY_MESSAGES=3000
   HISTORY_TIMEOUT_MS=60000
   ```

   Copy exact group IDs, including `@g.us`; separate multiple IDs with commas.
   Only these groups are processed. The timeout can be 5,000–120,000 milliseconds.

6. Start the bot:

   ```sh
   npm start
   ```

   After the bot is connected, send a few new messages in an allowed group. From
   your own account, reply to the first of those messages, select the bot in the
   mention picker, and send `!summarise` in that same reply. Typing a display name
   without making an actual mention will not trigger it. The bot account cannot
   trigger itself. The first installation, or the first upgrade from the RAM-only
   version, starts an empty saved buffer: existing RAM-only messages cannot be
   carried across that upgrade. Subsequent deployments and restarts restore
   unexpired saved messages. Re-linking WhatsApp is not needed for this change.

Keep the process running and the bot phone available for history requests. Stop
with Ctrl+C. The saved Baileys session normally avoids another QR scan on restart;
if WhatsApp logs the device out, pair it again.

## GitHub and server hosting

For a Google Cloud Ubuntu VM, use the [GitHub Actions and Google VM guide](deploy/google-vm/README.md).
It deploys each tested Git commit over SSH, installs dependencies on the VM for
ARM64 or x64, and restarts a systemd service. WhatsApp and ChatGPT login files and
the bounded message buffer stay in a persistent folder across releases. Begin with the one-time GitHub/VM setup;
routine updates are commits and pushes rather than manual file uploads.

The project includes a Node 24/Baileys image, a Pterodactyl egg, and GitHub Actions
for dependency checks, tests, image publication, and deployment. See the
[Pterodactyl setup guide](deploy/pterodactyl/README.md). There is no browser runtime
or browser sandbox configuration in this version. Publishing and deployment
remain disabled until you enable their repository variables. Login files and the
bounded message buffer stay in the server's persistent volume, outside Git and the image.

## Accounts, models, and plan usage

To change the model, run `npm run models`, update `OPENAI_MODEL`, then restart.

```sh
npm run account                       # Connection and configured model
npm run account -- list               # Saved account/workspace registrations
npm run login -- --new-account        # Connect another account/workspace
npm run account -- use CLIENT_ID      # Select a saved registration
npm run logout                        # Revoke and clear the active ChatGPT tokens
```

Stop the bot before ChatGPT login/logout or account switching; restart after the
change so its account and model match the selected registration. `npm run logout`
affects ChatGPT credentials, not the WhatsApp linked device. Logout retains the
installation ID and registration information for reconnection. If remote revocation
cannot be confirmed, the CLI explains how to revoke access under ChatGPT Settings
→ Security and login → Login connections.

Summaries consume the signed-in account's ChatGPT plan allowance. Check
[Manage usage](https://chatgpt.com/settings/usage) for usage and app controls. A
plan-limit error pauses new summaries; restore access and restart to resume.
The bot does not purchase credits and never automatically falls back to API-key
billing. Public or paid deployment has additional eligibility steps in the
[official overview](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt).

### Optional API-key mode

To explicitly choose separately billed OpenAI API usage, edit `.env` and restart:

```dotenv
AI_AUTH_MODE=api-key
OPENAI_API_KEY=your_api_key_here
OPENAI_MODEL=gpt-4.1-mini
```

Run `npm run models` in this mode to inspect the API account's catalog. Choose a
model that supports text generation through the Responses API; the general API
catalog can include models intended for other tasks. ChatGPT credentials are not
used in this mode. A leftover API key is ignored in ChatGPT mode.

### Running on your ChatGPT Dot

Attach the project's ZIP to your Dot's conversation and ask:

> Install and run this Baileys WhatsApp summary bot on your cloud computer. Use
> ChatGPT sign-in and keep the model configurable. Follow README.md, check Node 24
> and dependency support, and keep the session folders persistent. Hand control
> to me for ChatGPT consent and show me the WhatsApp QR to scan. Ask which groups
> to enable, then report the actual process state and hosting limits.

Your Dot can open its own browser for ChatGPT consent. Use its profile → Computers
→ cloud computer → Take over to sign in, then return control. WhatsApp itself
runs through Baileys and displays a terminal QR. Dot's public documentation does
not guarantee uninterrupted hosting of arbitrary background processes; confirm
its process behaviour before relying on it continuously. Downloading this ZIP
does not deploy it to your Dot. See the [Dot computers guide](https://learn.chatgpt.com/docs/dots/computers-and-apps).

## History and summary limits

- Incoming messages from allowed groups are buffered while the bot is connected.
  A valid command with a real bot mention and quoted starting message first checks
  whether the buffer contains the available range from that start to the command
  within one uninterrupted connection. If it does, the bot uses that range without
  fetching phone history.
- The buffer retains minimal text/captions and sender/boundary metadata for up to
  24 hours, at most 3,000 messages per allowed group, and 32 MiB across all groups.
  Size limits can evict messages sooner. The buffer is saved privately and restored
  on startup for the same bot account and current group allowlist. Restart or
  WhatsApp disconnect preserves its unexpired contents and marks a recovery gap.
  Restoring a message does not reset its original expiry. Expired entries are
  removed on restore and every minute while the application is running; a snapshot
  left on disk while the bot is stopped does not make expired messages eligible.
- When WhatsApp delivers missed messages after reconnection, the bot merges them
  into the buffer without executing replayed commands. The snapshot records the
  last known message key and timestamp, and incoming rows are deduplicated by key.
  This does not provide a reliable fetch-all-since-time operation. Delivery is
  best effort: WhatsApp may return no earlier messages, even when they are visible
  on the primary phone. Persistence preserves messages already received; it cannot
  guarantee recovery of everything sent while the bot was offline.
- For an older or missing range, Baileys asks the bot account's primary phone for
  history. Requests page backward from the command in batches of up to 50 messages,
  within the configured cap (3,000 by default). Keep the phone online for this
  fallback. Requests can still time out, be rejected, or return limited history.
  An anchor from before the bot joined, or one absent from the phone, may be unavailable.
  An empty first response triggers one retry of the same command boundary after
  two seconds, within the original timeout, to allow for delivery lag on the phone.
- A range crossing an offline or recovery gap first attempts phone-history
  retrieval. If recovery fails but the exact quoted starting message is retained,
  the bot can summarise the known messages in that range with this warning:
  **Some messages from an offline or recovery gap may be missing.** It does not
  present that subset as a complete conversation.
- The exact quoted starting message must be available before any transcript is
  sent to AI. If it is missing, the bot asks for a newer starting point or a retry;
  it does not silently substitute a different range.
- The command supplies the ending boundary. Later messages and previous bot replies
  are excluded. Summaries cover **available** messages; retrieving the starting
  message does not prove that every message in the range was retained by WhatsApp.
- Text and image/video/document captions are supported. Voice notes, image/file
  contents, and view-once messages are not summarised. Deleted messages, summary
  commands, and the bot's own messages are excluded. When the bot receives an edit
  or deletion, it removes the previous buffered content; edited messages may be
  omitted from summaries. Old edits and deleted content cannot be reconstructed.
- AI input is capped at 60,000 characters including names and timestamps. Oversized
  requests ask for a newer start; input is not silently truncated.
- One summary per group runs at a time, with a 30-second cooldown after success.
  History requests to the primary phone are queued. Recent command IDs are kept
  briefly in memory to suppress duplicate events; transcripts are not stored with
  those IDs. Retained command keys also suppress repeats across restarts. Offline
  replay events and commands dated before connection are not executed.
- Full phone-history responses are held only for the active request; eligible
  text/captions and minimal metadata can join the bounded saved buffer. Up to
  50 outgoing bot replies can remain in memory for five minutes to support delivery
  retries. The bounded incoming-message snapshot is separate from these temporary
  full phone-history responses and outgoing-reply caches.
- The model summarises topics, decisions, actions, and unanswered questions in the
  conversation's main language, without tools. Verify important details against
  the original messages: summaries can contain mistakes.
- Responses are collected until the API reports completion. Interrupted or failed
  requests never post partial summary text.

## Credentials and data

ChatGPT credentials live in `.chatgpt-auth` (`CHATGPT_AUTH_DIR`). Baileys saves
WhatsApp credentials and encryption state in `.baileys-auth` (`WA_AUTH_DIR`). Keep
these directories and `.env` private. Run only one active bot instance against a
WhatsApp session directory. Do not share those files through Git or chat.

Allowed-group text/captions and minimal sender/boundary metadata are retained in
memory and in `RECENT_MESSAGES_DIR/cache.json` within the limits above. On the VM,
the bot uses a private directory (mode `0700`) and file (mode `0600`), replacing the
snapshot atomically without keeping older backup versions. These are filesystem
access restrictions; the snapshot is not encrypted by WhatsApp's end-to-end
encryption. Keep the VM account and disk private. The default `data/` path is
excluded from Git; add an ignore rule for any custom path inside the repository.
Do not upload the snapshot to Git, logs, chat, or deployment artifacts. Exclude it
from long-lived backups if the 24-hour retention limit must apply to those too.

The application does not log transcripts or tokens. Selected participant names,
timestamps, and message text/captions are sent to OpenAI for each requested summary.
Requests use `store: false`, which is not a promise of zero provider retention.
ChatGPT plan data controls and terms apply in ChatGPT mode; separate API policies
apply in API-key mode. Generated summaries remain normal messages in the group.

## Testing and troubleshooting

Run `npm run runtime:check` to verify local dependency imports, and `npm test` for
offline behaviour tests. Tests use fixtures and mocks; they do not establish live
WhatsApp connectivity, account eligibility, history availability, or real inference.

- **No response:** check the allowlisted group, actual mention, reply target,
  `!summarise` command, and running process.
- **History unavailable or timed out:** check that the quoted start remains within
  the saved buffer's age and size limits. Initial installation and the first
  upgrade from RAM-only storage need fresh messages; later restarts preserve
  unexpired saved messages without another WhatsApp login. Messages missed while
  offline may remain unavailable, and a summary crossing that gap may carry an
  explicit missing-messages warning. For older, missing, or evicted messages, keep
  the bot phone online for the best-effort fallback. Increasing
  `HISTORY_TIMEOUT_MS` may help a slow response but cannot restore missing history.
  The bot reports its specific history failure in the group and in the server log
  as `History retrieval failed: ...`. On the Google VM, inspect recent failures
  with `sudo journalctl -u whatsapp-summary-bot.service --since '10 minutes ago' --no-pager`.
  Empty responses, pages that make no progress, and the configured message cap
  have distinct recovery messages. These failures also log `History diagnostic:`
  with the reason, page/message counts, cursor and anchor positions, and timestamp
  direction counts. They also include bounded response progress and chat-completion
  metadata. `privacySensitive: true` identifies the peer request that includes
  WhatsApp's history-specific relay attribute, missing from pinned Baileys' helper.
  The first-page retry logs `empty_page_retry`, followed by
  `recovered_after_empty_page` if it recovers the requested range, or another failure.
  Diagnostics contain no message text, message IDs, phone numbers,
  group identifiers, or absolute timestamps. To inspect only these diagnostics,
  run `sudo journalctl -u whatsapp-summary-bot.service --since '10 minutes ago' --no-pager -o cat | grep -F 'History diagnostic:'`.
  If fresh messages also fail while WhatsApp is open on the bot phone, use this
  specific failure to diagnose the request; changing the AI model will not fix
  history retrieval. The pinned Baileys version filters previously returned
  history in its event buffer, so this bot observes on-demand responses before
  that buffering, only for the duration of a summary request. Incoming history
  accepts WhatsApp's omitted `fromMe` flag as false, and checks alternate sender
  identifiers against Baileys' verified phone-number/LID mappings.
- **QR needed after upgrading:** the old whatsapp-web.js session is incompatible;
  link Baileys as a new device with `npm run groups`.
- **ChatGPT sign-in required:** stop the bot and run `npm run login`; use
  `npm run login -- --enable-plan` if plan usage was not granted.
- **Model unavailable:** choose an exact ID from `npm run models`, then restart.
- **Plan limit:** check [Manage usage](https://chatgpt.com/settings/usage), restore
  access, and restart.
- **Credential lock after a crash:** stop all bot/sign-in processes and remove only
  `.credentials.lock` inside `CHATGPT_AUTH_DIR`. Keep `state.json` in place.
- **Runtime imports fail:** use Node 24+ and reinstall from the lockfile with
  `npm ci`. The Baileys package contains native dependencies, so validate the
  runtime on the deployment architecture.
- **WhatsApp disconnected:** inspect the connection message. The saved buffer is
  retained, and the interruption is marked so a range spanning it is not treated
  as complete. Missed messages delivered after reconnection are merged without
  running old commands. Restart or re-pair only if required by
  the connection error; avoid simultaneous processes using the same auth directory.

Reference docs: [Baileys](https://baileys.wiki/),
[Baileys history sync](https://baileys.wiki/docs/socket/history-sync),
[ChatGPT sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
and [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
