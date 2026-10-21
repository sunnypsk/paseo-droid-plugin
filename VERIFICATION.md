# Droid Native verification record

Initial validation: 2026-10-17. Environment: macOS, local Desktop-managed Paseo 0.11.4, Droid 0.244.0, and Factory SDK 0.9.1. Later release checks are dated separately below.

## Automated checks

- `npm run typecheck` passed.
- `npm test`: 109/109 passed for 0.2.4.
- Coverage includes permissions and AskUser, exact MCP preapproval, stream terminal-event deduplication, concurrent prompts, interrupt, close during initialization, catalog cleanup, persistence replay, transport framing, and shutdown.
- Provider tests use a fake native session and validate every emitted event with Paseo's `ProviderEventSchema`.
- Steering and attachment coverage includes native request/ACK multiplexing, forwarding, stable turn IDs, ordered steering, late ACKs, Stop during attachment reads, models without image support, and format/size/path validation.
- Regressions cover plan UI fields, complete batch approvals, AskUser supersession, admission during pending tool approval, new approvals during attachment preparation or ACK waiting, and ACK races across turns.
- Script compatibility tests use the installed SDK's `DroidClient` and the actual permission handler. They cover protocol and option presentation fields, complete review content, explicit Once/Cancel decisions, unchanged forwarding of supported frames, rejection of unknown shapes, duplicate IDs, interrupt/close, and late responses.
- Version 0.2.3 added multiplier validation, combined context/per-turn counter snapshots, model-change capacity clearing, timeout/close isolation, late startup subscribers, missing or expired quota windows, USD conversion, credential rotation, nullable metadata, environment scope, and error redaction.

## Public Git distribution preparation

- Added the locked production preparation command `npm ci --omit=dev --ignore-scripts`. It succeeded in a clean directory containing only tracked source. SDK exports `createSession`, `resumeSession`, and `listModels` were available without a model turn or login call.
- Typecheck and all 109 tests passed again after the distribution changes.
- Gitleaks 8.30.1 found no secrets in the complete pre-publication Git history or release source. Tracked-path and lockfile checks found no credential, environment, or private-key files. All 419 dependency entries had versions, official npm resolved URLs, and SHA-512 integrity; URLs contained no embedded credentials.
- `.test-output/`, `node_modules/`, local environment files, Factory/Paseo configuration, and common credential/key files are Git ignored. Tests use synthetic credentials. Raw live-test output stays in local `.test-output/` and is excluded from the public source.
- These were local publication checks, independent of the registry's subsequent review and approval.

## Live Droid and Paseo

- The local `droid-native` plugin installed successfully, reported `running`, and registered an `available` provider.
- A catalog probe with `FACTORY_API_KEY` explicitly removed returned 67 models using the existing CLI login, without a model turn.
- Paseo provider discovery returned the same 67-model catalog and Ask/Spec/Auto modes.
- Test agent `cb81ef06-f3f5-48c6-a56c-cc47732f9e96` used `droid-native/gpt-6-luna`, low reasoning, and Ask mode.
- A real Execute permission crossed the Paseo request/response bridge. Selecting `proceed_once` wrote `.test-output/droid-proof.txt` containing `PASEO_DROID_NATIVE_7F3C`.
- Droid returned the same marker, and Paseo persistence saved user, reasoning, completed-tool, and assistant snapshots.
- After `paseo agent reload`, the agent recalled the original marker without tools or file reads, demonstrating native context resume.
- A real AskUser request became a Paseo question payload. Stop returned the agent to idle with zero pending permissions.

## 0.2.0 steering and attachments

