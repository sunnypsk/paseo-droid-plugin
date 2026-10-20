# Droid Native for Paseo

A community-maintained Paseo provider plugin that connects to the local Factory Droid CLI through `@factory/droid-sdk` and its `stream-jsonrpc` protocol.

## Installation

Requires Node.js 22, Paseo 0.11.4 or later, and an installed, signed-in Droid CLI 0.244.0 or later. Validation used Factory SDK 0.9.1. The current plugin version is 0.2.6.

Install the reviewed version from Paseo's plugin registry:

```sh
paseo plugin add sunnypsk/droid
```

To install directly from GitHub:

```sh
paseo plugin add git:sunnypsk/paseo-droid-plugin
```

Paseo installs production dependencies from the committed lockfile with dependency lifecycle scripts disabled. Install and sign in to the Droid CLI separately; this plugin does not download Droid.

The plugin is listed in Paseo's official registry. Registry installations use an approved revision; the GitHub source may include newer changes awaiting review.

For local development:

```sh
npm ci
npm run typecheck
npm test
paseo plugin install /absolute/path/to/paseo_droid_plugin
paseo plugin ls droid-native
```

If `paseo` is not on your PATH, the macOS Desktop app bundles it at `/Applications/Paseo.app/Contents/Resources/bin/paseo`.

Create an agent and select **Droid Native**. The existing `factory-droid` ACP provider can coexist with this plugin. Ask is the default mode; Spec requests a proposal first, and Auto low, medium, and high map to Droid's native autonomy levels. Droid supplies the available models and reasoning choices.

Version 0.2.5 standardized the display name as Droid Native. The plugin/provider ID remains `droid-native`, and the registry ID remains `sunnypsk/droid`, preserving existing settings and conversations.

After editing, run typecheck and load the changes with `paseo plugin reload droid-native`. Reload closes existing Droid Native provider connections: first check all affected agents and wait until no turn or approval is pending. A daemon restart is not required.

## Capabilities

- Streaming text, thinking, and shell/read/edit/write tool rows.
- Paseo permission and AskUser cards, including exact MCP tool preapproval.
- Full plan proposals and batch approvals listing every requested action.
- Model, reasoning, and mode settings, with Paseo MCP server injection.
- Native model multipliers, conversation context capacity, and Factory account quota in Paseo Usage.
- Interrupt, close, and resume for sessions created by this plugin.
- Steering within the active turn, including steering messages with images or documents.
- Native PNG, JPEG, GIF, WebP, PDF, and UTF-8 text inputs; validated local file references for other formats.
- Completed-turn timeline snapshots in Paseo persistence, with native conversation context stored by Droid.

The transport receives Paseo's daemon launch command, arguments, and environment. The SDK's default high-level launcher requires an API key; this plugin supplies a transport created with Paseo process helpers, allowing it to reuse the CLI login without creating an API-key file.

## Steering and attachments

Select **Steer** when sending a message during an active task. You can set it as the default under Settings → General → Default send. Droid receives an accepted instruction at the next model-turn boundary while the current tool continues to completion. If the original turn ends during delivery, the plugin reports a failure; delivered content may remain in Droid's history.

When an AskUser question is pending, a new composer instruction is acknowledged first and then supplied as the freeform answer, allowing the same turn to continue. Cancelling the question ends Droid's turn, so cancellation is reserved for Stop and close.

For a pending tool or plan approval, the plugin asks you to resolve it first and preserves the original turn, approval card, and draft. Version 0.2.2 fixed the rejected-Steer fallback to Interrupt plus a replacement turn. Denying a native Droid tool still ends the turn; resolve the approval before steering, or explicitly Stop and send a new prompt.

Invalid attachments, models without image support, and rejected native acknowledgements produce errors without triggering Paseo's replacement fallback. A closed connection or acknowledgement timeout can still end native work. The plugin does not automatically restart the model loop.

The development source now records a sent steering row only after Droid acknowledges it. An explicit rejection leaves no sent row; an uncertain acknowledgment is recorded as a warning instead. Ordinary rejected settings preserve the session for retry. A timed-out settings update closes and invalidates that session, because its eventual native result is uncertain. Session mode choices follow Droid's organization policy when it reports allowed autonomy levels.

