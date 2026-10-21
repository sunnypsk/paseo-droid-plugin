# Droid Native

Connect the local Factory Droid CLI to Paseo's agent selector, conversation timeline, and permission cards. Droid Native uses Factory's official TypeScript SDK with a direct JSON-RPC transport and reuses your existing Droid CLI login.

Requires Paseo 0.11.4 or later and an installed, signed-in Droid CLI. Script permission compatibility has been validated with Droid 0.244.0 and 0.245.0 using Factory SDK 0.9.1. Validation covers macOS and Windows. Droid must be executable on the daemon host; use `agents.providers.droid-native.command` to configure its binary path when needed.

Choose a model, reasoning effort, and Ask, Spec, or Auto mode. The plugin streams replies, thinking, and tool status, and presents tool approvals and AskUser questions in Paseo. MCP servers supplied by Paseo are passed to Droid.

Droid stores its native conversation context locally. Timeline rows and task state are saved on the daemon under `$PASEO_HOME/plugin-state/droid-native/v2/`; Paseo retains a short reference for reopening and replay. Existing inline snapshots remain readable. Back up this state directory with Paseo's agent records; older plugin versions cannot read the new references. Prompts, tool results, attachments, and MCP data are processed according to your existing Droid, Factory, and MCP settings; local session storage does not mean all data stays on the host. The plugin does not create an API-key file.

Active-turn steering delivers a new instruction at the next model-turn boundary while the current tool finishes. Images, PDFs, and UTF-8 text use native inputs; other attachments are passed as local file references. Each message supports up to 20 attachments and up to 16 MiB of native input.

A pending tool approval must be resolved before steering; the original turn and draft are preserved. Enable the host's Enable Paseo tools setting to create other agents, send follow-ups, and receive completion notifications. Droid Script approval cards show the full script and every call, with allow-once and cancel choices. The compatibility layer accepts Droid 0.244.0 and 0.245.0 protocols and needs revalidation after CLI or SDK upgrades.

The model selector displays Droid's live multiplier. The conversation context meter shows estimated usage and the model's context limit. Paseo Usage shows Factory Standard and Core quota and the Extra Usage balance. Quota reads the current CLI login through macOS Keychain or Factory's encrypted file store without refreshing tokens or changing account settings.

Quota requests send the existing access token and applicable organization header to `/api/billing/limits` on Factory's official `api.factory.ai` or `api.eu.factory.ai` host. Refresh tokens are not sent, and Usage reports and account inputs contain no credentials. This native internal endpoint needs revalidation after CLI or service changes.

The model list and multipliers refresh before each native session is created or reopened. Overlapping identical requests share one query, and completed results are not permanently cached. Startup waits for discovery and reports failures for retry. The pre-creation draft picker remains subject to Paseo's host cache; the ready session receives the latest choices.

Importing other existing Droid conversations and Mission mode are not implemented. Advanced SDK plan actions are limited to the choices this plugin handles. Auto high uses Droid's corresponding autonomy level directly; the default Ask mode waits for approval.