- The public Paseo SDK API delivered synthetic PNG, PDF, and UTF-8 text attachments to the same test agent.
- With file-reading tools prohibited, it still returned `Left: red; right: blue; PDF: PDF_MARKER_5A91; text: TEXT_NOTE_9B72`.
- While the agent awaited an AskUser response, `activeTurnBehavior: "steer"` changed the requested final output. Answering the question produced `STEERED_PASEO_RESULT`.
- The complete event subscription recorded exactly one `turn_started` and one `turn_completed`, both for `c02eb9ca-d847-4181-8ee5-bd6bb2581e3d`, without canceled or failed events.
- A separate native CLI sleep-tool probe accepted steering while the tool ran. The original tool finished, the new instruction was processed, and there was one completion without interrupt.
- Requests used `queuePlacement: "end_of_turn"` and `skipAgentLoop: true`. An idle probe appended history without model, tool, or usage events during observation and did not start another loop.
- Local evidence: `.test-output/paseo-features-smoke.json`, `steering-native-skip-probe.json`, `steering-native-idle-probe.json`, and `final-unit-tests.tap`.

## 0.2.1 combined native steering checks

- A running native Execute sleep tool received steering with PNG, PDF, and text attachments. Droid correctly returned `STEER_ATTACH_OK`, red/blue, `PDF_MARKER_5A91`, and `TEXT_NOTE_9B72`.
- There was one successful native result with `interrupted=false` and no interrupt request. The original tool finished before the steering was processed.
- Live UI testing exposed an AskUser cleanup error: `cancelled:true` ended the native loop after the new instruction was delivered. The fix supplies the new instruction as a freeform answer after ACK. Stop and close continue to use cancellation.
- A separate native probe then returned `ASK_SUPERSEDE_STEER_OK` with one AskUser request, one result, and zero interrupts.
- Local evidence: `.test-output/steering-attachments-live.json` and `askuser-steering-supersede-proof.json`.

## Desktop UI with full access

After full access was enabled, Computer Use actions and screenshots remained on the test tab. Earlier approval prompts had returned focus to the development conversation. The Droid provider itself had not switched tabs. Tests used the official `paseo agent open` command followed by native accessibility, clicks, and screenshots.

- The provider/model picker showed the historical `Droid Native (PoC)` label, robot icon, and GPT-6 Luna search results.
- Reasoning choices were None, Low, Medium, High, Extra high, and Max. Modes were Ask, Spec, and Auto low/medium/high.
- Upload file added a PDF and text document; Add image added a PNG. Filename cards and the red/blue preview appeared before and after sending.
- The UI-delivered attachments produced `UI_ATTACHMENT_OK left red/right blue; PDF_MARKER_5A91; TEXT_NOTE_9B72` without file-reading tools.
- AskUser showed the question, One/Two radio buttons, Other input, and Dismiss/Submit controls. Selecting Two and submitting produced `Two`.
- A subsequent AskUser was superseded through the composer's Send and steer action. The old card disappeared and Droid returned `UI_STEER_FIXED_OK`. Events showed one start and one completion for `3daba7e6-771b-4f15-9152-01fb6e8739e7`, without canceled or failed events.
- Tool approval exposed the full command in accessibility text and allow-once/always/cancel controls. Allow-once wrote `.test-output/ui-tool-proof.txt` containing `UI_TOOL_OK`, with the same assistant reply.
- The Spec plan card showed `UI_PLAN_MARKER_83A2`, both numbered steps, and `END_PLAN_83A2`. No, keep iterating on spec returned the agent to idle without executing the plan.
- While agent `b45c20af-2502-47dd-b590-a7d7095f6f83` awaited Execute approval, Send and steer requested abandoning the write. The old unavailable response caused Paseo to interrupt and replace the turn, producing `UI_GUARD_CANCELLED`. `.test-output/ui-guard-must-not-exist.txt` was absent. This was fallback behavior rather than same-turn steering.
- Default send was temporarily changed from Queue to Steer and restored to Queue through the UI. Both test agents ended idle with `activeTurn=null` and zero pending permissions.
- Post-fix UI events: `.test-output/ui-after-fix-events.json`. Screenshots and accessibility output were inspected in Computer Use results; no separate local screenshot files were claimed for these checks.

## 0.2.2 rejected-Steer fix

