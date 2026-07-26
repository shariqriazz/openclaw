# Gateway Reliability and Persistence Performance Plan

- Status: correctness Batches 1-5 and performance Phases 0-1.5 implemented,
  validated, and locally deployed; model-call transport recovery is
  implemented, focused-tested, and built with its live canary pending, while
  post-deployment evidence keeps the gated Phase 2 session-store investigation
  open; Discord thread-bound subagent streaming is implemented and
  focused-tested, while its production configuration, numeric `/usage full`
  context reporting, and device pairing await the coordinated deployment
- Target branch: `shariq`
- Baseline: OpenClaw `2026.7.1` at `969bd2c17ba`
- Investigation date: 2026-07-24

## Decision

Execute one coordinated reliability and performance program with separate
commits, validation gates, deployment steps, and rollback points:

1. Add an explicit active-turn `redirect` mode for ordinary busy input and
   repair persistent-subagent `sessions_send` through the same lifecycle
   owner.
2. Add typed stateless context-compaction fallback, preserve host recovery
   targets, and deploy Lossless Claw from a clean committed checkout.
3. Generate the exec host schema from session capabilities while retaining
   runtime enforcement.
4. Convert the historical performance proof into a repository-owned benchmark.
5. Move trajectory rolling-window maintenance to one bounded worker after the
   benchmark reproduces the result.
6. Remove Lossless Claw's retained full-prompt diagnostic snapshots without
   changing assembly output, then measure the remaining session-store and LCM
   assembly costs under production-shaped concurrency.
7. Move session metadata to per-agent SQLite only if post-worker measurements,
   the consumer audit, and migration rehearsal still support it.
8. Use OpenAI Responses server compaction for compatible OpenAI models while
   retaining the readable local summary as a portability and failure fallback.
9. Keep GPT-5.6's physical provider envelope separate from the operating prompt
   budget: 1.05M physical, 372K input, and 128K output.
10. Replace the external LCM completion watcher and stale janitor with exact,
    native cron lifecycle handling, and move provider-neutral weekly storage
    maintenance into a typed `lcm maintain` command.
11. Recover retryable model-call stalls without replaying completed tools,
    derive fallback availability from distinct effective candidates, retry
    three safe WebSocket reconnects before SSE fallback, and always surface
    terminal channel failures.
12. Make directly delivered thread-bound subagents honor the configured
    channel streaming mode, and customize `/usage full` to report numeric
    context usage instead of a visual meter.
13. Refresh the global `openclaw-rebase` skill with the final OpenClaw and LCM
    patch histories, protected behavior, validation commands, and deployment
    lessons before final handoff.

The deployed OpenClaw performance architecture is one bounded trajectory
worker. The next low-risk performance change is an LCM diagnostic-cache fix.
Per-agent SQLite session metadata remains conditional on runtime attribution,
consumer audit, and migration proof.

Execution uses global operator skills and direct source/runtime inspection only.
Do not invoke OpenClaw repo-local skills, Crabbox, or Testbox. Run builds,
focused tests, benchmarks, and soaks in a controlled local or standalone
non-production environment that cannot touch live sessions, databases, config,
Discord, cron state, or the active extension. Stop the production Gateway and
freeze live writers before changing the active checkout or building artifacts
served by production.

### Immediate maintenance checkpoint

The audit workload settled and the Gateway was stopped through the supported
OpenClaw CLI before source, build, or configuration changes.

Approved `openclaw.json` changes:

- replace Brave and Perplexity as configured web-search providers with the
  bundled Firecrawl plugin, and use the same plugin for `web_fetch`;
- set `tools.web.search.provider` to `firecrawl`;
- set `tools.web.fetch.provider` to `firecrawl`;
- remove Brave and Perplexity from `plugins.allow` and remove their enabled
  plugin entries and provider credential configuration;
- add `firecrawl` to `plugins.allow`;
- enable `plugins.entries.firecrawl`;
- configure hosted Firecrawl search and fetch under
  `plugins.entries.firecrawl.config.webSearch` and `webFetch`, reusing the
  supplied credential without placing it in this repository, this plan, logs,
  or command output;
- validate after config application that Firecrawl is allowed, enabled, loaded,
  and selected for both `web_search` and `web_fetch`, while Brave and
  Perplexity are no longer configured or exposed.
- remove duplicate fallback entries that point to the primary model;
- raise `agents.defaults.subagents.maxChildrenPerAgent` from 20 to 30 while
  retaining the process-wide `agents.defaults.subagents.maxConcurrent=50`
  ceiling so one parent cannot consume every available slot;
- set `channels.discord.streaming.mode` and each active Discord account
  override to `partial`, so ordinary interactive Discord turns show the
  evolving assistant response instead of primarily reporting tool/status
  activity. Directly delivered
  thread-bound `mode="session"` subagents currently bypass that compositor and
  require the planned presentation fix below.

This means:

- `redirect` is additive. Existing `interrupt`, `steer`, `followup`, and
  `collect` semantics remain unchanged, and an omitted queue mode continues to
  default to `steer`.
- This installation selects `redirect` explicitly only after source, tests,
  build, deployment, and session-override checks pass.
- The active reply operation owns busy-input redirect, persistent
  `sessions_send`, transcript adoption, stale-completion rejection, and
  finalization races. No competing Gateway turn may write the same active
  session.
- Session metadata remains in `sessions.json` for this deployment. A row-level
  SQLite migration requires the separate Phase 2 gates below.
- Session transcripts remain in their current JSONL format during this work.
  This keeps the PI/OpenClaw harness and Lossless Claw integration stable while
  removing the measured `sessions.json` bottleneck.
- Exactly one process-owned worker thread performs trajectory window
  read/parse/sort/trim/replace work. Multiple workers consumed more memory and
  did not improve the mixed workload.
- Runtime does not dual-write SQLite and `sessions.json`. Legacy JSON is an
  offline doctor migration input and rollback/export target only.
- Existing agent, subagent, and cron concurrency remains available. This work
  removes event-loop work before considering any operator-facing concurrency
  reduction.

SQLite plus one worker was the best exploratory combination, but the original
`/tmp` harness and fixtures were not retained. Phase 0 therefore had to
reproduce the ranking in a repository-owned benchmark before Phase 1 began.

Phase 0 is now reproducible through `pnpm bench:gateway-persistence`. The
benchmark runs each candidate in a fresh child process against 504 session
entries, sixteen concurrent 10 MiB trajectory windows, and 48 mixed
operations. After tightening the worker heap bounds, five fresh-process
repetitions on 2026-07-25 produced these deployment medians:

| Variant                 | ops/s | event-loop p99 | heartbeat p99 | peak RSS delta | peak heap delta | physical writes |
| ----------------------- | ----: | -------------: | ------------: | -------------: | --------------: | --------------: |
| Original implementation |  4.72 |       66.32 ms |      96.10 ms |     511.01 MiB |      382.93 MiB |      943.31 MiB |
| Bounded worker          |  9.84 |       17.42 ms |      48.10 ms |     164.80 MiB |       22.39 MiB |      486.02 MiB |

Against the same-harness original control, the deployed worker increases
throughput by 108.4%, reduces event-loop p99 by 73.7%, reduces heartbeat p99 by
49.9%, reduces incremental RSS by 67.7%, reduces heap growth by 94.2%, and
reduces physical writes by 48.5%. This clears both the responsiveness and
memory gates without changing session storage.

The synthetic result does not close the production investigation. A
post-deployment burst on 2026-07-25 crossed the memory warning threshold and
left rare event-loop stalls, so the LCM diagnostic-cache fix and bounded
runtime attribution below must run before deciding Phase 2.

### Post-deployment production evidence

At `2026-07-25T22:26:33Z`, while Main and three full cron-agent runs overlapped,
the Gateway reported:

```text
rss=1.82 GiB
heap=1.41 GiB
threshold=1.5 GiB
```

The process reached a 2.31 GiB RSS high-water mark. After the burst, health
returned to `p99=21ms`, `max=53ms`, and low CPU/utilization, but RSS remained
approximately 1.13 GiB. This is load-dependent allocation pressure, not a
permanently blocked Gateway.

Current production-scale metadata stores include:

- Main `sessions.json`: approximately 10.5 MiB and 527 entries.
- Scout `sessions.json`: approximately 11.7 MiB and 529 entries.
- 7,396 trajectory files totaling approximately 2.12 GiB.
- LCM database: approximately 4.3 GiB.

The current-start journal showed no LCM `VACUUM`, database lock, or destructive
rotation. Normal warn-only rotation checks completed in 0-2 ms. One missing
ephemeral-cron transcript check measured 807 ms while the event loop was
already busy; identical checks normally took 1-2 ms, so it is evidence of the
stall, not its source.

Two remaining allocation paths are now source-confirmed:

1. `src/config/sessions/store.ts` still creates and atomically replaces the
   complete serialized session store for each changed row. The single-entry
   fast path avoids reserializing unchanged entries, but still slices,
   allocates, and writes the complete 10-12 MiB string.
2. Lossless Claw `src/assemble-debug.ts` stores every fully serialized assembled
   message in `AssemblePrefixSnapshot`. `src/engine.ts` retains those snapshots
   for up to 100 conversations even though they are used only for prefix-change
   diagnostics. It also serializes each message again while building the
   diagnostic summary.

The trajectory worker materially improved the original hot path, but it cannot
remove these allocations. LCM assembly also materializes all context items and
resolves them with per-item SQLite reads in `src/assembler.ts`; this is a
candidate cost, not yet a proven bottleneck.

Phase 2 remains gated. Runtime telemetry must attribute stall time and
allocation volume to session-store replacement, LCM assembly stages, or other
run work before activating a storage migration.

The bounded LCM diagnostic change is now implemented in LCM commit `114bac7`.
It replaces retained full serialized prompt snapshots with SHA-256 digests
without changing assembly output. Its full 1,848-test suite, typecheck, and all
three builds passed before deployment.

The correctness fixes are not implementation prerequisites merely to clear the
way for storage work. They address independently reproducible production
failures and must retain their own tests and rollback boundaries. The
persistence redesign must not be used to hide or defer their ownership bugs.

## Approved Scope and Order

### Batch 1: Active-turn redirect and persistent-subagent ownership

OpenClaw's current `interrupt` queue mode aborts the complete active run, waits
for teardown, and starts another turn. It is not Hermes-style active-turn
redirect. Current `steer` safely waits for a model/tool boundary but cannot
cancel an obsolete model request. Configuration alone therefore cannot provide
the requested behavior.

Persistent subagent steering also starts a competing Gateway turn instead of
joining the target's active embedded run. Captured failures show trusted STOP
or follow-up messages followed by duplicated terminal assistant content and
`EmbeddedAttemptSessionTakeoverError`.

Required design:

- Start with deterministic failing tests that reproduce both captured
  timelines. If the duplicate final and takeover cannot be reproduced, stop and
  investigate before changing production code.
- Add `redirect` as a distinct queue mode. Do not redefine `interrupt`, and do
  not change the omitted-mode default from `steer`.
- During model generation, cancel only the active provider/model request.
  Preserve completed tool work and display-safe partial assistant output, add
  the correction as real user intent, and continue the same logical turn.
- Never persist incomplete provider-signed, encrypted, or otherwise
  replay-sensitive reasoning blocks as a redirect checkpoint.
- During tool execution or a concurrent tool batch, do not cancel tools merely
  because ordinary input arrived. Consume the correction once at the next
  defined safe boundary.
- Give each active operation a generation and each accepted input an
  idempotency key plus deterministic sequence. A stale provider callback or
  stale finalizer cannot publish after ownership changes.
- Use the existing SQLite ingress-queue abstraction for accepted redirect
  intent. One operation generation claims the row, and the row remains
  incomplete until the owning attempt adopts the correction at a transcript
  barrier.
- If the Gateway exits before adoption, stale-claim recovery must deliver the
  correction exactly once. If the original operation no longer exists, convert
  it into one queued recovery/follow-up turn; do not pretend to resume the dead
  logical turn.
- On completion, remove correction text from the queue row and retain only
  bounded non-sensitive tombstone metadata. Do not keep a second indefinite
  copy outside the transcript.
- Route true mid-run steering through the target's active run queue.
- Deliver STOP through direct cancellation control when a run is active; do
  not create another model turn merely to cancel it.
- Queue post-completion follow-ups behind a terminal transcript/finalization
  barrier.
- Preserve ordering and idempotency for concurrent trusted sends.
- Keep the takeover fence strict for unknown appenders, non-append mutation,
  truncation, and stale ownership.
- Do not globally ignore file changes or classify every append as trusted.
- Keep Discord native command production routing unchanged unless a
  deterministic canonical-target test fails against current source.
- Prove how TUI `chat.send` resolves queue policy before documenting or setting
  a `webchat` override. Prefer the explicit global
  `messages.queue.mode=redirect` for this installation when Discord and TUI
  should share behavior.
