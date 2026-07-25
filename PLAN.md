# Gateway Reliability and Persistence Performance Plan

- Status: correctness Batches 1-4 and performance Phases 0-1 implemented and
  validated; performance Phase 2 deferred pending consumer, migration, and
  rollback proof
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
6. Move session metadata to per-agent SQLite only if post-worker measurements,
   the consumer audit, and migration rehearsal still support it.
7. Use OpenAI Responses server compaction for compatible OpenAI models while
   retaining the readable local summary as a portability and failure fallback.
8. Keep GPT-5.6's physical provider envelope separate from the operating prompt
   budget: 1.05M physical, 372K input, and 128K output.
9. Refresh the global `openclaw-rebase` skill with the final OpenClaw and LCM
   patch histories, protected behavior, validation commands, and deployment
   lessons before final handoff.

The deployed performance architecture is one bounded trajectory worker.
Per-agent SQLite session metadata remains a conditional future phase, not part
of this deployment.

Execution uses global operator skills and direct source/runtime inspection only.
Do not invoke OpenClaw repo-local skills, Crabbox, or Testbox. Run builds,
focused tests, benchmarks, and soaks in a controlled local or standalone
non-production environment that cannot touch live sessions, databases, config,
Discord, cron state, or the active extension. Stop the production Gateway and
freeze live writers before changing the active checkout or building artifacts
served by production.

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

Phase 2 remains conditional. It may proceed only if production telemetry still
shows whole-store session writes as a material bottleneck and after a complete
direct-consumer audit plus migration and rollback rehearsal using copies of
production-scale data.

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

Do not change retry or fallback behavior in this program. Current evidence
shows bounded classification and later recovery without configuration changes,
which is consistent with external provider failures. A retry change requires
separate proof of a local defect and replay safety after possible tool side
effects.

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
Batch 2, Batch 2 before Batch 3, and Batch 4 remains isolated from those
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
and five-run mixed benchmark. Phase 2 is not required to meet the current
performance or memory target.

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
6. Confirm Phase 1 measurements still identify whole-store session writes as a
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
- Stateless LCM delegation that already produced an artifact is not compacted
  twice.
- Native non-OpenAI compaction, Codex harness compaction, and third-party
  context engines retain their existing behavior.
- Sol, Terra, and Luna resolve to 1.05M physical, 372K operating, and 128K
  output budgets without alternate model aliases.

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
7. Build and package OpenClaw and Lossless Claw; verify clean source/dist
   provenance.
8. Run the repository-owned Phase 0 benchmark at least five times.
9. Focused trajectory worker tests after Phase 0 authorizes Phase 1.
10. Rerun isolated and mixed benchmarks after Phase 1.
11. Perform the direct-consumer audit and migration rehearsal before Phase 2.
12. Focused session accessor and SQLite row tests.
13. Doctor migration and rollback round-trip tests.
14. Plugin SDK session-store tests.
15. PI embedded runner, session lifecycle, cron, subagent, and Discord tests.
16. Database schema generation and Kysely guards.
17. Import-cycle, formatting, lint, and changed typecheck lanes.
18. Full build because worker packaging and generated database types change.
19. Repeated 16-agent benchmark.
20. 30-minute isolated Gateway soak.
21. Longer isolated standalone soak.
22. Quiet production soak with controlled automation.
23. Refresh and audit the global `openclaw-rebase` skill against the final
    OpenClaw and LCM commit histories and proven deployment workflow.
24. Fresh mandatory autoreview for each implementation batch until no
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
15. Start the Gateway through the OpenClaw Gateway CLI unless that command
    fails and the fallback is recorded.
16. Wait at least 30 seconds.
17. Run `openclaw health`.
18. Verify an ordinary Discord correction during model generation redirects
    the same logical turn, and a correction during tool execution waits for a
    safe boundary.
19. Verify the interactive TUI follows the same global redirect policy.
20. Verify `/steer`, queued follow-up, and `/stop` remain distinct.
21. Verify a Discord message round trip.
22. Verify `/new`.
23. Verify manual `/compact`, stateful automatic recovery, and stateless
    subagent native fallback.
24. Verify active-subagent steering, cancellation, follow-up-after-finalization,
    and absence of duplicate finals or takeover errors.
25. Verify the exec schema advertises only live session capabilities and that
    explicit unavailable hosts still fail safely.
26. Verify existing sessions, cron delivery, subagent execution, restart
    recovery, and absence of runtime JSON fallback.
27. Observe event-loop, CPU, RSS, heap, worker queue, WAL, checkpoint, fsync,
    block-write, and LCM metrics during normal load.
28. Resume frozen helpers only after Gateway, Discord, plugin parity, context,
    steering, and exec-host canaries pass.
29. Update the global rebase skill with final commit hashes and any durable
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
should not require conversion.

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
- provider/network retry behavior remains unchanged unless separately proven
  defective;
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