- Unaccepted steering now rejects `send()` with the original error instead of emitting a failed disposition that the host treats as unavailable. Ordinary prompts remain asynchronous so permissions and interrupt are not blocked.
- Model-free integration used the unmodified installed Paseo adapter and AgentManager methods. The old failed-event control canceled and replaced the turn; pending-tool, invalid-image, and rejected-ACK cases with the fix returned errors with cancel=0 and replacement=0. Accepted steering retained its turn ID.
- The live UI pending-Execute → Send and steer check showed Resolve the pending Droid tool approval while preserving the approval card and draft.
- Before and after, the active turn was `e1b4b0eb-608c-44b2-87fe-98854bc8d571` and the permission was `droid-permission-5a03f63a-a9bb-4e9b-9c24-e7e7eea4e43f`. Explicit denial then returned the agent to idle; `ui-guard-022-must-not-exist.txt` was absent.
- Local evidence: `.test-output/steering-rejection-installed-host.json` and `ui-steer-rejection-022.json`.

## Live Paseo MCP orchestration

- Root Codex used the real Paseo `create_agent` tool to create native Droid parent `a62121e4-3bb0-4513-9fc4-2dfe3927d696` with `gpt-6-luna` and Ask mode.
- Droid read the Paseo skill, called `paseo___list_profiles`, `list_providers`, and `list_models`, then used `paseo___create_agent` to create Codex child `8fea1eae-223a-48cb-b867-3a2a5c86a484` with `codex/gpt-6.1-sol`, Full Access, and low reasoning.
- The child returned `CODEX_CHILD_R7E2`. After its automatic notification, Droid followed up through `paseo___send_agent_prompt`, received `CODEX_FOLLOWUP_M9D4`, and reported `ORCHESTRATION_COMPLETE` with both actual replies.
- The parent did not poll `get_agent_status` or `list_agents` or substitute CLI/Factory Task calls for MCP. Root selected `proceed_once` for each Ask-mode MCP permission, without always-allow approval.
- A real MCP batch approval included list_profiles and list_providers together. Both full actions were visible in the scrollable review UI.
- Local evidence: `.test-output/orchestration-parent-timeline.json`, `orchestration-live-events.json`, and the child's two actual user/assistant turns.

### Reload and Script MCP compatibility

- After reload, the model reported a tool as unavailable even though the raw ToolSearch result and public SDK inventory showed `paseo___send_agent_prompt` registered and allowed. The model's statement was not treated as evidence that the tool had disappeared.
- Switching to `gpt-6.1-sol`, medium reasoning, and Ask exposed a separate real incompatibility: Droid 0.244.0's Script permission was absent from SDK 0.9.1's schema. The added bridge accepts the verified API `1.0.0` and native protocol `1.269.0`, preserving the SDK's `1.201.1` handling. Native `selectedColor` and `selectedPrefix` remain presentation strings.
- Desktop accessibility and screenshots showed the complete Script, parsed child ID, prompt, background, and notifyOnFinish fields in a scrollable card. Only allow-once and cancel were offered. Root selected once without changing persistent MCP configuration or tool policy.
- The first successful delivery returned `CODEX_RELOAD_P4A7.`. MCP and notification delivery succeeded, but the trailing period failed the exact-output check. A tag-delimited prompt then produced exact child reply `CODEX_RELOAD_Q6B9` and parent reply `ORCHESTRATION_RELOAD_OK: CODEX_RELOAD_Q6B9`.
- Independent assertions confirmed completed parent Script and `paseo___send_agent_prompt` calls, matching real child user/assistant turns, and a notification-driven parent reply within turn `7306aff3-2fe1-4741-b32b-5a825982f230`. A marker merely appearing in the user prompt was not counted as success.
- Local evidence: `.test-output/orchestration-reload-proof.json`, `orchestration-reload-final-timeline.json`, and `orchestration-reload-child-timeline.json`. Parent and child finished idle. Two other Droid test agents closed during reload; all had `activeTurn=null` and zero pending permissions.

## 0.2.3 model multipliers and usage