- Before configuring redirect, enumerate inline and persisted session
  `queueMode` values. Preserve the resolution order: inline, persisted session,
  channel override, global mode, then `steer`.

The fix must prevent duplicate model turns, duplicate tool side effects,
duplicate or stale final announcements, and transcript reordering. Persistence
latency may widen the race, but the lifecycle fix must work against the current
file-backed store.

#### Confirmed post-deployment Discord redirect gap

The initial redirect implementation is incomplete at the channel admission
boundary. The model-request redirect primitive, tool-boundary steering, queue
mode plumbing, and active embedded-session delivery exist, but an ordinary
Discord message cannot reach them while the same canonical session is busy.

Production incident replay on 2026-07-25 confirmed:

- the first Discord message entered Main at `22:34:40.183 UTC`;
- the correction arrived from Discord at `22:34:57.337 UTC`, while the first
  logical turn was still active;
- the first turn continued through model and tool boundaries and published its
  final response at `22:35:23.472 UTC`;
- the correction was appended to the transcript only at `22:35:28.762 UTC` and
  started a separate follow-up model turn;
- the correction eventually changed the requested cron schedule, but it did
  not redirect the active logical turn.

Two independent admission barriers cause this:

1. `extensions/discord/src/monitor/message-run-queue.ts` queues the complete
   `processDiscordMessage` lifecycle by canonical session key through
   `createChannelRunQueue`. A second same-session Discord message therefore
   cannot reach reply dispatch until the first message has fully completed.
2. `src/auto-reply/reply/dispatch-from-config.ts` allows active queue-policy
   resolution during dispatch only for Gateway-owned turns carrying
   `queuedFollowupLifecycle`. Ordinary channel turns wait behind the active
   reply operation before `getReplyFromConfig` can resolve `redirect`.

The existing redirect tests start below both barriers. Existing tests also
explicitly preserve the conflicting behavior:

- `extensions/discord/src/monitor/message-handler.queue.test.ts` expects a
  second same-session Discord message to remain behind the first complete run;
- `src/auto-reply/reply/dispatch-from-config.test.ts` expects ordinary
  non-Slack channel turns to remain behind an active reply operation;
- `src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts` proves redirect
  only after execution has already reached `runReplyAgent`.

Required correction:

- Keep one primary logical turn and finalization owner per canonical session.
- Split active-input admission from full channel-run execution. A busy ordinary
  message must reach the active operation's queue-policy owner without starting
  a competing reply operation or waiting behind the complete channel run.
- Generalize active queue-policy resolution for trusted channel input instead
  of special-casing only Gateway `chat.send`, while retaining route/thread,
  authorization, media, and lifecycle checks.
- Keep idle primary turns serialized. Do not remove all channel serialization
  or weaken the reply-operation ownership fence.
- Give each accepted correction a durable idempotency identity and operation
  generation. Do not acknowledge durable acceptance until the active attempt
  adopts it at a transcript barrier.
- If finalization wins before adoption, convert the correction into exactly one
  queued follow-up turn. Never append directly to the transcript from the
  channel handler.
- Preserve the strict takeover fence for unknown appenders, mutation, and
  truncation.
- Preserve media fallback, cancellation, replay protection, typing cleanup,
  deterministic ordering, and exactly-once tool side effects.
- Use the existing SQLite channel ingress queue where it satisfies the durable
  claim, stale-claim recovery, tombstone, and payload-retention requirements;
  do not add a second queue implementation.

Required failing test before implementation:

- Drive two ordinary messages through the real Discord handler, channel run
  queue, shared reply dispatch, active reply operation, and embedded backend
  using deterministic barriers.
- Hold the first turn in model generation, deliver the correction, and prove
  the correction reaches active redirect before the first final can publish.
- Repeat with a running tool and prove the tool completes once before the
  correction is adopted.
- Race the correction against terminal finalization and prove either redirect
  wins before commit or exactly one follow-up turn starts afterward.
- Assert transcript ordering, one user correction, no duplicate assistant
  final, no repeated tool effect, no takeover error, and durable ingress
  cleanup.
- Add the equivalent TUI `chat.send` integration proof. Its Gateway lifecycle
  bypass exists in source, but redirect behavior is not yet proven end to end.
- Audit other ordinary messaging channels using shared reply dispatch because
  the generic dispatch admission barrier can produce the same effective
  follow-up behavior even without Discord's additional outer queue.

Implementation order within Batch 1:

1. deterministic failing incident and lifecycle tests;
2. model-request-only redirect primitive;
3. operation-owned redirect state machine;
4. durable accepted-intent adoption and crash recovery;
5. persistent `sessions_send` ownership repair;
6. Discord and TUI integration;
7. additive config, schema, help, and docs support;
8. explicit installation config only after validation.

Use separate commits for these boundaries where the intermediate tree remains
buildable and reviewable.

### Batch 2: Stateless context recovery and Lossless Claw deployment

Lossless Claw statelessness means that matching subagent messages are not
persisted or ingested into LCM. It must not disable native OpenClaw compaction.

Required design:

- Keep `tokenBudget` as full model/runtime capacity.
- Keep `targetPromptTokens` as the host recovery convergence boundary.
- Add a typed, optional context-engine result/disposition for explicit runtime
  fallback authorization. Do not infer behavior from the string
  `stateless session`.
- Delegate stateless compaction to OpenClaw's direct native compactor without
  ingesting the session into LCM.
- Carry `targetPromptTokens`, estimate provenance, aggregate tool pressure,
  cancellation, reassembly, and complete-prompt estimation through fallback.
- Keep the final no-progress decision in OpenClaw after reassembly. A context
  engine must not declare complete-prompt no progress unless it owns that full
  accounting domain.
- Prove the direct delegate cannot recurse through context-engine selection.
- Keep older third-party context engines compatible when they do not return the
  new optional disposition.
- Preserve the successful stateful `284388 -> compact -> retry` incident as a
  positive control.
- Allow a stateless child to receive a temporary, bounded, read-only expansion
  grant scoped to its stateful parent's conversation. The grant must preserve
  parent restrictions, bind to the exact child, prevent nested escalation, and
  be revoked on failed spawn or every child termination path without creating
  an LCM conversation for the child.

Deploy LCM from a clean dedicated checkout pinned to the committed `shariq`
revision. The active source, tests, built artifact, and runtime fingerprint must
identify the same immutable commit. Do not maintain production as an
uncommitted patch or mutable development checkout.

### Batch 3: Capability-aware exec host schema

The current model-facing schema advertises `sandbox` and `node` even when those
hosts are unavailable to the session. Runtime rejection remains necessary, but
the model should not be encouraged to select an impossible host.

Required design:

- Build the model-facing host enum from a prepared session capability snapshot.
- Advertise `sandbox` only when a sandbox runtime exists and policy permits it.
- Advertise `node` only when configured policy and an eligible connected-node
  snapshot permit it.
- Preserve `auto` and permitted Gateway behavior.
- Rebuild capabilities at the normal tool/schema lifecycle boundary rather
  than polling metadata from the exec hot path.
- Keep runtime validation authoritative when capability changes after schema
  creation.
- Never reinterpret unavailable `host=sandbox` as Gateway execution.
- Preserve direct/internal API compatibility for callers that bypass the
  model-facing schema; explicit unavailable requests still fail safely.

### Batch 4: OpenAI server compaction and context envelope

OpenClaw's native compactor previously produced only a local text summary.
Lossless Claw also compacted its retrieval graph locally, so compatible OpenAI
turns did not receive the higher-fidelity opaque continuation artifact available
through Responses compaction.

Required design:

- Use the normal OpenAI Responses endpoint with a trailing
  `compaction_trigger`; do not patch installed dependencies or add another
  provider identity.
- Parse the SSE response incrementally and complete as soon as the single
  compaction item and `response.completed` terminal event are observed. Do not
  wait for the server to close an otherwise complete stream.
- Give remote compaction independent first-byte, stream-idle, and overall
  deadlines that are shorter than stuck-session recovery. Merge those
  deadlines with caller cancellation and cancel the response reader plus fetch
  on every terminal path.
- Treat remote compaction as an optional provider enhancement. A timeout,
  malformed or partial stream, provider error, disconnect, caller abort, or
  shutdown must retain any successful LCM/local compaction and release the
  session lane promptly.
- Do not allow a late remote result to write a transcript or compaction entry
  after its attempt lost ownership. No remote request may remain detached when
  local compaction fails or the owning operation exits.
- Keep native Pi/OpenClaw transport and existing WebSocket/SSE selection
  unchanged. Server compaction is a compaction concern, not a new harness.
- Run the existing readable local summary in parallel. It remains the fallback
  for endpoint failure, model/provider switching, inspection, and export.
- Persist the opaque replacement history in the native compaction entry and
  replay it only for the exact provider/API/model identity that created it.
- Build first compaction from the complete active branch. Build repeated
  compaction from the previous opaque artifact plus subsequent compatible
  turns, never from the lossy portable summary.
- Treat only the newest compaction boundary as authoritative. Never revive an
  older artifact across a newer compaction produced by another model.
- Preserve pending user intent across resume, deterministic message order, and
  completed tool results. Drop a completed trailing turn when its assistant
  belongs to another model.
- Preserve the ChatGPT `store:false` safeguards: do not replay stale encrypted
  reasoning or prior Responses item IDs.
- After stateful LCM compaction, run the direct native compactor so manual,
  timeout, and overflow recovery all obtain the provider artifact. Skip the
  second pass when stateless LCM delegation already returned one.
- Provider-compaction failure must not invalidate successful LCM or local
  compaction. Log the fallback and continue with the readable summary.
- Keep `contextWindow=1_050_000`, `contextTokens=372_000`, and
  `maxTokens=128_000` for the canonical Sol, Terra, and Luna model entries.
  OpenClaw reserve behavior and LCM policy remain based on 372K:
  272K host boundary and approximately 260.4K LCM threshold.
- Keep production LCM source and build in the clean
  `/root/projects/lossless-claw` `shariq` checkout. The loaded plugin must
  resolve to that checkout, not a dirty extension copy.
- Disable eager Codex discovery for this Pi/OpenClaw deployment while retaining
  explicit Codex-harness use. Do not create per-agent Codex homes unless that
  harness is actually selected.

Focused proof must cover endpoint/body/header construction, repeated opaque
compaction, resume with pending input, exact-model isolation, newest-boundary
selection, stale-reasoning suppression, native compaction after stateful LCM
manual and overflow paths, and unchanged local fallback behavior.

Incident replay:

- At `2026-07-26T01:11:24.597Z`, Main's provider turn ended with a WebSocket
  error. LCM then completed leaf compaction at
  `2026-07-26T01:12:04.548Z`, but the secondary OpenAI server-compaction
  request remained pending while the session lane held one queued redirect.
- At `2026-07-26T01:17:54.212Z`, stuck-session recovery aborted the run after
  approximately 365 seconds. The secondary compaction then failed with
  `Reply_operation_aborted_by_user`; the already successful LCM compaction
  remained usable, but the queued user message had been unnecessarily blocked.
- The direct cause is the remote request awaiting `response.text()` and then
  being awaited before local compaction can return, with no remote-specific
  deadline. The configured 1,800-second general compaction timeout is longer
  than the five-minute no-progress recovery boundary.

Additional regression gates:

- A stream that emits a valid compaction item and `response.completed` but
  keeps the connection open completes immediately and cancels its reader.
- No response bytes, periodic non-terminal bytes, a partial event, malformed
  JSON, duplicate compaction items, `response.failed`, disconnect, and a stream
  ending before `response.completed` each fall back within their bounded
  deadline.
- Successful LCM compaction followed by remote timeout returns the LCM result,
  releases the lane, and consumes queued redirect intent exactly once.
- Successful native local summary followed by remote failure commits the local
  summary without waiting for stuck-session recovery.
- Caller cancellation and Gateway shutdown abort both fetch and reader without
  a detached request, late transcript write, duplicate compaction entry, or
  unhandled rejection.
- Repeated compaction after fallback never reuses a missing, partial, stale, or
  wrong-model remote artifact.
- Completed tool results remain exactly once; remote timeout never replays a
  model turn, tool call, or external side effect.

### Batch 5: Native LCM cron lifecycle and maintenance

Implementation status: completed and live-verified on 2026-07-26.

- OpenClaw `e0852954479` emits durable exact run lifecycle identity.
- OpenClaw `ed6ca069f0a` separates stable context identity from the current
  session id adopted after compaction or session reconciliation.
- LCM `d6627c9` owns exact completion archival, receipts, restart replay, and
  cron-only stale recovery.
- LCM `4d7022b` adds dry-run-first guarded native maintenance.
- LCM `b9eef23` preserves lifecycle receipts during rollover repair.
- The completion watcher, janitor service/timer, and weekly timer are disabled;
  their scripts and units remain intact for rollback.