Tool cards retain bounded input and output previews for Script and MCP calls, with credential and encoded-data fields redacted. Glob cards show all patterns and their search folder. Successful TodoWrite calls update Paseo Tasks; failed or interrupted calls do not claim task progress. Text deltas are batched for up to 50 ms or 4,096 characters and flushed before tool events and turn completion.

The unreleased implementation observes native notifications for the entire session, including autonomous turns triggered by background command completion after the original prompt has ended. These updates use the same timeline, Tasks, permissions, usage, and turn lifecycle. They do not create artificial user prompts or run a second model request.

## Local timeline storage (unreleased)

Persistence v2 transfers a short reference containing only the native session ID, working directory, and `snapshotKey`. Complete timeline rows remain on the daemon under `$PASEO_HOME/plugin-state/droid-native/v2/` (`~/.paseo` when `PASEO_HOME` is unset). Unchanged rows are reused by content hash; manifests and row files are immutable. A small atomically replaced head makes the reference stable so a foreground handle cached by Paseo 0.11.4 also restores later observed background checkpoints. The reference is a pointer to the latest committed state, not a point-in-time export.

Writes happen at checkpoints, not on every text delta. Files are private to the daemon user, and a new reference/head is committed only after its rows and manifest are written. A failed write retains the prior reference and produces a warning without turning completed model work into a failure. A missing, damaged, or identity-mismatched snapshot produces an explicit restore error instead of silently opening an empty conversation. Storage files are not automatically deleted.

Existing v1 inline persistence remains readable and migrates only the timeline rows it already contains. This update does not reconstruct old reports, tool calls, or Tasks from Factory history; an old empty snapshot remains empty. `config.persist=false` does not create this local timeline storage.

Back up the local state directory together with Paseo's agent records. A v2 reference requires this directory on the same daemon, and plugins that only understand v1 cannot read it. Do not downgrade to a v1-only plugin without a compatible v2 reader or a deliberate export/migration. Package and SDK versions remain unchanged until release.

Native retraction clears the plugin's saved text and adds a withdrawal warning. Paseo 0.11.4 cannot remove already rendered native text through its public provider API, so this is a mitigation, not a complete visual retraction fix. See [the host limitation and upstream acceptance scenarios](docs/PASEO_RETRACTION.md).

Use Paseo's attachment controls to add files. Images, PDFs, and UTF-8 text use Droid's native image/document inputs. ZIP, Office, and other binary files provide a filename, type, size, and validated local path so Droid can choose tools to handle them; these references do not imply that their contents have been decoded. Paseo text context, issue/PR context, and code-review context are also mapped to Droid inputs. Timeline snapshots store attachment markers instead of duplicating base64 data or full documents.

Paseo 0.11.4 shows attachment previews when a message is sent. After an agent reload, reconstructed user rows show text without the original thumbnails or document cards. Droid's native context retains the attachments; this plugin does not implement the host's attachment-history rendering.

Each message supports up to 20 attachments. Native inputs are limited to 16 MiB total, with 10 MiB per image and 2 MiB per text document. Other local file references support files up to 256 MiB; the plugin reads only a small format header. Unreadable files, changed sizes, mismatched formats, and unsupported image models produce errors.

Importing other existing Droid conversations, Mission/child sessions, and fork/rewind are not implemented. If a plugin reload or process crash occurs during a turn, Paseo replay guarantees only the last saved snapshots; Droid's own session storage remains authoritative for native context. Native system prompts are set at session creation and preserved on resume.

`config.persist=false` disables only the Paseo persistence token. Droid may still save its native session according to its own behavior.

## Model multipliers and usage

Model names include the live catalog's `tokenMultiplier`, such as `GPT-6.1 Sol · 0.8×` during validation. Unknown multipliers are left unspecified. Model prices are not hardcoded.

Since 0.2.4, the plugin refreshes the model list and multipliers before creating, reloading, or resuming a native session. Explicit catalog requests and Refresh providers also query Droid again. Only overlapping queries with the same working directory and session environment are shared; completed results are not permanently cached. Discovery uses the same environment overrides as the native session.

A failed refresh prevents that session from opening and reports an error for retry. Other running sessions continue. A removed or disabled selected model produces an error before creation or resume instead of silently switching models. Closing one waiting session cancels only its wait, preserving a discovery request shared by other sessions.

The draft picker before creation remains subject to Paseo's host snapshot cache. Freshness is guaranteed before the native session starts; the ready agent receives its latest selector choices through `session.config`. Use Refresh providers to refresh the draft picker explicitly. Discovery is not triggered on every selector opening or prompt. Live probes without a model turn took about 2–3 seconds per catalog request, depending on the CLI and network.