- Live `tokenMultiplier` values appeared in the Desktop picker and selected trigger as `GPT-6.1 Sol · 0.8×`, `GPT-6 Astra · 4×`, and `GPT-6 Luna · 0.04×`. Unknown multipliers retained their names without hardcoded pricing.
- A native `getContextStats()` probe without a model turn returned estimated occupancy and the model limit, separately from cumulative tokenUsage. After the Paseo `USAGE_CHECK_OK` prompt, the Desktop meter showed `3% used · 29k / 922k tokens`.
- The first reload missed early usage because the host subscribed too late. An installed-adapter probe confirmed that early usage was cached without subscription replay, while later idle usage worked. The plugin now re-emits its latest snapshot at bounded 250/1000/3000ms intervals after ready, with no extra native RPC and with timers canceled on close. The host replaces lastUsage rather than adding tokens. This is bounded compensation, not a subscription ACK; initialization beyond that window still requires the next valid usage update.
- A final plugin/agent reload yielded `contextWindowUsedTokens=27914` and `contextWindowMaxTokens=922000` before another prompt; Desktop showed 3%. Switching from Sol to Luna and back refreshed the label and context without a model turn.
- The read-only Factory `/api/billing/limits` probe, production source adapter, and installed Paseo global Usage all succeeded. Observed Standard usage was 3/39/37%, Core usage 0/0/22%, with valid reset dates and Extra Usage USD balance 0. These were observations on 2026-10-17, not fixed plan allowances.
- The Desktop Usage modal showed the Factory card, six windows, reset countdowns, Extra Usage balance, Standard remaining 97/61/63%, and Core remaining 100/100/78%, without changing global display preferences. No account, plan, or overage setting changed; credentials were neither refreshed nor written. The existing macOS Keychain login was read only.
- Local evidence: `.test-output/factory-quota-readonly.json`, `usage-source-live.json`, `paseo-usage-live.json`, `context-meter-reload-live.json`, and `context-meter-model-change-live.json`. Desktop accessibility and screenshots were inspected in Computer Use output.
- A confirmed host limit is the generic `PluginAgentSession`'s missing `usageSession()`. Agent-scoped `listUsageReports` returned an empty list before source discovery; global Usage worked. An installed-registry probe showed sessionDiscoverCalls=0 and globalDiscoverCalls=1. Paseo core was unchanged: account quota remains in global Usage and model context in the conversation meter.

## 0.2.4 catalog refresh before session opening

- Removed permanent caching of successful catalogs. Only in-flight queries with identical working directory/environment are shared and retired after success or failure. New sessions and reload/resume query again and publish current models/multipliers through `session.config`.
- Catalog discovery receives the session's environment overrides, matching native launch. Different environments are not merged. Closing one session cancels only its own wait. A removed or disabled selected model fails before native creation or resume.
- Seven deterministic regressions cover sequential model/multiplier changes in the same directory, resume freshness, picker/open overlap, different environments, failed-query retries with running-session isolation, model removal, and cancellation of one shared-query waiter.
- A live CLI/SDK probe queried the picker, created two sessions in the same directory, and resumed the first. Discovery counts advanced 1/2/3/4, with 67 models each, two creates, one resume, and no model turns. Each listModels call took about 2.0–2.8 seconds.
- Local evidence: `.test-output/catalog-refresh-native-smoke.json`, `catalog-refresh-tests.tap`, and `final-unit-tests.tap`.
- Installed Paseo 0.11.4 created prompt-free test agent `2f9fe9dc-be4d-4172-a28d-1fd5c58629be` in about 3.38 seconds and reloaded it successfully. The timeline stayed empty with `activeTurn=null` and zero pending permissions. Desktop accessibility/screenshots showed `GPT-6.1 Sol · 0.8×`, the empty conversation, and 1% context. Evidence: `.test-output/paseo-catalog-refresh-live.json`.
- The new empty test workspace/agent was archived afterward without deleting the project directory. Existing development workspaces and earlier test agents were preserved.
- Draft selectors remain subject to host snapshot caching. Freshness before native startup does not guarantee a refresh before Create. Explicit Refresh providers bypasses the plugin's old permanent cache; another session's discovery does not replace a running session's configuration.

## 0.2.5 display name, 2026-10-18