The first live canary correctly failed closed because OpenClaw emitted an
adopted session id while the exact run-scoped key and LCM conversation retained
the original context id. No conversation or receipt was changed. The follow-up
patch introduced a distinct internal context identity, kept adopted-session
behavior unchanged, and made finished hooks plus durable run logs use the exact
LCM identity.

The corrected isolated no-delivery canary completed successfully, archived
exactly its run-scoped conversation with `cron-completed`, and wrote one
idempotency receipt. Production `lcm maintain` then completed in dry-run mode,
reported the frozen 14-day cutoff and 312 eligible inactive cron
conversations, and performed no maintenance mutation.

The current LCM lifecycle is correct in intent but split across external
polling scripts that read private OpenClaw and LCM SQLite tables:

- `openclaw-lcm-completion-watcher` observes `cron_jobs.running_at_ms`, resolves
  the exact run from `cron_run_logs`, and archives the matching active LCM
  conversation.
- `openclaw-lcm-janitor` archives active cron conversations idle for at least
  three hours.
- `openclaw-lcm-weekly-maintenance` backs up, retains, purges, compacts,
  verifies, and reports on LCM storage.

The migration preserves that behavior while moving lifecycle ownership beside
the contracts and schema it depends on. It does not absorb deployment-specific
Drive uploads, Pipeline handoffs, Discord notifications, Gateway systemd
control, private recipients, accounts, or installation paths.

#### Current baseline

Before cutover, record and compare:

- exact source and installed-script hashes;
- helper unit enablement and active states;
- Gateway and LCM plugin fingerprints;
- LCM active/inactive counts partitioned by cron, Discord, subagent, and other;
- exact active cron conversation identities;
- LCM database, WAL, SHM, and `lcm-files` sizes;
- the latest watcher, janitor, and maintenance audit records.

The observed baseline on 2026-07-25 is:

- completion watcher: enabled and active;
- janitor timer: enabled and active;
- janitor service: disabled and inactive between one-shot runs;
- weekly maintenance timer: disabled and inactive;
- weekly maintenance service: static and inactive;
- workspace and installed copies of all three scripts have matching hashes.

These are deployment observations, not constants. Re-read them immediately
before the maintenance window.

#### OpenClaw completion-event contract

`cron_changed` already exposes most required fields, but the current delivery
ordering is not a sufficient lifecycle boundary:

- `src/cron/service/timer.ts` emits scheduled `finished` events before the
  finalized cron state is persisted;
- scheduled `emitJobFinished()` does not currently carry `runId`, while the
  manual path can;
- `src/gateway/server-cron.ts` invokes the plugin hook before its fire-and-forget
  `appendCronRunLog()` call;
- hook delivery itself is fire-and-forget, so a process exit can lose the
  completion after the cron run has otherwise completed.

Implement the smallest generic OpenClaw contract that guarantees:

1. Scheduled and manual terminal paths produce one normalized finished event
   containing exact `jobId`, `agentId`, `runAtMs`, `runId`, `sessionId`,
   `sessionKey`, run status, and delivery status.
2. Cron run state and run-log identity are durable before the event becomes
   eligible for plugin delivery.
3. Delivery has a stable idempotency key derived from immutable run identity,
   not message text, job name, prefix matching, or newest-child guesses.
4. An accepted event remains replayable after Gateway restart until the plugin
   has acknowledged successful handling.
5. Plugin failure never rewrites the cron result or causes the cron payload to
   execute again. It retains a bounded retryable lifecycle item with
   content-free diagnostics.
6. Invalid or incomplete identity fails closed and becomes an observable
   terminal lifecycle error rather than matching a nearby conversation.

Prefer an existing shared SQLite outbox primitive if one satisfies these
requirements. Otherwise add a narrow cron-lifecycle outbox to the shared
OpenClaw state database using the repository's normal Kysely migration path.
Do not add a JSON sidecar, permanent dual path, or private-table polling API.

The completion event remains a generic plugin contract. OpenClaw must not
contain Lossless Claw identifiers or archival policy.

#### Exact completion archival in Lossless Claw

Lossless Claw registers a typed `cron_changed` handler and handles only
`action="finished"` events with complete exact identity.

The handler must:

- parse and validate a strict cron run-scoped `sessionKey`;
- resolve exactly one active conversation by exact session key;
- verify `sessionId` when both sides provide it;
- archive that conversation in one idempotent transaction with a dedicated
  `cron-completed` cause and lifecycle-event receipt;
- acknowledge duplicate delivery only when the prior receipt proves the same
  immutable run identity and outcome;
- treat an already archived exact conversation as an idempotent no-op;
- reject missing identity, multiple matches, prefix matches, base-session
  guesses, unrelated conversations, and status ambiguity;
- archive terminal success, error, timeout, and delivery-failure outcomes;
- emit content-free audit fields for event id, run identity, status, result,
  duration, and duplicate/retry classification.

Overlapping runs are independent because each event carries its exact
run-scoped identity. Completion handling never selects the newest child and
never scans for a likely conversation.

#### Native stale-conversation recovery

Stale recovery remains a safety net for abandoned active cron conversations,
not a replacement for exact completion events.

Implement one plugin-owned, single-flight scheduled sweep that:

- defaults to a three-hour idle threshold;
- is configurable and supports dry-run;
- considers only strict cron conversation identities;
- excludes Discord, interactive, subagent, and all other non-cron sessions;
- compares each candidate with a host-provided snapshot of active/in-flight
  cron run identities before applying age policy;
- fails closed when ownership is ambiguous;
- updates only a still-active exact conversation and records a dedicated
  `cron-stale-recovery` cause;
- emits one bounded audit result per candidate and aggregate scan metrics;
- cannot overlap itself and stops cleanly with the plugin/Gateway lifecycle;
- recovers missed completion events after restart without racing a live run.

If the existing plugin cron service cannot expose exact active run identity,
add a narrow read-only SDK capability for an active-cron snapshot. Do not make
LCM read OpenClaw's private cron tables. A plain job listing with
`runningAtMs` is insufficient unless it also carries the exact run/session
identity needed to protect overlapping runs.

Age alone is never proof that a currently owned run is abandoned. When host
ownership evidence is temporarily unavailable, recovery remains dry/no-op and
reports the ambiguity.

#### Native `lcm maintain`

Add a typed standalone CLI subcommand:

```text
lcm maintain [--dry-run] [--retention-days 14] [--confirm] [--json]
```

Dry-run is the default. Mutation requires an explicit confirmation flag.
Production verification in this program uses dry-run only.

The provider-neutral command preserves:

- one frozen cutoff and a fourteen-day default retention;
- inactive cron conversations only;
- a coherent verified SQLite backup that includes committed WAL state;
- a verified archive and manifest for `lcm-files`;
- database, disk-headroom, schema, path, and symlink guards;
- dependent row deletion before unreferenced sidecar cleanup;
- FTS rebuild and integrity verification;
- conditional vacuum using the existing free-page and disk-headroom policy;
- active, Discord, and non-cron count invariants;
- comparison with the historical foreign-key baseline;
- transaction rollback, locking, signal recovery, and atomic JSON reports;
- retention of a verified backup after every mutating failure.

Do not silently change generic `prune` behavior. Reuse lower-level deletion,
backup, and conversation-store primitives only where their contracts match;
otherwise add maintenance-specific typed operations.

Confirmed mutation must acquire an exclusive maintenance lease and fail if a
Gateway/plugin writer is active. The LCM runtime should hold the corresponding
shared lease while its database is open. Deployment wrappers remain
responsible for stopping services and controlling systemd; LCM core only
enforces its storage-safety contract.

The native core does not upload to Google Drive, send Pipeline handoffs or
Discord notifications, or stop/start Gateway. A thin deployment adapter may:

1. freeze the Gateway and helper writers;
2. call `lcm maintain --confirm --json`;
3. upload the verified backup/report;
4. publish deployment-specific notifications;
5. restore service state.

The weekly timer remains disabled during this migration. No confirmed
production maintenance runs are authorized.

#### Cutover and rollback

After source and copied-fixture gates pass:

1. Stop the Gateway through the supported OpenClaw CLI.
2. Stop/freeze every LCM/session writer and confirm none remain.
3. Back up config, OpenClaw state, sessions, cron state, LCM SQLite through a
   coherent backup mechanism, `lcm-files`, and the active extension.
4. Install clean OpenClaw and LCM builds from their committed `shariq`
   revisions and verify source/test/dist/runtime parity.
5. Stop and disable the completion watcher, janitor timer/service, and weekly
   timer; verify the weekly service is not running.
6. Keep old scripts and unit files intact as disabled rollback artifacts.
7. Validate config/schema, start Gateway through the supported CLI, wait for
   plugin initialization, and probe Gateway, Discord, and plugin health.
8. Run one disposable cron naturally. Capture its exact identity and prove
   native archival changes only that conversation.
9. Test stale recovery and confirmed maintenance only on copied fixtures.
10. Run production `lcm maintain` in dry-run mode and compare the plan with the
    baseline invariants.

Rollback restores matching source, build, config, databases, files, and helper
unit states as one set. If native lifecycle verification fails, stop the new
runtime before restoring and re-enabling only the helpers that were active in
the recorded baseline.

### Discord subagent presentation and usage footer

#### Thread-bound subagents honor the configured streaming mode

Current ordinary Discord turns resolve `channels.discord.streaming.mode` and
use the Discord progress/draft compositor. A thread-bound native subagent
started through `sessions_spawn` instead invokes the Gateway agent path with
direct delivery. That path delivers the final response to the child thread but
bypasses the inbound Discord handler that owns partial, block, and progress
drafts. Configured streaming modes therefore do not currently affect those
subagent threads.

The implemented seam remains channel-owned: the Discord plugin subscribes to
the host's sanitized agent-event stream, correlates events to exactly one
Discord thread binding by child session key, and feeds the existing Discord
draft compositor. It never creates another model turn, transcript writer, or
delivery path. A thread-bound subagent resolves and honors the same effective
configured mode as its target channel/account:

- `off`: final delivery only;
- `partial`: the channel's existing partial-response behavior;
- `block`: the channel's existing block-streaming behavior;
- `progress`: temporary tool/work status followed by the normal final.

This installation will select `partial` globally and for its active Discord
account overrides after the implementation passes. The other modes remain
supported configuration choices rather than fork-specific behavior.

Do not hardcode Discord `progress` in the subagent runtime and do not add a
second transcript or execution path. The child run remains owned by the
existing subagent lifecycle; the channel adapter owns only presentation.
Each child thread gets at most one bounded editable draft, with existing
throttling, coalescing, channel limits, and rate-limit handling. The final
response must replace, clear, or finalize that draft exactly once. Preview
delivery failure must degrade to final-only delivery without failing the run,
replaying a tool, changing the child transcript, or duplicating the final.
Cancellation, Gateway restart, and finalization races must not leave a stale
draft. Concurrent child threads must remain isolated.

Keep core delivery channel-neutral. The existing sanitized agent-event
subscription contract carries bounded progress events; Discord maps them
through its existing compositor and exact thread-binding registry. Other
channels may opt into that public contract without importing Discord policy
into core.

Implemented surface:

- `extensions/discord/subagent-hooks-api.ts`;
- `extensions/discord/src/subagent-streaming.ts`;
- `extensions/discord/src/subagent-streaming.test.ts`;
- the existing Discord subagent-hook and draft-delivery regression suites.

The same validation pass found and fixed a separate canonical-event mismatch
in `extensions/discord/src/monitor/message-run-queue.ts`: active reply
admission compared against the retired `"message"` event name instead of
`"user_request"`. Without that fix, an ordinary busy correction could remain
serialized behind the active reply rather than reaching redirect handling.

Required tests:

- thread-bound delivery honors `off`, `partial`, `block`, and `progress`;
- channel and account override precedence matches ordinary inbound Discord;
- two concurrent child threads never share or overwrite drafts;
- finalization, cancellation, restart, and delivery-error races produce one
  final and no stale preview;
- progress events do not modify transcripts or replay tools;
- ordinary inbound Discord streaming remains unchanged;
- non-threaded/background subagents retain final-only behavior unless their
  delivery surface explicitly supports streaming.

#### Numeric context reporting in `/usage full`

Use the supported `messages.usageTemplate` configuration surface; no OpenClaw
source patch or new usage mode is required. Preserve every existing full-usage
field, including provider/model, reasoning effort, speed mode, and cost, while
replacing only the visual context meter with:

```text
Context: {context.used_tokens|num}/{context.max_tokens|num} ({context.pct_used|fixed:0}%)
```

The resulting footer should retain the normal full summary and include output
equivalent to:

```text
openai · GPT-5.6-Sol · medium · slow | Context: 89k/372k (24%) | $0.15
```