The conversation context meter uses native `getContextStats()` values for current estimated occupancy and the model limit. It does not represent cumulative billed tokens or account quota. It updates on open/resume, model changes, and turn completion. Old-model capacity is cleared while new-model data is pending, and a failed stats request does not interrupt work.

The **Factory** card in Paseo Usage shows Standard and Core quota windows, used and remaining percentages, reset times, and the Extra Usage balance in USD. The API does not provide a plan's total token allowance, so the plugin does not estimate it. Window names follow the API's fiveHour, weekly, and monthly fields rather than inferring periods from countdowns. Paseo caches usage for five minutes; a manual refresh is available.

Quota uses the read-only billing endpoint behind Droid 0.244.0's `/limits` command. This is a native internal API rather than a public SDK method and needs revalidation after CLI or service changes. The plugin reads the current login's access token from macOS Keychain or Factory's encrypted file store. It does not refresh tokens, rewrite credentials, change plans, or change Extra Usage settings. Expired, rejected, or missing login data is reported explicitly.

Quota requests send only the existing access token and applicable organization header to `/api/billing/limits` on Factory's official `api.factory.ai` or `api.eu.factory.ai` host. They do not send refresh tokens. Credentials are excluded from repository files, Usage reports, and account inputs. Prompts, attachments, tool content, and MCP data are processed according to your Droid, Factory, and MCP settings; native local session storage does not mean all data stays on the host.

View account quota in the sidebar's global Usage panel and model context in the conversation context meter. Paseo 0.11.4's generic plugin provider does not bridge `usageSession()`, so the conversation popover does not also display the Factory account card. Global Usage and the context meter remain available. Session-environment login filtering is implemented in the source, but this host version does not call it for the conversation popover.

Explicit API-key, airgap, and custom-backend configurations do not fall back to an unrelated stored subscription. Linux keyring support is not implemented. Live account-quota validation has been limited to macOS Keychain. Usage reports and account inputs contain no credentials.

## Paseo orchestration

Enable **Enable Paseo tools** under Settings → your host → Agents, then create or reload the agent. The host injects agent-scoped Paseo MCP configuration automatically; no separate plugin feature or manual `mcpServers.paseo` override is needed. The Paseo skill supplies optional workflow guidance and is not required to enable the tools. See [Paseo orchestration](https://paseo.sh/docs/orchestration).

Codex can use Paseo `create_agent` to launch `droid-native/<model>`. Droid can use the same tool to launch `codex/<model>` and follow up with `send_agent_prompt`. Keep `notifyOnFinish:true` to receive automatic child-completion notifications without polling. Native Ask/Auto modes continue to determine which actions require approval.

Droid 0.244.0 may call MCP through Script. SDK 0.9.1 does not include that permission schema, so a separate compatibility layer displays the complete script and every call's parameters with allow-once and cancel choices. Requests supported by the SDK pass through unchanged. Compatibility is pinned to native protocol `1.269.0`, SDK protocol `1.201.1`, and API `1.0.0`; unknown formats are rejected. Revalidate after CLI or SDK upgrades.

## Source layout

- `server/provider.ts`: Paseo lifecycle, catalog, persistence, and session orchestration.
- `server/transport.ts`: Droid process launch through Paseo helpers, with JSON-RPC handled by the SDK.
- `server/permissions.ts`: Tool, plan, and AskUser callbacks.
- `server/permission-compatibility.ts`: Strict validation and bridging for native Script permission requests and responses.
- `server/usage.ts` and `server/quota.ts`: Read-only Factory login access, quota discovery, and Usage report mapping.
- `server/timeline.ts`: Streaming events mapped to stable timeline snapshots.
- `server/session-events.ts`: Lifetime native notification subscription and SDK conversion.
- `server/persistence.ts` and `server/snapshot-store.ts`: Immutable row caching, private durable snapshots, and v1/v2 restore.
- `server/steering.ts`: Mid-loop steering through the SDK's public schema on the shared transport.
- `server/attachments.ts`: Attachment validation, native inputs, and local file references.

References: [Paseo provider plugins](https://paseo.sh/docs/plugins/providers) and [Factory SDK](https://docs.factory.com/sdk/typescript).

See [VERIFICATION.md](VERIFICATION.md) for observed results and verification limits.