- The manifest, provider label, README, and overview use `Droid Native`; package and lockfile root versions are 0.2.5. Plugin/provider ID `droid-native`, registry ID `sunnypsk/droid`, and dependencies are unchanged.
- Typecheck and all 109 tests passed. No new model turn was started, and provider lifecycle, permissions, steering, and persistence logic were unchanged.
- After confirming local Droid agents were idle or closed, the plugin was reloaded. Desktop-managed Paseo 0.11.4 reported `running` with display name `Droid Native`, without a daemon restart.
- Native Computer Use could not reliably open Settings and later reported `noWindowsAvailable`. This release check confirmed the daemon-reported name, without claiming visual verification of the renamed selector. Earlier live feature tests remain evidence for their respective versions.

## 0.2.6 English public copy, 2026-10-18

- README, the registry overview, and this public verification record are in English. Plugin metadata and runtime messages were already English. The display name remains `Droid Native`, with unchanged plugin/provider ID `droid-native` and registry ID `sunnypsk/droid`.
- Package and lockfile root versions are 0.2.6. Production modules and the complete dependency tree remain unchanged from 0.2.5.
- Multibyte test samples use Unicode escapes in source. TypeScript-parsed runtime strings are identical to the previous fixtures, preserving UTF-8 coverage and assertions.
- Typecheck and all 109 tests passed. A scan of all 29 tracked files found no remaining CJK copy, and every existing inline code reference in the translated documents was retained.
- This is a documentation and source-presentation update. Earlier CLI, model, MCP, and Desktop feature results above were not rerun for this release.

## Unreleased timeline and reliability fixes, 2026-10-18

- Generic Script and MCP cards now include bounded, sanitized input and output. Successful TodoWrite results publish one stable Paseo Tasks row, including pending, in-progress, completed, and empty-list updates. Failed calls and forced tool completion do not claim task progress.
- Ordinary rejected settings and local validation failures preserve the native connection. Session autonomy choices honor Droid's reported organization policy. Only a settings deadline closes the transport and invalidates the slot, with a runtime failure for the host.
- Sent steering rows are created after native acknowledgment. Explicit native errors do not create a delivered row; uncertain receipt produces a warning without triggering the host's replacement-turn fallback.
- Text deltas are joined in batches of up to 50 ms or 4,096 characters, and flushed before non-text events and terminal processing. Text deduplication no longer serializes each full snapshot. Completed-turn reducer state is released; persistence caches immutable JSON rows and serializes only changed rows. Full history is retained, so persistence transfer size still grows with the conversation.
- Final snapshots are persisted after native generator cleanup and before the terminal event, allowing the host to capture the current persistence handle before accepting the next turn.
- Retraction drops pending matching text, emits cleared snapshots, and adds one stable withdrawal warning. This does not remove text already rendered by Paseo 0.11.4. [Host limitation and upstream scenarios](docs/PASEO_RETRACTION.md) document the remaining blocker.
- Verification uses fake transports and controlled native events only. No installed plugin reload, daemon restart, live Droid model turn, or operation on an existing agent was performed. Actual Desktop rendering and live latency remain unverified for these changes.
- `npm run typecheck`, all 143 automated tests, and `git diff --check` passed. A deterministic 10,000-delta test preserves all 200,000 characters with fewer than 60 presentation updates. The provider-level restore test confirms withdrawn text is absent from saved and replayed plugin snapshots.
- An offline replay of the user-designated native session read its existing log without connecting to Paseo or Droid: 267 tool calls produced 56 Script cards containing input previews and six distinct TodoWrite updates (one repeated state was deduplicated). Its final Tasks list contained five completed items. No task content was modified.

## Unreleased background events and compact persistence, 2026-10-20