Activate it through the supported `messages.responseUsage` scope selected for
this installation. Preserve session-level `/usage` override precedence:
explicit `/usage off` remains off until `/usage reset`; configuration must not
silently overwrite a persisted session choice. Validate zero/unknown context,
large token values, absent cost, and Discord rendering before deployment.

#### iOS device pairing

Enable the bundled `device-pair` plugin for this installation by adding
`device-pair` to `plugins.allow` and enabling
`plugins.entries.device-pair`. This is an additive command surface for mobile
node setup and approval; it must not change Discord routing, agent sessions,
queue behavior, LCM ownership, or existing channel pairing.

After the next planned Gateway restart, verify that `/pair qr` produces the
supported short-lived iOS setup flow, the resulting request is exact
device-role pairing, and normal Discord messages still round-trip unchanged.
Do not weaken Gateway authentication, device approval, or transport security
to make pairing work. Same-LAN pairing may use the existing authenticated LAN
Gateway; remote pairing must use the supported secure `wss://` or Tailscale
Serve path.

### Rebase-skill maintenance

Every implemented fork-only behavior becomes part of the maintained patch
stack. Updating source without updating the global rebase skill creates a
future regression risk because a later stable-release rebase may silently omit
or partially adapt the patch.

After the final commits and build/deployment behavior are known, update:

- `$CODEX_HOME/skills/openclaw-rebase/SKILL.md`
- its Lossless Claw maintenance reference
- any directly owned helper or template whose commands became stale

The skill update must:

- record the new stable base and exact ordered OpenClaw and LCM commit lists;
- add each new patch's problem, intent, owning files, protected invariants, and
  focused regression tests;
- identify paired OpenClaw/LCM contracts that must be rebased, tested, built,
  deployed, and pushed together;
- update every `git show`, cherry-pick, range-diff, build, install, parity,
  canary, health, and push step affected by the work;
- require full source and test proof before classifying a patch as superseded
  upstream;
- require one explicit disposition for every old patch: preserved exactly,
  adapted to upstream structure, superseded with equivalent upstream behavior,
  or intentionally dropped with Shariq's approval;
- protect behavior rather than old file locations when upstream refactors;
- preserve additive `redirect`, the unchanged `steer` default, model-only
  cancellation, durable adoption, persistent `sessions_send` ownership, and
  strict takeover detection;
- include the committed performance benchmark as future before/after rebase
  proof for any retained persistence patch;
- preserve stable-release-only rebases and final `shariq` branches for both
  maintained forks;
- exclude temporary runtime facts such as PIDs, one-off session ids, current
  queue depth, and transient health output.

The skill is not complete if it merely appends commit hashes. Its workflow must
make accidental loss of `/new`, native Pi/OpenClaw ChatGPT behavior, context
recovery, active-turn redirect, steering ownership, exec-host capability
filtering, or approved persistence behavior detectable before deployment.

### Provider and network failures

New production evidence proves a narrow local recovery defect even though the
underlying stalls are provider/transport failures.

At `2026-07-26T03:31:10Z`, Main's model request produced no further stream
progress for 120 seconds and ended with:

```text
LLM idle timeout (120s): no response from model
```

The turn had no visible Discord failure reply. The configured model list
contained the primary plus five identical fallback references. Candidate
collection correctly deduplicated them to one effective model, but the raw
presence of configured fallbacks set `fallbackConfigured=true` earlier and
disabled the existing bounded same-model idle retry. The fallback runner then
had only one distinct candidate and nothing to try.

During the subsequent 20-child audit burst, three unrelated audits
(`audit-docx`, `audit-auth`, and `audit-ghl-auth`) terminated with the identical
raw `WebSocket error`. Other audits completed under the same source and model.
The OpenAI transport already records a failed WebSocket and selects SSE for a
future request, but when the socket has emitted an initial event the current
model call fails. The runner then refuses whole-run replay after completed
tools, correctly reporting `replaySafe=no`. Historical logs contain the same
WebSocket failure before this maintenance series, so the transport failure was
not introduced by the current fork patches.

Implemented model-call recovery, not whole-turn replay:

- derive `fallbackConfigured` from the distinct effective candidate list after
  primary-equivalent entries are removed;
- keep the existing one-retry bound for a silent same-model request;
- after a retryable WebSocket transport failure, reconnect WebSocket up to
  three times when no assistant text, reasoning result, or tool invocation
  from that call has been durably adopted;
- if all reconnects fail before semantic output, retry the current model call
  once over SSE and keep SSE as the session fallback;
- do not copy Codex's default five-retry stream budget: it covers both
  WebSocket and SSE failures and can turn a transient outage into a long
  user-visible stall under OpenClaw's concurrent agent load;
- retain every completed tool result exactly once and never rerun the agent
  turn or an earlier tool merely because transport failed;
- if any tool invocation or ambiguous assistant output from the failed call was
  adopted, fail closed rather than replaying it;
- preserve cancellation, run deadlines, profile rotation, rate-limit handling,
  and distinct-model fallback ordering;
- after bounded recovery is exhausted, send a visible channel error instead of
  dispatching an empty reply and leaving the user to guess whether the task is
  still running;
- remove duplicate primary-model fallback entries from this installation's
  `openclaw.json` during the later approved config update.

Focused tests must cover:

- duplicate primary fallbacks do not suppress the one same-model idle retry;
- genuinely distinct fallback models retain their configured order;
- a silent model call retries once without replaying prior tool results;
- a pre-output WebSocket failure reconnects WebSocket and succeeds without
  activating SSE fallback;
- four consecutive pre-output WebSocket failures retry once through SSE and
  activate the session fallback;
- a post-tool-call or ambiguous-output WebSocket failure does not replay;
- cancellation and run-budget expiry do not trigger recovery;
- exhausted recovery produces one visible Discord error;
- twenty concurrent model calls can mix success and transport failure without
  duplicating tools, transcript entries, or finals.

## Problem

The Gateway intermittently becomes degraded or times out when 15-16 agents,
automatic cron jobs, and interactive subagents run concurrently.

An observed health snapshot reported:

```text
Gateway event loop: degraded
reasons=event_loop_utilization,cpu
max=347ms
p99=223ms
util=1
cpu=1.039
```

During a heavier interval, 13-19 active runs coincided with:

- event-loop utilization of `1`
- event-loop p99 around `2.1s`
- event-loop maximum around `3.96s`, later reaching `6.8s`
- a `sessions_history` call timing out after 10 seconds

After the standalone benchmark had exited, the live Gateway was still degraded
under real subagent activity:

```text
max=510ms
p99=451ms
util=1
cpu=1.09
```

This shows the production condition persisted when no benchmark process was
running.

### Workload and host

The affected host has:

- 4 logical CPUs
- approximately 23.4 GiB RAM
- `agents.defaults.maxConcurrent = 50`
- `agents.defaults.subagents.maxConcurrent = 50`
- `agents.defaults.subagents.maxChildrenPerAgent = 20`
- `cron.maxConcurrentRuns = 50`

The configured values are intentional capacity ceilings. The product defaults
are 4 top-level agents, 8 subagents, 5 children per agent, and 8 cron runs.
Reducing the configured limits may mask the symptom, but it does not remove the
main-thread persistence work that causes control-plane latency.

### Current storage pressure

At the end of the investigation:

- The main agent `sessions.json` was 10,530,767 bytes.
- The agent tree contained 7,245 trajectory JSONL files.
- Those trajectory files occupied 2,084,009,601 bytes in aggregate.
- The largest trajectory rolling window was 10,482,766 bytes.

The live inventory is expected to change as agents run. These values establish
the scale used to select benchmark fixture sizes; they are not hard-coded
product limits.

## Confirmed Causes

### 1. Session updates still replace the complete JSON store

`src/config/sessions/session-accessor.ts` is the intended storage-neutral
boundary, but its current read and write methods still delegate to the
file-backed implementation:

- `loadSessionEntry()` calls `loadSessionStore()`.
- `listSessionEntries()` calls `listFileSessionEntries()`.
- `patchSessionEntry()` calls `patchFileSessionEntry()`.
- `updateSessionEntry()` calls `updateFileSessionStoreEntry()`.

`src/config/sessions/store.ts` has a useful single-entry serialization fast
path. It avoids reserializing every unchanged entry, but
`writeSessionStoreAtomic()` still writes and atomically renames the complete
serialized store for each persisted mutation. A 10 MiB store updated 48 times
therefore produces approximately 464 MiB of logical writes.

The accessor boundary is ready for a backend change. The backend has not
actually changed yet.

### 2. Trajectory flushes perform CPU-heavy work on the Gateway event loop

`src/trajectory/runtime.ts` currently:

1. synchronously reads the existing rolling file;
2. splits and parses its JSONL records;
3. parses records again during sorting;
4. trims the complete in-memory window;
5. joins the records into another large string;
6. writes a sibling temporary file and renames it.

The per-file `KeyedAsyncQueue` prevents conflicting writes, but the read,
parse, sort, trim, and join operations still execute in the Gateway's main
JavaScript isolate. Async file APIs do not move that JavaScript work off the
event loop.

### 3. Fixed run concurrency multiplies synchronous persistence pressure

Agent, subagent, and cron lanes have separate concurrency limits, but their
runtime orchestration and persistence callbacks share the Gateway process.
When many runs finish tools, flush trajectories, or update session metadata at
the same time, the control plane competes with the workload for the same event
loop.

The event-loop health monitor in `src/gateway/server/event-loop-health.ts`
correctly reports this condition. The warning is evidence, not the cause.

### 4. Lossless Claw was not the primary cause in this incident

Observed Lossless Claw rotation checks completed in approximately 1-24 ms and
transcript rereads in approximately 90-274 ms. There was no observed database
lock, VACUUM, or long rotation operation during the degraded interval.

Lossless Claw has caused a different historical timeout mode during heavy
runtime database rotation. That failure mode should remain separately
diagnosable, but changing LCM thresholds or chunk sizes is not the primary fix
for this event-loop saturation.

## Documentation and Architecture Drift

`docs/refactor/database-first.md` currently says sessions, transcripts, and
trajectory runtime events are already SQLite-only. The checked-out source and
live runtime contradict that statement:

- session access still resolves `sessions.json`;
- runtime transcripts remain JSONL;
- trajectory capture still writes rolling JSONL sidecars;
- the per-agent schema has no session metadata or transcript tables.

A previous branch-wide SQLite refactor, commit `f91de52f0d2`, was immediately
reverted by `694ca50e977`. The revert commit does not document a reason.

Implementation must not blindly restore that 3,000-file change. It can be mined
for reviewed schema and migration ideas, but this plan intentionally limits the
first SQLite migration to session metadata and leaves transcript/LCM behavior
unchanged.

The database-first document must be corrected as part of implementation so it
reports current state separately from target state.

## Benchmark Method

All exploratory benchmark code and fixtures were created under `/tmp` and were
removed or left outside the repository. The results below are historical
diagnostic evidence, not permanent regression proof and not an independently
reproducible acceptance result. The exploratory benchmark:

- used the checked-out source implementation as an authoritative baseline;
- matched the live 10 MiB session store and 10 MiB trajectory-window sizes;
- exercised a 16-agent mixed workload;
- ran with `nice -n 10` and idle I/O priority;
- compared isolated session writes, isolated trajectory writes, and mixed
  workloads;
- measured throughput, event-loop delay, heartbeat delay, logical write
  volume, RSS, and heap growth;
- repeated the matrix to confirm the qualitative ranking;
- did not modify live config, sessions, databases, or Gateway services.

Two baseline forms were retained:

1. Direct source baseline importing `updateSessionStoreEntry()` and
   `createTrajectoryRuntimeRecorder()` from the checkout.
2. A synthetic current-algorithm control inside the same harness as all
   alternatives, allowing fair relative comparisons.

Phase 0 must add the missing repository-owned fixture and run it repeatedly in
an isolated standalone environment. Short microbenchmarks do not predict every
production latency tail. They identify dominant allocation, serialization, and
event-loop behavior. A longer isolated soak is required before deployment.

## Benchmark Proof

### Direct checked-out source

| Workload                | Throughput | Event-loop p99 | Heartbeat p99 | Peak RSS delta | Peak heap delta | Logical writes |
| ----------------------- | ---------: | -------------: | ------------: | -------------: | --------------: | -------------: |
| Session updates         | 12.4 ops/s |        23.3 ms |       12.8 ms |      159.4 MiB |       130.7 MiB |      463.9 MiB |
| Trajectory recorder     | 67.4 ops/s |       144.4 ms |      126.9 ms |      115.6 MiB |        86.4 MiB |       31.6 MiB |
| Mixed 16-agent workload | 20.9 ops/s |        53.3 ms |       43.3 ms |      107.0 MiB |       122.0 MiB |      340.9 MiB |

### Same-harness mixed comparison

