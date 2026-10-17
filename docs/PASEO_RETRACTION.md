# Native message retraction on Paseo 0.11.4

The plugin can clear its own snapshot of withdrawn Droid text and warn the user. It cannot remove text already rendered by Paseo 0.11.4 through the public provider API. This is a host limitation, so the warning is a mitigation rather than a complete retraction fix.

## Verified contract and host behavior

Inspected the pinned 0.11.4 contracts and the installed macOS app read-only on 2026-10-18. The `.d.ts` paths below are relative to this repository's `node_modules/`. Runtime `.js` paths are relative to `node_modules/` inside `/Applications/Paseo.app/Contents/Resources/app.asar`. No installed files were changed.

- `@getpaseo/plugin/dist/server/provider.d.ts`, `ProviderTimelineItem` and `ProviderEvent`: a provider sends complete assistant/reasoning snapshots through `timeline.item`. There is no public timeline delete, reset, or replacement event.
- `@getpaseo/server/dist/server/server/agent/plugin-provider.js`, `mapTimelineItem()`: the adapter stores each provider snapshot, then converts assistant/reasoning text to an append delta. When the new text starts with the previous text it emits only the suffix; otherwise it emits the new text as another append. Empty text returns `null`. Provider row IDs are stripped from native text rows.
- `@getpaseo/protocol/dist/agent-types.d.ts`, `AgentTimelineItem`: native assistant rows have an optional `messageId`, but reasoning rows have no message or row identity. Neither type declares snapshot replacement semantics.
- `@getpaseo/protocol/dist/timeline-identity.js`, `timelineItemIdentity()`: only tool calls and plugin rows have replacement identities.
- `@getpaseo/server/dist/server/server/agent/timeline-projection.js`, `TimelineProjection.append()`, `mergeAssistantChunks()`, and `mergeReasoningChunks()`: native text chunks are merged by appending text; there is no text snapshot replacement path.
- `@getpaseo/plugin/dist/client/contracts.d.ts`, `PluginTimelineTransformerContribution`: a transformer receives one source item and can keep, hide, or replace that item. It cannot mutate other already stored native rows. The public React Native exports do not expose the host's native Markdown renderer.

Consequently, sending `{ ...previousItem, text: "" }` updates the adapter's snapshot cache but produces no timeline event. It does not clear the old server or client row. Replacing all native text with custom plugin renderers would change native rendering and output semantics and is not used as a workaround.

## Plugin mitigation

For a native `assistant_message_retracted` event:

1. Clear the matching assistant and reasoning snapshots in plugin state and emit empty snapshots for the affected stable row IDs.
2. Emit one warning with a stable ID for the retracted native message, so repeated delivery does not create repeated warnings. Suggested wording: `Droid withdrew an earlier response. Treat that response as invalid.` The warning must not quote the withdrawn text.
3. Persist the cleared snapshots. Production restore replays those snapshots instead of loading raw native history, and must not publish the withdrawn text again. Any future raw-history integration must also consume native retraction state before it can safely use the optional message replay helper.

The old text can remain visible in the current Paseo 0.11.4 timeline. A host consumer that derives canonical output from that stale native row also needs the upstream fix. Do not describe this mitigation as successful deletion or full canonical-output correction.

## Upstream acceptance scenarios

The host needs native text replacement or deletion semantics that survive storage, live delivery, and replay. A proposed host implementation should pass all of these scenarios:

- Stream an assistant message, retract it, and verify that live UI, fetched history, reconnect, and restored history contain no withdrawn text.
- Stream reasoning blocks, retract them, and verify that the same paths remove the withdrawn reasoning.
- Retract and then replace assistant text or reasoning using the same native ID. Show only the replacement, with no duplicated prefix or old suffix. Repeat both events to verify idempotence.
- Update multiple text blocks around tool calls. Preserve tool identity, status, and ordering, and never combine distinct text blocks merely because they are adjacent.
- Retract during an active turn. Preserve its turn ID, running state, pending tools, permissions, usage, and cancellation behavior. Retraction must not interrupt, restart, or complete the turn.
- Complete or fail a turn after a retraction, with and without replacement text. The last-assistant-message API and any orchestration handoff must never return withdrawn text as canonical output.
- Apply the same checks to subagent timelines and output handoff. Keep existing append-delta providers compatible.

Paseo already has an internal timeline replacement/epoch mechanism (`agent.timeline.replacement`), but providers cannot invoke it through the public contract. Reusing it upstream is a possible implementation approach, not an implemented plugin capability.