- A lifetime `DroidSession.onNotification()` subscription uses the SDK's public notification conversion. Foreground streaming no longer folds duplicate copies into the timeline. Autonomous background turns publish their tools, text, Tasks, usage and lifecycle without another prompt. Ordered event processing preserves foreground/background handoff, preparation cancellation, permissions, steering, Stop, connection failure and startup readiness.
- Persistence v2 contains only `nativeSessionId`, `cwd` and `snapshotKey`. Private content-addressed rows and immutable manifests stay under the daemon's local state directory. An atomically updated stable head makes foreground handles cached by Paseo 0.11.4 resolve later observed background checkpoints. Existing v1 rows migrate without reading Factory history; previously missing reports, tool rows and Tasks are not reconstructed.
- Missing/corrupt state and session identity mismatches fail restoration explicitly. Checkpoint failures keep the previous reference, publish a bounded warning, and still complete successful model work. Cached heads are session-specific; existing immutable files are retained, with no automatic cleanup.
- Glob cards now show string/array patterns and the search folder while retaining their results.
- Typecheck, all 162 automated tests, and `git diff --check` passed. The 1,000- and 10,000-row disk round trips both used a 190-byte reference and reproduced every row. Tests also cover private file permissions, unchanged-row reuse, v1 empty-state migration, malformed keys, corrupt/missing snapshots, failed writes, cached-handle restoration, startup wakeups and steering acknowledgments during a terminal checkpoint.
- A real SDK 0.9.1 plus synthetic JSON-RPC subprocess test verified the first prompt ending, a later background wakeup, completed tools/Tasks, a complete report, duplicate completion, and close/reopen using the earlier foreground handle. It made no model/API call and read no real Factory session history.
- An isolated Paseo 0.11.4 daemon used a temporary home, a separate loopback port, relay disabled, and the fake Droid CLI. Chrome showed the foreground result first, then the background report, full Glob patterns/folder, search results and completed Tasks without a second prompt. The isolated test agent's reload restored all six saved rows, including the background report and Tasks, from the cached foreground handle. Its encoded session ID was 261 bytes for the longer temporary working-directory path.
- The first isolated reload exposed the host's stale foreground handle. The stable-head implementation and real-SDK cached-handle regression were added before the final verification. This was a test-only failure; production conversations were not used or modified.
- Local synthetic evidence: `.test-output/patch-host.json` and `.test-output/patch-final-tests.tap`. The isolated daemon was stopped after verification; production supervisor/worker PIDs and start time were unchanged. The production daemon and installed production plugin were not reloaded. These checks establish synthetic protocol/host/UI behavior, not live Droid model performance or physical-device validation.
- Back up the state directory with the agent records. Older v1-only plugin builds cannot restore v2 handles; downgrade needs a compatible reader or an explicit export/migration. Package/dependency versions were not changed, and this patch was not committed, pushed or published.

## Windows compatibility and portable Usage tests, 2026-10-21

- The Windows installation on Paseo 0.12.0, Droid 0.245.0 and SDK 0.9.1 crashed twice while closing a session with `Droid steering transport was closed.`. A real SDK plus paused synthetic subprocess reproduces the unhandled rejection: SDK 0.9.1 does not observe its internal response promise until `transport.send()` settles. The transport now accepts writes when queued to stdin and reports asynchronous write errors through its existing terminal error channel, allowing SDK rejection handlers to attach before shutdown. The backpressured-write regression fails before this change and passes afterward.
- Script compatibility retains strict schema validation and explicitly supports native protocols `1.269.0` and `1.272.0`. Pending requests retain their own protocol for allow-once, cancellation and concurrent mixed-version replies. Unknown versions, unsupported fields and unoffered approval choices remain rejected.
- Typecheck passed for the current checkout and an isolated copy of installed revision `6617933` with only the two production hotfix files replaced. All 27 transport, steering and permission compatibility tests passed against that installed baseline. The current checkout's full suite passed all 165 tests on Windows; its output is `.test-output/windows-all-tests.txt`.
- Seven Usage tests previously failed because hardcoded POSIX fixture paths differed from Windows `node:path.join` results. All fixture roots and store paths now use native `resolve`/`join`. An additional `win32` test verifies global/session account discovery and quota fetching from a synthetic encrypted file/key pair without macOS Keychain. Filesystem and HTTP access remain mocked, and production Usage code is unchanged.
- A new isolated native session received an actual Droid 0.245.0 Script permission on protocol `1.272.0`. Its parameters passed the compatibility schema and reached the handler, which selected Cancel. The turn completed and the production abort/transport-close/session-close sequence exited normally. The requested command only printed a constant; permission was cancelled before execution. Existing native sessions were not loaded. The controlled probe is `.test-output/probe-droid-0245.mts` with its sanitized result in `.test-output/windows-native-probe.json`.
- The machine's installed 0.2.6 registry checkout received only `server/transport.ts` and `server/permission-compatibility.ts`; its existing persistence format remains in use. Original source files and hashes are backed up under `.test-output/installed-backup-20261021-161242/`. Reloading only `droid-native` returned `running`, and its model catalog was successfully queried through the production daemon. Daemon supervisor/worker PIDs, start time and configuration hash were unchanged. The native probe and synthetic subprocesses exited after validation.
- Package/dependency versions and the installed registry revision remain unchanged. Existing conversations were not exercised through the Desktop UI.