| Combination                           |  Throughput | Event-loop p99 | Heartbeat p99 | Peak RSS delta | Peak heap delta | Logical writes |
| ------------------------------------- | ----------: | -------------: | ------------: | -------------: | --------------: | -------------: |
| Current algorithm                     |  29.9 ops/s |        36.4 ms |       25.3 ms |      156.1 MiB |       112.8 MiB |      320.7 MiB |
| Atomic `writev` + 1 trajectory worker |  18.8 ops/s |        19.3 ms |        9.3 ms |       60.5 MiB |         0.9 MiB |      330.8 MiB |
| Batch 8 + `writev` + 1 worker         | 149.0 ops/s |        10.7 ms |        0.9 ms |       46.6 MiB |         0.5 MiB |       62.1 MiB |
| SQLite rows + 1 trajectory worker     | 327.3 ops/s |        12.5 ms |        1.1 ms |       44.9 MiB |         0.4 MiB |       22.4 MiB |

Against the same-harness current control, SQLite plus one trajectory worker:

- increased throughput by approximately 10.9 times;
- reduced logical writes by approximately 93%;
- reduced peak heap growth by more than 99%;
- reduced event-loop p99 by approximately 66%;
- reduced heartbeat p99 from 25.3 ms to 1.1 ms.

The negative final RSS delta observed in one SQLite run is allocator/GC noise.
Peak RSS and repeated ranking are the useful memory signals.

### Correctness probes

Standalone probes established:

- 100 randomized trajectory windows produced byte-identical current and
  worker outputs.
- 100 scatter/gather writes produced byte-identical output.
- Killing a writer before atomic rename preserved the old target.
- Killing a process with an uncommitted SQLite transaction rolled back the
  update and left `PRAGMA integrity_check` equal to `ok`.

These probes support the direction. They are not substitutes for repository
tests, packaging proof, or a live soak.

## Alternatives Considered

### Keep current code and lower concurrency

Rejected as the primary solution. Lower limits reduce collision frequency but
also reduce useful model and network parallelism. Whole-store writes and
main-thread trajectory processing remain pathological as state grows.

Temporary operational limits may still be used as an emergency mitigation
before the code ships.

### Parse each trajectory line only once

Insufficient. It modestly improved isolated throughput and allocation, but the
complete read/sort/trim/join still blocked the event loop.

### More than one trajectory worker

Rejected for this host profile. Two and four workers increased memory and
coordination overhead without improving the mixed workload. Per-file ordering
also becomes harder to reason about.

### Append-only trajectories

Rejected despite benchmark throughput above 7,000 ops/s. Raw append-only writes
break the existing bounded rolling window, deterministic ordering, malformed
line handling, atomic replacement, and export expectations.

An append-only SQLite event table could be reconsidered only as a separate
trajectory-format migration with retention and export contracts. It is not a
drop-in optimization.

### Atomic `writev` for `sessions.json`

Useful as a compatibility bridge, not the target architecture. It removes
large main-heap string concatenations and preserves atomic replacement, but it
still writes the complete 10 MiB store and was slower than the current path.
Arbitrary JSON entry size changes also require a structured segmented
serializer, not fixed-offset byte patching.

### Batch every session update

Rejected as a general rule. Batching benchmarked well because it reduced whole
file writes, but it changes durability and visibility semantics. A crash could
lose acknowledged state, terminal delivery markers, compaction counts, route
updates, or session identity changes.

Coalescing may be introduced later only for named noncritical fields with
field-level tests and mandatory flushes at terminal boundaries.

### Content-address repeated metadata

Potential later optimization. Live shape analysis found substantial duplicate
tool, skill, plugin, and configuration payloads in session and trajectory
records. Deduplication could lower disk and memory use, but it changes persisted
and exported shapes and requires versioned hydration. It should not precede the
storage and worker changes.

### Restore the previously reverted whole-runtime SQLite commit

Rejected. The old change touched thousands of files and coupled session,
transcript, trajectory, auth, plugins, clients, and unrelated runtime state.
That blast radius is unnecessary for the measured bottlenecks and difficult to
maintain across release rebases.

## Solution

Implement two complementary changes: move session metadata to row-level SQLite
transactions, and move trajectory rolling-window maintenance to one worker
thread. Land and validate them as separate phases so each performance effect
and regression surface remains measurable.

### Session metadata

Add a `session_entries` table to each agent's existing
`openclaw-agent.sqlite`.

Initial row shape:

```text
session_key       TEXT PRIMARY KEY
entry_json        TEXT NOT NULL
updated_at        INTEGER
session_id        TEXT
revision          INTEGER NOT NULL
```

Design rules:

- `entry_json` remains the canonical complete `SessionEntry` projection for
  this phase. Do not prematurely normalize every field.
- `session_key`, `session_id`, and `updated_at` are columns because current hot
  lookup, lifecycle, and ordering paths need them.
- `revision` supports compare-and-swap or transaction-local lost-update
  detection where callers patch a previously read row.
- All runtime queries use Kysely helpers over the existing per-agent database
  owner.
- One logical accessor mutation is one SQLite transaction.
- Alias promotion, canonical-key replacement, and row deletion occur in the
  same transaction.
- Whole-store compatibility helpers load a snapshot, run the legacy mutator,
  diff changed/deleted rows, and commit the diff in one transaction.
- New runtime code must not consume the whole-store compatibility helpers.
- No runtime JSON fallback, dual-read, or dual-write is added.

This phase does not move transcript events into SQLite. `sessionFile` and
current transcript JSONL behavior remain available until a separately reviewed
transcript migration is justified.

### Trajectory worker

Create one process-owned worker thread for all trajectory rolling-window
maintenance.

The worker owns:

- existing-window reads;
- source sequence initialization;
- line parsing and sort-key calculation;
- deterministic sorting;
- byte-cap trimming;
- joined output allocation;
- sibling temporary-file writing;
- atomic rename.

The Gateway thread owns:

- payload redaction and event construction;
- per-recorder event sequence;
- bounded enqueue;
- flush lifecycle and timeout reporting;
- worker health and restart policy.

Required worker semantics:

- Preserve per-file ordering.
- Allow unrelated file jobs to queue without creating additional workers.
- Bound queued bytes globally and per file.
- Apply backpressure at flush boundaries rather than retaining unbounded
  trajectory payloads.
- Preserve the 10 MiB rolling-window cap and 256 KiB event cap.
- Preserve malformed-line ordering and trimming behavior.
- Preserve mode `0600`, sibling temp files, symlink checks, and atomic rename.
- Retry a job at most once after a worker crash.
- Surface a distinct worker failure in trajectory flush diagnostics.
- Never block Gateway shutdown indefinitely.
- Terminate the worker after a measured idle period when there are no queued or
  in-flight jobs, allowing its isolate heap to be reclaimed.
- Lazily recreate the worker on the next trajectory operation.

The single worker is an implementation detail, not a configurable concurrency
surface.

### Pressure control

Do not add adaptive agent throttling in the first patch.

After SQLite and worker changes, rerun the 16-agent soak. Add pressure-aware
scheduling only if model/tool orchestration still saturates the event loop.

If needed, pressure control should:

- bound CPU/persistence stages rather than network-waiting model runs;
- use existing command-lane and event-loop-health snapshots;
- preserve configured concurrency as the upper bound;
- use hysteresis and a minimum hold time;
- reserve progress for health, shutdown, cancellation, and delivery work;
- avoid starvation and oscillation;
- expose current pressure state in health diagnostics;
- require no production config knob unless measured workloads prove one is
  necessary.

## Compatibility Contracts

### PI/OpenClaw harness

The PI/OpenClaw harness is the production runtime and must remain the primary
integration proof. The storage change must preserve:

- normal Discord turns;
- streaming and tool loops;
- `/new`, `/reset`, and `/compact`;
- context-engine compaction and overflow recovery;
- model fallback and retry;
- session usage and status;
- subagent spawn, announce, cancellation, and cleanup;
- cron isolated sessions and delivery;
- restart recovery and pending final delivery.

No Codex-harness assumption may be introduced into the generic session
backend.

### Lossless Claw

Lossless Claw keeps its own database and context-engine lifecycle. This plan
does not change its thresholds, leaf sizes, summary routes, or database.

Before the session backend flips:

- inspect the maintained `shariq` branch of `../lossless-claw`;
- enumerate every OpenClaw session-store, transcript-file, and session-manager
  dependency it consumes;
- preserve the active transcript and SessionManager contract;
- verify automatic and manual compaction;
- verify reconciliation of in-turn messages;
- verify Gateway restart with the existing LCM database;
- verify that stateless subagents remain stateless and do not gain unnecessary
  persistence.

If LCM directly reads `sessions.json`, migrate that integration to a public
session accessor or injected row API before activation. Do not add a hidden
JSON mirror for LCM.

### Plugin SDK

The row-oriented plugin SDK APIs are the forward contract:

- `getSessionEntry`
- `listSessionEntries`
- `patchSessionEntry`
- `upsertSessionEntry`

Deprecated whole-store helpers remain during their shipped compatibility
window. They operate against SQLite through one transactional snapshot/diff
adapter. Direct `sessions.json` consumers must migrate.

No plugin-specific behavior belongs in the generic backend.

### Custom session store paths

`session.store` and CLI `--store` behavior are compatibility-sensitive.
Implementation must establish the shipped contract before changing it.

Proposed rule:

- `openclaw doctor --fix` imports configured JSON stores into the owning agent
  database and rewrites/removes obsolete runtime config.
- Explicit CLI import/export commands may still accept a JSON path as an
  artifact boundary.
- Normal Gateway runtime never selects a JSON backend.

If tagged releases prove that arbitrary runtime store paths are a required
public contract, the implementation must define a database-path mapping or
deprecation window before removing them.

## Correctness Implementation Batches

Each batch is a separate commit and rollback point. Batch 1 must pass before
Batch 2, Batch 2 before Batch 3, and Batches 4-5 remain isolated from those
ownership fixes. Do not combine these fixes with trajectory or session-storage
changes.

### Batch 1 implementation surface

Expected OpenClaw surfaces:

- `packages/agent-core/src/agent.ts`
- `packages/agent-core/src/agent-loop.ts`
- `src/auto-reply/reply/queue/types.ts`
- `src/auto-reply/reply/queue-policy.ts`
- `src/auto-reply/reply/get-reply-run.ts`
- `src/auto-reply/reply/agent-runner.ts`
- `src/auto-reply/reply/reply-run-registry.ts`
- a narrow active-turn intent owner using the existing
  `src/channels/message/ingress-queue.ts` abstraction
- `src/agents/tools/sessions-send-tool.ts`
- `src/agents/embedded-agent-runner/runs.ts`
- `src/agents/embedded-agent-runner/run/attempt.ts`
- `src/agents/embedded-agent-runner/run/attempt.queue-message.ts`
- `src/agents/embedded-agent-runner/run/attempt.session-lock.ts`
- Discord and TUI integration surfaces only where failing tests require them
- queue config types, schema, help, and docs
- subagent cancellation, announcement, and lane-owner helpers only where the
  traced lifecycle requires them
- focused session-send, active-run queue, and session-lock tests

Exit criteria:

- `redirect` is additive and omitted mode still resolves to `steer`;
- model-generation redirect cancels only the provider request and continues the
  same logical turn;
- tool execution and concurrent batches complete once before correction
  adoption;
- completed tool results and display-safe partial output are retained exactly
  once;
- multiple corrections retain deterministic order and idempotency;
- finalization races produce either one redirect before commit or exactly one
  follow-up after commit;
- accepted intent remains recoverable until transcript adoption, and completed
  rows retain no correction text;
- both captured duplicate-final/takeover timelines fail before the fix and pass
  afterward;
- steering reaches an active persistent subagent without starting a competing
  turn;
- cancellation during a tool run uses control cancellation and cannot start a
  duplicate model turn;
- post-completion follow-up waits for terminal transcript publication;
- two trusted sends preserve order and do not duplicate work;
- unknown append, mutation, and truncation still raise takeover;
- restart or abort cannot replay queued steering or stale announcements.
- TUI queue-surface resolution is proven rather than assumed;
- Discord canonical target routing passes; production routing is unchanged if
  the test was already green;
- intentional inline or persisted session queue modes retain precedence over
  the eventual global installation setting.

### Batch 2 implementation surface

Expected OpenClaw surfaces:

- `src/context-engine/types.ts`
- `src/context-engine/delegate.ts`
- `src/agents/embedded-agent-runner/run.ts`
- focused context-engine delegation and overflow-recovery tests

Expected Lossless Claw surfaces:

- `src/engine.ts`
- context-engine contract types only where the plugin exposes them
- lifecycle and engine-compaction tests
- regenerated `dist/index.js` and package artifacts required by its build

Exit criteria:

- stateful LCM recovery preserves `284388 -> compact -> retry`;
- a stateless subagent delegates to native compaction without creating LCM
  persistence;