## 0.2.7 release preparation, 2026-10-21

- Package and lockfile root versions are 0.2.7. Dependencies, plugin/provider ID `droid-native`, registry ID `sunnypsk/droid`, and the `>=0.11.4` Paseo requirement are unchanged.
- This release includes the timeline, lifecycle, settings, Tasks and compact-persistence work described above, plus the Droid 0.245.0 permission-protocol and transport-close fixes from commit `5d33755`. README and overview now describe these as shipped behavior and disclose the local persistence directory and downgrade boundary.
- On macOS with Node.js 22.14.0, typecheck and all 165 tests passed; package dry-run contents and `git diff --check` passed. The dependency tree did not change.
- A clean Git-source installation on an isolated Paseo 0.12.0 daemon ran the declared locked production-dependency preparation and reached `running`. The isolated daemon was stopped after verification.
- After confirming no Droid turn or permission was pending, the local host switched from the registry-managed 0.2.6 checkout to the 0.2.7 source directory, retaining plugin/provider ID `droid-native`. The previous managed installation, configuration and eight agent records were backed up locally. Conversation persistence and unrelated configuration were unchanged; one saved `lastStatus` changed from idle to closed when the old provider stopped. The new plugin reached `running` and returned 66 native model entries without sending a model prompt. Registry installation remains a separate reviewed publication step.
- Registry review is requested for this release's exact commit; local validation and source publication do not establish registry approval.

## Verification boundaries and known limitations

Paseo 0.11.4 preserves attachment previews in live user rows, but reconstructed rows after agent reload retain only text. Droid retains the native attachments. Host attachment-history rendering is not implemented by this plugin.

Pending tool/plan approvals still require an explicit decision. Droid exposes no public deny-and-continue result. Version 0.2.2 prevents automatic turn interruption/replacement after rejected steering. Steering delivered before a newly arriving approval remains in history, with an instruction to resolve that approval first.

The old host fallback was inspected in installed `app.asar`: `node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js:923` mapped a nonmatching steer to unavailable, and `agent-manager.js:1835`/`:1908` performed replacement. Version 0.2.2 uses rejected acceptance and was verified through a real plugin subprocess in the UI. Host code was unchanged.

Native retraction has deterministic reducer and replay coverage, without a live model retry/retraction UI check. The host drops empty text snapshots, so previously displayed text cannot be cleared by this plugin on Paseo 0.11.4. The plugin warns explicitly and clears plugin persistence; canonical host output can still include the old text until upstream supports text replacement.

The earlier independent Chrome client at `app.paseo.sh` timed out connecting directly to the production daemon. The 2026-10-20 check above instead verified the bundled Web UI on an isolated local daemon. Production web UI settings were unchanged and its daemon was not restarted. Compact/mobile layouts, physical devices, production daemon restart and Mission mode remain unverified. Large-history disk/reference checks do not establish live UI latency. ZIP/Office local references have automated coverage without a real model decoding check.

MCP injection and tool-policy mapping are implemented, with exact preapproval covered by automated tests. Real Paseo create/send/automatic-notification orchestration was verified in both directions. Other external MCP services were not individually tested.

Earlier test agents remain in the same workspace for manual inspection. Test files and raw evidence remain in Git-ignored `.test-output/`.