- native fallback converges against `targetPromptTokens`;
- complete-prompt no-progress is decided after OpenClaw reassembly;
- cancellation and no-progress terminate without retry loops;
- older engines without the optional disposition preserve current behavior;
- the active LCM checkout is clean, pinned to the committed fork revision, and
  source/test/dist/runtime parity is verified.

### Batch 3 implementation surface

Expected OpenClaw surfaces:

- `src/agents/bash-tools.schemas.ts`
- eager and lazy exec-tool construction paths
- the prepared attempt/session capability shape that owns exec-host facts
- focused schema and runtime-enforcement tests

Exit criteria:

- unavailable sandbox and node hosts are absent from the model-facing schema;
- available hosts remain selectable;
- session overrides and policy restrictions are reflected at schema creation;
- a capability disappearing after schema creation still fails safely at
  execution;
- explicit unavailable sandbox execution never falls through to Gateway
  execution;
- schema caching or config reload cannot retain capabilities beyond its owning
  lifecycle.

### Batch 4 implementation surface

Expected OpenClaw surfaces:

- `src/agents/openai-server-compaction.ts`
- `src/agents/agent-hooks/openai-server-compaction.ts`
- `src/agents/agent-hooks/compaction-safeguard.ts`
- `src/agents/embedded-agent-runner/compact.queued.ts`
- `src/agents/embedded-agent-runner/run.ts`
- `src/agents/embedded-agent-runner/extensions.ts`
- `packages/ai/src/internal/openai.ts`
- `extensions/openai/openai-chatgpt-provider.ts`
- focused provider, compaction, extension, timeout, and overflow tests

Exit criteria:

- compatible native Pi/OpenClaw compaction stores exactly one opaque artifact;
- endpoint failure retains successful local or LCM compaction;
- repeated compaction uses prior opaque state plus compatible trailing turns;
- resume preserves pending user intent without replaying another model's turn;
- model switches and newer compaction boundaries cannot reuse stale artifacts;
- ChatGPT requests retain `store:false` reasoning/item-id replay protections;
- stateful LCM manual, timeout, and overflow paths run direct provider
  compaction after engine compaction;
- stateless native delegation does not run a duplicate provider pass;
- canonical GPT-5.6 model entries expose 1.05M physical capacity while all host
  and LCM operating thresholds remain based on 372K;
- production config validates, canonical LCM source/build parity passes, and
  eager Codex discovery remains disabled without disabling explicit Codex use.

### Batch 5 implementation surface

Expected OpenClaw surfaces:

- `src/plugins/hook-types.ts`
- `src/cron/service/timer.ts`
- `src/cron/service/ops.ts`
- `src/cron/run-log.ts`
- `src/gateway/server-cron.ts`
- the shared-state Kysely schema/migration and a narrow lifecycle-outbox owner
  only if no existing durable primitive satisfies the contract
- plugin SDK exports for exact finished-event identity and the read-only active
  cron-run snapshot
- focused cron persistence, hook replay, restart, overlap, and SDK tests

Expected Lossless Claw surfaces:

- `src/plugin/index.ts`
- `src/openclaw-bridge.ts`
- `src/store/conversation-store.ts`
- `src/prune.ts` only for compatible low-level extraction, without changing
  generic prune behavior
- `src/plugin/lcm-db-backup.ts`
- `src/cli/args.ts`
- `src/cli/main.ts`
- new narrow lifecycle and maintenance modules
- schema migration for idempotent lifecycle receipts if required
- generated `dist` and package artifacts required by the LCM release process
- focused hook, stale-recovery, maintenance, locking, backup, rollback, and CLI
  tests

Expected deployment-only surfaces:

- a thin wrapper around `lcm maintain` for Drive upload, Pipeline handoff, and
  Discord reporting;
- existing helper scripts and unit files retained unchanged but disabled until
  separate retirement approval;
- the infrastructure continuity reference updated only after cutover behavior
  and rollback commands are proven.

Exit criteria:

- every completed cron run exposes exact durable identity after run state and
  run log persistence;
- a restart between persistence and plugin acknowledgement replays archival
  exactly once without replaying the cron payload;
- success, error, timeout, and delivery failure archive only their exact
  run-scoped conversation;
- duplicate and overlapping events cannot archive an unrelated conversation;
- stale recovery preserves the three-hour default and excludes every active or
  ambiguous host-owned run;
- no Discord, interactive, subagent, or non-cron conversation is eligible;
- dry-run maintenance produces a stable atomic report without mutation;
- confirmed copied-fixture maintenance produces and verifies a complete
  restorable backup before deletion;
- purge, sidecar cleanup, FTS rebuild, conditional vacuum, invariants,
  interruption, and rollback all pass fixture tests;
- one disposable live cron is archived natively with unrelated live counts
  unchanged;
- production maintenance remains dry-run and the superseded helper units remain
  disabled but available for rollback.

### Global rebase-skill closeout

Expected global surfaces:

- `$CODEX_HOME/skills/openclaw-rebase/SKILL.md`
- `$CODEX_HOME/skills/openclaw-rebase/references/lcm-maintenance.md`
- existing skill scripts or templates only if their commands no longer match
  the verified workflow

Exit criteria:

- OpenClaw and LCM patch lists exactly match their final `shariq` histories;
- every new local behavior has a named regression test and upstream-absorption
  proof rule;
- paired context-engine commits cannot be replayed or dropped independently;
- paired cron-lifecycle identity, outbox/replay, exact archival, stale
  ownership, and maintenance-safety commits cannot be partially replayed;
- new benchmark, worker, migration, backup, clean-deployment, and soak gates
  appear in the appropriate future rebase steps;
- skill build/install/start/health/canary/push commands match the workflow
  proven during this implementation;
- a readback audit finds no stale base, commit, path, command, or contradictory
  instruction.

## Performance Implementation Phases

The performance phases begin only after Batches 1-4 have landed and passed
their own regression proof.

### Phase 0: Convert proof into repository-owned regression coverage

1. Add a deterministic performance fixture matching:
   - a 10 MiB session store;
   - 500 or more session entries;
   - a 10 MiB trajectory window;
   - 16 concurrent logical agents.
2. Preserve the current implementation as the benchmark control.
3. Record event-loop p99/max, heartbeat p99/max, heap/RSS deltas, logical and
   filesystem/block bytes written, fsync latency, and throughput.
4. Run at least five repetitions and report median and worst observed result.
5. Run the benchmark in an isolated standalone checkout/environment that cannot
   access production state.
6. Keep performance thresholds broad enough for CI variance while asserting
   that the optimized path does not perform whole-store writes.
7. Capture worker queue bytes/wait time where applicable and SQLite transaction
   latency, WAL growth, and checkpoint duration for SQLite candidates.

Expected files:

- a focused benchmark under `scripts/` or the repository's existing
  performance-test surface;
- fixture helpers colocated with session/trajectory tests;
- no committed live data or `/tmp` artifacts.

### Phase 1: Offload trajectory rolling-window maintenance

Phase 1 is implemented after Phase 0 reproduced the qualitative ranking and
confirmed trajectory work as a material contributor.

1. Define a narrow typed job/result protocol.
2. Add one lazy worker with bounded queue accounting.
3. Move read/parse/sort/trim/join/write/rename into the worker.
4. Preserve the existing recorder API.
5. Preserve cleanup timeout behavior.
6. Add worker crash, restart, backpressure, idle teardown, and shutdown tests.
7. Verify the built distribution contains and resolves the worker module.
8. Rerun isolated and mixed baselines.

Expected files:

- `src/trajectory/runtime.ts`
- `src/trajectory/runtime-worker.ts`
- `src/trajectory/runtime-worker-thread.ts`
- `src/trajectory/runtime.test.ts`
- trajectory test helpers only where they reduce duplication
- build/package metadata only if worker-module discovery requires it

Exit criteria:

- byte-identical rolling-window output;
- no main-thread parse/sort/join of the existing window;
- one worker maximum;
- bounded queue memory;
- clean worker teardown;
- no trajectory export or cleanup regression;
- mixed-workload heartbeat p99 materially below the current baseline;
- filesystem write volume and fsync behavior are no worse than the baseline;
- post-Phase-1 measurements are sufficient to decide whether Phase 2 remains
  justified.

All Phase 1 exit criteria passed in the focused trajectory tests, full build,
and five-run mixed benchmark. The synthetic target passed, but the later
production burst requires the additional attribution and memory work below.

### Phase 1.5: Remove retained LCM prompt copies

This is a narrow Lossless Claw optimization with no context, compaction,
retrieval, persistence, or model-visible behavior change.

1. Replace `AssemblePrefixSnapshot.serializedMessages` with fixed-size SHA-256
   digests for each message.
2. Serialize each message once per snapshot and derive its digest and existing
   diagnostic summary from that serialization.
3. Preserve the current 100-conversation LRU bound, prefix/divergence
   decisions, divergence summaries, and diagnostic log fields. Hash values may
   change to a documented digest-of-digests format; their equality semantics
   must not.
4. Never retain full message bodies, serialized prompts, tool results, or
   reasoning solely for prefix diagnostics. Keep only fixed-size digests and
   the existing bounded summaries.
5. Keep the existing final assembled messages and token estimates untouched.

Expected Lossless Claw files:

- `src/assemble-debug.ts`
- `src/engine.ts` only if the snapshot type/call contract requires it
- focused `assemble-debug` and engine assembly tests

Required proof:

- old and new prefix/divergence decisions match for identical, extended,
  shortened, and divergent message sequences;
- message content changes produce a different digest and the same divergence
  position as the current implementation;
- a 100-conversation, production-sized fixture retains only bounded digest and
  summary metadata, not serialized prompt bodies;
- heap retained after the fixture is materially lower;
- assembled messages, estimates, context projection, and provider payload are
  byte-for-byte unchanged.

### Phase 1.6: Attribute remaining production pressure

Add bounded numeric telemetry before activating a larger migration. It must not
record prompt, transcript, tool, credential, or user-message content.

OpenClaw telemetry:

- session-store load, single-entry splice, serialization, write, and rename
  duration;
- old/new store bytes and bytes physically submitted per mutation;
- trajectory worker queue bytes, wait time, job duration, and worker restarts;
- active top-level, cron, and subagent run counts at event-loop and memory
  warnings;
- process RSS, heap used, external memory, and array buffers at run start,
  provider submission, tool boundary, persistence flush, and run release.

Lossless Claw telemetry:

- assembly duration split into context-item load, item resolution, policy
  selection, live reconciliation, serialized clamp, and diagnostic snapshot;
- context-item/message counts, assembled estimated tokens, and diagnostic
  snapshot metadata bytes;
- SQLite busy/wait duration and statement counts without SQL values;
- deferred maintenance queue duration and outcome.

Correlate these metrics by timestamp and opaque run/session hashes. Run
production-shaped isolated workloads at 3, 8, and 15-16 concurrent agents.
Report median, p99, maximum, heap/RSS high-water, and post-idle retained memory.
Use this evidence to authorize one of:

1. Phase 2 SQLite session metadata if whole-store replacement dominates.
2. Batched LCM context resolution if per-item SQLite work dominates.
3. A separately reviewed run-lifecycle retention fix if memory remains held
   after all runs release.

Do not add adaptive throttling, lower configured concurrency, force garbage
collection, or restart on a warning as a substitute for attribution.

### Phase 2: Move session metadata to per-agent SQLite rows

Phase 2 is approved as the target architecture, not yet for activation. Before
implementation or production migration:

1. Complete a repository-wide search for direct `sessions.json` consumers,
   including plugins, packages, CLI paths, and Lossless Claw.
2. Rehearse migration using copies of the production-scale session store and
   each affected per-agent database.
3. Prove entry-count equality and sampled canonical-entry hash equality.
4. Prove concurrent CLI/Gateway writer behavior, alias promotion, and
   lost-update handling.
5. Produce and validate a SQLite-to-JSON rollback export before production
   migration.
6. Confirm Phase 1.6 telemetry identifies whole-store session writes as a
   material remaining bottleneck.

Only after those gates pass:

1. Add `session_entries` and required indexes to the per-agent schema.
2. Regenerate Kysely types.
3. Implement row read/list/patch/upsert/delete transactions behind
   `session-accessor.ts`.
4. Preserve alias canonicalization and lifecycle mutations transactionally.
5. Implement the deprecated whole-store snapshot/diff adapter.
6. Migrate runtime callers that bypass the accessor.
7. Migrate direct plugin/package consumers.
8. Add doctor import from each agent's `sessions.json`.
9. Add offline SQLite-to-JSON rollback export.
10. Keep original JSON as an inactive timestamped backup until rollout
    completion.
11. Remove file backend selection from normal runtime.
12. Correct database-first, session, CLI, backup, and plugin SDK documentation.

Expected core files:

- `src/state/openclaw-agent-schema.sql`
- `src/state/openclaw-agent-schema.generated.ts`
- `src/state/openclaw-agent-db.generated.d.ts`
- `src/config/sessions/session-accessor.ts`
- `src/config/sessions/store.ts`
- a new narrowly owned SQLite session-row module under
  `src/config/sessions/`
- `src/plugin-sdk/session-store-runtime.ts`
- doctor migration and migration tests under `src/commands/` and
  `src/infra/`

Expected consumer audit:

- `src/agents/**`
- `src/auto-reply/**`
- `src/gateway/**`
- `src/cron/**`
- `src/cli/**`
- `packages/memory-host-sdk/**`
- bundled plugins that read `sessions.json` or call whole-store helpers

Exit criteria:

- the complete direct-consumer audit has no unresolved runtime file readers;
- migration rehearsal passes against production-scale copies;
- imported entry counts and sampled hashes match;
- no normal runtime read or write of `sessions.json`;
- no lost update under concurrent patches;
- no runtime dual-write or JSON fallback;
- doctor import is idempotent and verified before source retirement;
- rollback export contains the latest SQLite rows;
- PI/OpenClaw, Discord, cron, subagent, and LCM integration tests pass;
- logical writes scale with changed rows, not total session count.

### Phase 3: Reassess scheduling after storage work

1. Run a 30-minute workload with 15-16 agents, cron jobs, and parallel
   subagents as the initial gate.
2. Capture event-loop, CPU, heap, RSS, queue depth, SQLite transaction latency,
   WAL size/growth, checkpoint latency, filesystem/block writes, fsync latency,
   and worker queue bytes/wait time.
3. Compare against the same current-code workload.
4. Run a longer isolated standalone soak, followed by a quiet production soak
   with automation and concurrency controlled.
5. Return to normal concurrency and automation only after both soaks remain
   healthy and bounded.
6. Implement bounded CPU/persistence pressure control only if the Gateway
   remains degraded.
7. Do not lower production concurrency merely to make the acceptance test pass.

## Required Tests

### Active-turn redirect and persistent-subagent ownership

- Omitted queue mode remains `steer`; explicit `redirect` selects the new path.
- Model request active: ordinary Discord input cancels only that request and
  continues the same logical turn with the correction.
- Tool active: the tool completes once, then the correction is presented before
  the next model decision.
- Concurrent tool batch: correction is consumed once at the defined batch
  boundary.
- Two or more corrections preserve order and are consumed exactly once.
- Finalization race: redirect wins before terminal commit or exactly one
  follow-up starts after commit.
- Display-safe partial assistant text is retained; incomplete signed/encrypted
  reasoning is not replayed.
- Explicit `/steer`, `/stop`, and queued follow-up semantics remain distinct.
- Reproduce both captured duplicate-final/takeover timelines with deterministic
  barriers rather than timing sleeps.
- Steering while the prompt lock is released joins the active run.
- Cancellation while a tool is running aborts without a competing turn.
- Follow-up during finalization waits for terminal publication.
- Two concurrent trusted sends preserve order and idempotency.
- Late or duplicate announcement delivery cannot republish a stale final.
- Unknown external append remains a hard takeover.
- Non-append mutation and truncation remain hard takeovers.
- Gateway restart or run abort cannot replay or lose queued steering silently.
- A redirect claimed by an operation but not adopted before process exit is
  reclaimed exactly once.
- A recovered intent whose original generation is gone becomes exactly one
  follow-up.
- Completed intent tombstones contain no correction payload.
- TUI `chat.send` queue-policy routing is proven.
- Discord `/steer` targets the canonical Discord session rather than slash
  storage; if this already passes, no speculative adapter patch is made.
- Images, attachments, and unsupported media follow the chosen safe follow-up
  path.
- Existing `interrupt`, `steer`, `followup`, and `collect` tests remain green.

### Stateless context recovery

- Stateful LCM recovery replays `284388 -> compact below boundary -> retry`.
- Stateless subagent fallback compacts natively and continues without LCM
  ingestion.
- Native fallback receives `targetPromptTokens` and complete estimate
  provenance.
- Aggregate tool pressure can invoke compaction when no individual result is
  truncatable.
- OpenClaw reassembles and makes the final no-progress decision.
- No native fallback returns a bounded internal-subagent failure without
  suggesting `/new`.
- Cancellation during delegated compaction stops cleanly.
- Direct delegation cannot recurse into the same context engine.
- Third-party engines without the optional disposition remain compatible.

### Exec host capabilities

- No sandbox runtime means `sandbox` is absent from the model-facing enum.
- No eligible connected node means `node` is absent.
- Available sandbox, node, and Gateway hosts remain usable when policy permits.
- Session-level overrides produce the correct capability snapshot.
- Capability loss after schema creation is rejected at execution.
- Explicit disallowed or unavailable requests fail without host substitution.

### OpenAI server compaction

- ChatGPT OAuth and direct OpenAI Responses requests use the normal endpoint
  with a trailing `compaction_trigger` and exactly one returned artifact.
- Request headers, account scope, tool schemas, instructions, reasoning shape,
  cancellation, and `store:false` match the active provider contract.
- The portable summary remains available when the remote endpoint fails.
- Repeated compaction consumes prior opaque history rather than the portable
  summary.
- Resume appends compatible completed turns and pending user intent exactly
  once.
- Another model's completed turn and a newer mismatched compaction boundary
  invalidate opaque replay.
- Stale encrypted reasoning and Responses item IDs remain absent on the
  ChatGPT transport.
- Manual `/compact`, timeout recovery, and overflow recovery invoke direct
  provider compaction after stateful LCM compaction.
- Native provider follow-up reuses the summary already produced by stateful
  LCM; it does not issue a duplicate local summarization request. OpenAI
  failure still finalizes with the successful LCM summary.
- Stateless LCM delegation that already produced an artifact is not compacted
  twice.
- Native non-OpenAI compaction, Codex harness compaction, and third-party
  context engines retain their existing behavior.
- Sol, Terra, and Luna resolve to 1.05M physical, 372K operating, and 128K
  output budgets without alternate model aliases.

### Native LCM cron lifecycle and maintenance

- Scheduled and manual completion events carry the same exact run identity.
- Finished-event delivery cannot begin before cron state and run-log
  persistence complete.
- A crash after persistence but before plugin acknowledgement replays one
  lifecycle event and never reruns the cron payload.
- Successful, errored, timed-out, and delivery-failed runs archive their exact
  run-scoped LCM conversation.
- Missing or invalid `sessionKey`, `sessionId`, `runId`, `jobId`, or
  `runAtMs` fails closed without a prefix or newest-child fallback.
- Two overlapping runs for one job archive only their own conversations.
- Duplicate completion delivery produces one archive transition and one
  idempotent receipt.
- Plugin timeout/failure retains bounded retry state and leaves the cron result
  unchanged.
- Restart before and after archival converges to one archived conversation and
  one acknowledged lifecycle item.
- Stale recovery archives a strict cron conversation idle beyond three hours
  only when no exact active host run owns it.
- An active run older than three hours remains active.
- Missing or ambiguous host ownership evidence produces a dry/no-op audit.
- Discord, interactive, subagent, malformed, and non-cron conversations are
  never stale-recovery candidates.
- Concurrent sweeps are single-flight and an interrupted sweep is restart-safe.
- `lcm maintain` defaults to dry-run and refuses mutation without explicit
  confirmation.
- Candidate selection freezes one cutoff and includes inactive cron
  conversations older than the retention boundary only.
- Backup restoration reproduces the database and `lcm-files` manifest from a
  fixture with committed WAL state.
- Schema, path, symlink, disk-headroom, and active-writer guards fail before
  mutation.
- Purge removes dependent rows transactionally and deletes only sidecars with
  no surviving reference.
- FTS rebuild, foreign-key baseline comparison, integrity checks, and
  conditional vacuum preserve every declared invariant.
- Injected failure and signal interruption restore database/files from the
  verified backup and retain an atomic failure report.
- Generic `prune` behavior and existing backup rotation remain unchanged.
- The OpenClaw-to-LCM integration fixture proves exact event, acknowledgement,
  replay, and audit behavior across both forks.
- A disposable live cron archives exactly one conversation; before/after
  active Discord and non-cron counts are identical.

### Trajectory worker

- Current and worker outputs are byte-identical.
- Out-of-order timestamps and source sequences sort identically.
- Malformed lines retain current ordering behavior.
- Files remain within the configured byte cap.
- Oversized individual events retain current truncation/drop behavior.
- Concurrent flushes for one file remain ordered.
- Flushes for different files cannot corrupt each other.
- Atomic rename preserves the old file if the worker dies before rename.
- Symlink and path-containment protections remain enforced.
- File and directory permissions remain restrictive.
- Worker crash retries at most once.
- Repeated crashes fail without a restart loop.
- Queue bytes are bounded.
- Flush timeout releases agent cleanup.
- Gateway shutdown drains or abandons work according to the existing contract.
- Idle teardown releases the worker and a later write recreates it.
- Built/package execution resolves the worker module.

### SQLite session rows

- Read, list, patch, replace, upsert, and delete preserve `SessionEntry`.
- Alias resolution selects the same freshest entry as the file backend.
- Alias promotion and deletion are one transaction.
- Concurrent updates do not lose fields.
- Compare-and-swap conflict handling is bounded and observable.
- Whole-store compatibility mutation applies changed and deleted rows once.
- No-op updates do not write.
- Transaction failure publishes no cache or observer update.
- Process death rolls back an uncommitted transaction.
- WAL recovery passes `PRAGMA integrity_check`.
- WAL/checkpoint behavior remains valid on supported Node versions.
- Maintenance, pruning, disk budgets, and lifecycle cleanup preserve behavior.
- Prompt-blob ownership and cleanup remain correct.
- Doctor import preserves every supported session entry.
- Doctor import is idempotent.
- Failed import leaves the JSON source and database recoverable.
- Successful import records migration provenance.
- Rollback export round-trips current rows to valid JSON.
- Custom store migration follows the approved compatibility rule.
- Backup and restore use SQLite's backup mechanism or a verified checkpointed
  offline copy; they never assume the main database file alone contains every
  committed transaction.
- Restored databases pass row-count checks and `PRAGMA integrity_check`.
- Backup proof records WAL/checkpoint state and demonstrates restoration from
  the produced artifact.

### Runtime integrations

- PI/OpenClaw embedded turns pass.
- `/new` creates a fresh usable session and visible reply.
- `/compact` and automatic overflow recovery pass with Lossless Claw.
- Gateway restart recovers active session metadata.
- Discord message, reply, streaming, and command flows pass.
- Subagent spawn, nested limits, announce, cancel, and archive pass.
- Cron isolated runs and final delivery pass.
- Pending final delivery and restart recovery pass.
- Session status, history, list, delete, and export pass.
- Plugin row APIs pass against SQLite.
- Deprecated whole-store plugin APIs remain compatible.
- Context engines other than Lossless Claw are unaffected.

### Performance and stability

- Exact current-code baseline remains available for comparison.
- LCM prefix diagnostics retain fixed-size message digests, not serialized
  prompt bodies, and produce the same prefix/divergence decisions.
- A 16-agent mixed test performs no whole-store session writes.
- Event-loop p99 target: below 25 ms during the storage fixture.
- Event-loop maximum target: below 250 ms during the storage fixture.
- Heartbeat p99 target: below 10 ms during the storage fixture.
- Peak heap growth is at least 75% lower than the current mixed baseline.
- Logical session write volume scales with changed-row size.
- Filesystem/block writes materially improve with logical write volume.
- Fsync latency, SQLite transaction latency, WAL growth, checkpoint duration,
  and worker queue wait/bytes remain bounded.
- Worker count never exceeds one.
- No monotonic heap/RSS growth during the initial or extended soak.
- Post-idle retained memory is measured after each 3, 8, and 15-16 run fixture;
  any plateau must be attributed before deployment.
- No health or session-history timeout during the soak.
- No infinite retry, worker restart, or SQLite busy loop.

## Validation Sequence

Run the narrowest proof first, then broaden:

1. Deterministic redirect, finalization, TUI/Discord routing, and both
   persistent-subagent takeover incident replays.
2. Model-request-only cancellation, tool-boundary redirect, durable adoption,
   stale-claim recovery, session-lock, announcement, and restart concurrency
   tests.
3. Verify omitted mode remains `steer`, explicit `redirect` works, and
   per-session override precedence is unchanged.
4. OpenClaw context-engine delegation and overflow-recovery tests.
5. Lossless Claw stateful/stateless compaction and lifecycle tests.
6. Capability-aware exec schema and runtime-enforcement tests.
7. OpenClaw post-persist cron identity, durable delivery, replay, and active-run
   snapshot tests.
8. Lossless Claw exact archival, stale recovery, maintenance, backup, locking,
   interruption, and rollback fixture tests.
9. Cross-fork lifecycle integration against temporary OpenClaw and LCM
   databases.
10. Build and package OpenClaw and Lossless Claw; verify clean source/dist
    provenance.
11. Run the repository-owned Phase 0 benchmark at least five times.
12. Focused trajectory worker tests after Phase 0 authorizes Phase 1.
13. Rerun isolated and mixed benchmarks after Phase 1.
14. Lossless Claw prefix-digest equivalence and retained-heap tests.
15. Run the Phase 1.6 attribution workload at 3, 8, and 15-16 concurrent runs.
16. Perform the direct-consumer audit and migration rehearsal before Phase 2.
17. Focused session accessor and SQLite row tests.
18. Doctor migration and rollback round-trip tests.
19. Plugin SDK session-store tests.
20. PI embedded runner, session lifecycle, cron, subagent, and Discord tests.
21. Database schema generation and Kysely guards.
22. Import-cycle, formatting, lint, and changed typecheck lanes.
23. Full build because worker packaging and generated database types change.
24. Repeated 16-agent benchmark.
25. 30-minute isolated Gateway soak.
26. Longer isolated standalone soak.
27. Quiet production soak with controlled automation.
28. Perform the stopped-Gateway lifecycle cutover, one disposable live cron
    archival canary, copied-fixture stale recovery, and production maintenance
    dry-run.
29. Refresh and audit the global `openclaw-rebase` skill against the final
    OpenClaw and LCM commit histories and proven deployment workflow.
30. Fresh mandatory autoreview for each implementation batch until no
    actionable findings remain.

The implementation work must not use OpenClaw repo-local skills, Crabbox, or
Testbox. Use direct repository commands and isolated local/standalone
environments. The historical `/tmp` benchmark is diagnostic evidence only; the
new committed benchmark is the reproducible source of truth.

## Deployment Plan

No production deployment occurs until the applicable batch or phase exit
criteria pass. Batches 1-3 may deploy before the conditional persistence
phases, but each deployment must retain a clean rollback point.

1. Stop the Gateway cleanly.
2. Stop or freeze the LCM completion watcher, janitor, and every helper capable
   of mutating session or LCM state.
3. Verify no Gateway, OpenClaw helper, LCM helper, active run, or maintenance
   writer remains.
4. Back up:
   - OpenClaw config;
   - every agent's `sessions.json`;
   - every agent database;
   - Lossless Claw database;
   - Lossless Claw `lcm-files`;
   - relevant transcript and trajectory directories.
5. Back up SQLite databases through SQLite's backup mechanism or from a
   verified checkpointed offline state. Do not copy only the main database file
   while committed transactions may remain in WAL.
6. Validate backup restoration, row counts, WAL/checkpoint state, and
   `PRAGMA integrity_check` before migration.
7. Enumerate inline and persisted session queue-mode overrides and record their
   precedence without changing them.
8. Install the built OpenClaw `shariq` branch.
9. Deploy Lossless Claw from a clean dedicated checkout pinned to its committed
   `shariq` revision; verify source, tests, dist, plugin metadata, and commit
   provenance agree.
10. Run the explicit doctor migration only when deploying authorized Phase 2.
11. Verify row counts, sampled entry hashes, migration provenance, and SQLite
    integrity.
12. Produce and validate the current SQLite-to-JSON rollback export before the
    migrated runtime accepts production writes.
13. Keep migrated JSON files as inactive backups; do not let runtime read them.
14. After code and config validation, explicitly set this installation's
    global `messages.queue.mode` to `redirect`. Do not add a `webchat` override
    unless the TUI routing test proves that surface.
15. Apply Shariq's complete approved `openclaw.json` settings batch, including
    removal of duplicate primary-model fallback entries and replacement of
    Brave/Perplexity search plus direct fetch with the bundled Firecrawl
    provider. Add and enable the bundled `device-pair` plugin without changing
    Discord or Gateway authentication behavior, then validate the canonical
    config shape. Keep the Gateway stopped while any requested setting remains
    unspecified or under discussion.
16. Obtain Shariq's explicit confirmation that the settings list is complete.
17. Start the Gateway through the OpenClaw Gateway CLI unless that command
    fails and the fallback is recorded.
18. Wait at least 30 seconds.
19. Run `openclaw health`.
20. Verify an ordinary Discord correction during model generation redirects
    the same logical turn, and a correction during tool execution waits for a
    safe boundary.
21. Verify ordinary Discord turns and directly delivered thread-bound
    subagents honor their effective configured `off`, `partial`, `block`, or
    `progress` mode, while each final answer is delivered exactly once in its
    correct channel or thread.
22. Verify `/usage full` retains all full-summary fields and renders numeric
    context as used/max/percent without overriding persisted session choices.
    Verify `/pair qr` exposes the short-lived iOS setup flow and that device
    approval remains required.
23. Verify the interactive TUI follows the same global redirect policy.
24. Verify `/steer`, queued follow-up, and `/stop` remain distinct.
25. Verify a Discord message round trip.
26. Verify `/new`.
27. Verify manual `/compact`, stateful automatic recovery, and stateless
    subagent native fallback.
28. Verify active-subagent steering, cancellation, follow-up-after-finalization,
    and absence of duplicate finals or takeover errors.
29. Verify the exec schema advertises only live session capabilities and that
    explicit unavailable hosts still fail safely.
30. Verify model-call idle and WebSocket recovery uses one bounded retry,
    preserves completed tools, and surfaces an exhausted failure visibly.
31. Verify Firecrawl is the only configured web-search provider, performs one
    safe search and one safe fetch successfully, and does not expose its
    credential.
32. Verify existing sessions, cron delivery, subagent execution, restart
    recovery, and absence of runtime JSON fallback.
33. Observe event-loop, CPU, RSS, heap, worker queue, WAL, checkpoint, fsync,
    block-write, and LCM metrics during normal load.
34. For Batch 5, keep the superseded completion watcher, janitor, and weekly
    timer disabled; run one disposable cron lifecycle canary, copied-fixture
    stale recovery, and production `lcm maintain` dry-run. For deployments
    before Batch 5, resume only the helpers recorded active in the baseline.
35. Verify the lifecycle canary archives only its exact conversation, produces
    one acknowledged receipt, survives duplicate delivery, and leaves active
    Discord/non-cron counts unchanged.
36. Update the global rebase skill with final commit hashes and any durable
    workflow facts learned from deployment, then verify its complete readback
    before final handoff.

Gateway restart alone is enough for new runtime code to load. Existing
sessions should continue after migration; `/new` must not be required as an
upgrade workaround.

## Rollback Plan

Do not rely on the pre-migration JSON backup after new SQLite writes occur.

Rollback requires:

1. Stop the Gateway.
2. Freeze the same helper writers used during deployment.
3. Run the offline SQLite-to-JSON rollback export.
4. Verify exported entry count and sampled hashes.
5. Restore the previous OpenClaw build.
6. Restore any config key migrated by doctor.
7. Start the Gateway.
8. Wait 30 seconds and run health plus Discord, `/new`, and LCM checks.
9. Resume helpers only after rollback canaries pass.

Lossless Claw's database and transcript files are not migrated by Phase 2 and
do not require conversion for that phase. Batch 5 rollback restores the
matching LCM database, WAL-consistent backup, `lcm-files`, source/build, and
previously active helper unit states together.

Rollback immediately if:

- redirect aborts a running tool, starts a competing turn, loses accepted
  intent, duplicates a correction, or publishes a stale provider/finalizer
  result;
- omitted queue mode no longer defaults to `steer`, or existing explicit
  session modes lose precedence;
- persistent-subagent steering duplicates a turn, tool effect, or final;
- expected trusted steering still produces a takeover;
- unknown transcript mutation no longer produces a takeover;
- stateless compaction cannot reach native fallback or loops recursively;
- stateful LCM recovery regresses;
- active LCM source/dist/runtime provenance is not clean and consistent;
- the exec schema advertises unavailable hosts or weakens sandbox isolation;
- cron lifecycle delivery occurs before durable run identity, loses a terminal
  event, retries the cron payload, or archives any non-exact conversation;
- stale recovery touches an active, ambiguous, Discord, interactive, subagent,
  or non-cron conversation;
- confirmed maintenance can run beside an active writer, mutates without an
  explicit confirmation, or cannot restore its verified backup;
- SQLite integrity fails;
- session rows disappear or lose fields;
- `/new`, `/compact`, or PI turns regress;
- LCM cannot reconcile an existing session;
- worker crashes repeatedly;
- event-loop or memory behavior is materially worse;
- migration requires a runtime JSON fallback.

## Rebase Risk

### Trajectory worker: medium

The patch is localized, but `src/trajectory/runtime.ts` is active runtime code
and worker build paths are packaging-sensitive. Keeping the recorder API and
file format unchanged limits conflicts.

### SQLite session metadata: high

Session state crosses agents, auto-reply, gateway, cron, CLI, plugins, memory,
doctor, backup, and tests. The accessor boundary reduces long-term rebase risk,
but the initial migration has a broad consumer audit.

Risk controls:

- implement behind the existing accessor rather than adding another facade;
- keep transcripts out of the first migration;
- preserve plugin row APIs;
- contain whole-store compatibility in one adapter;
- avoid config flags and runtime fallback stacks;
- split trajectory and session work into independently reviewable commits;
- rebase each phase onto the stable upstream release branch before deployment;
- use `git range-diff` and behavioral proof when replaying fork patches.

### Native LCM lifecycle: medium

The exact completion hook is narrow, but durable post-persist delivery crosses
cron finalization, the plugin SDK, OpenClaw shared state, and LCM archival.
Maintenance has high operational consequences despite being isolated to the
LCM CLI.

Risk controls:

- keep the event contract generic and exact-run scoped;
- persist before delivery and acknowledge only after an idempotent LCM commit;
- never infer identity from prefixes, names, timing, or newest conversations;
- keep stale recovery cron-only and ownership-aware;
- default maintenance to dry-run and require an exclusive writer lease;
- test mutation, backup, interruption, and rollback on copied fixtures;
- retain old helper artifacts disabled until separate retirement approval;
- keep OpenClaw and LCM lifecycle commits paired in the rebase skill.

## Completion Criteria

The current implementation batch is complete when:

- explicit `redirect` provides model-request-only cancellation and same-turn
  continuation while omitted mode remains `steer`;
- durable corrections are adopted exactly once, recovered as one follow-up
  after a crash when their operation is gone, and removed from completed queue
  payloads;
- Discord and TUI behavior is proven without guessing their queue surface;
- persistent-subagent steering, cancellation, and post-finalization follow-up
  have one lifecycle owner and do not duplicate turns, tools, or finals;
- the takeover fence still rejects unknown appenders, mutation, and truncation;
- stateless subagents can compact through target-aware native fallback without
  LCM persistence;
- stateful LCM overflow recovery remains successful;
- Lossless Claw production artifacts identify a clean committed fork revision;
- exec schemas advertise only session-available hosts while runtime enforcement
  remains authoritative;
- duplicate primary fallbacks cannot suppress bounded same-model idle recovery;
- retryable no-output WebSocket failures recover once over SSE without
  replaying completed tools, while ambiguous post-output failures fail closed;
- exhausted model-call recovery produces one visible channel error;
- Firecrawl is the configured provider for both web search and web fetch, while
  its credential remains outside Git and diagnostic output;
- directly delivered thread-bound subagents honor their effective configured
  channel streaming mode without transcript changes, stale drafts, replayed
  tools, or duplicate finals;
- `/usage full` preserves its complete summary while showing numeric
  used/max/percent context through the supported template configuration;
- the bundled `device-pair` plugin provides `/pair qr` for iOS setup without
  changing Discord, session, queue, LCM, or Gateway authentication behavior;
- exact post-persist cron lifecycle events archive one matching LCM
  conversation across success, error, timeout, delivery failure, duplicate,
  overlap, and restart cases;
- stale recovery retains its three-hour default, protects active ownership, and
  never selects non-cron sessions;
- `lcm maintain` is typed, dry-run by default, backup-first, invariant-checked,
  interruption-safe, and proven restorable on copied fixtures;
- superseded LCM helper units remain disabled after the native canary while
  their scripts and units remain available for rollback;
- the Phase 0 benchmark is committed and reproducible in the isolated
  standalone validation environment;
- Phase 1 measurements reproduce a material trajectory-worker improvement;
- Phase 2 is activated only after its consumer, migration, and rollback gates;
- the global `openclaw-rebase` skill and LCM maintenance reference identify
  every retained fork patch, its behavior, tests, replay order, and
  upstream-absorption proof;
- one worker owns trajectory rolling-window maintenance;
- PI/OpenClaw and Lossless Claw behavior is unchanged;
- `/new`, `/compact`, cron, subagents, Discord, restart recovery, and plugin SDK
  flows pass;
- benchmark and soak targets pass without lowering the production concurrency
  configuration;
- memory remains bounded;
- health remains ready under the representative workload;
- deployment and rollback are both proven from backups.

The SQLite-only completion criteria apply only if Phase 2 is separately
authorized after its evidence gates.
