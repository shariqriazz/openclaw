# Gateway Persistence Performance Plan

- Status: proposed, not implemented
- Target branch: `shariq`
- Baseline: OpenClaw `2026.7.1` at `969bd2c17ba`
- Investigation date: 2026-07-24

## Decision

Adopt **SQLite session metadata plus one trajectory rewrite worker** as the
target architecture.

This means:

- Session metadata moves from whole-file `sessions.json` replacement to
  row-level transactions in each agent's existing `openclaw-agent.sqlite`.
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

SQLite plus one worker was the best measured combination, but it is not a
drop-in patch. The session accessor, plugin SDK compatibility surface, doctor
migration, direct file consumers, backup/restore behavior, PI runtime, and
Lossless Claw contract must move together.

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
removed or left outside the repository. The benchmark:

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

Short microbenchmarks do not predict every production latency tail. They
identify dominant allocation, serialization, and event-loop behavior. A longer
repo-native soak is required before deployment.

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

## Implementation Phases

### Phase 0: Convert proof into repository-owned regression coverage

1. Add a deterministic performance fixture matching:
   - a 10 MiB session store;
   - 500 or more session entries;
   - a 10 MiB trajectory window;
   - 16 concurrent logical agents.
2. Preserve the current implementation as the benchmark control.
3. Record event-loop p99/max, heartbeat p99/max, heap/RSS deltas, bytes written,
   and throughput.
4. Run at least five repetitions and report median and worst observed result.
5. Keep performance thresholds broad enough for CI variance while asserting
   that the optimized path does not perform whole-store writes.

Expected files:

- a focused benchmark under `scripts/` or the repository's existing
  performance-test surface;
- fixture helpers colocated with session/trajectory tests;
- no committed live data or `/tmp` artifacts.

### Phase 1: Offload trajectory rolling-window maintenance

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
- mixed-workload heartbeat p99 materially below the current baseline.

### Phase 2: Move session metadata to per-agent SQLite rows

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

- no normal runtime read or write of `sessions.json`;
- no lost update under concurrent patches;
- no runtime dual-write or JSON fallback;
- doctor import is idempotent and verified before source retirement;
- rollback export contains the latest SQLite rows;
- PI/OpenClaw, Discord, cron, subagent, and LCM integration tests pass;
- logical writes scale with changed rows, not total session count.

### Phase 3: Reassess scheduling after storage work

1. Run a 30-minute workload with 15-16 agents, cron jobs, and parallel
   subagents.
2. Capture event-loop, CPU, heap, RSS, queue depth, SQLite transaction latency,
   WAL size, and worker queue metrics.
3. Compare against the same current-code workload.
4. Implement bounded CPU/persistence pressure control only if the Gateway
   remains degraded.
5. Do not lower production concurrency merely to make the acceptance test pass.

## Required Tests

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
- Backup and restore include the per-agent database and omit live WAL/SHM
  sidecars correctly.

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
- Worker count never exceeds one.
- No monotonic heap/RSS growth during a 30-minute soak.
- No health or session-history timeout during the soak.
- No infinite retry, worker restart, or SQLite busy loop.

## Validation Sequence

Run the narrowest proof first, then broaden:

1. Focused trajectory worker tests.
2. Focused session accessor and SQLite row tests.
3. Doctor migration and rollback round-trip tests.
4. Plugin SDK session-store tests.
5. PI embedded runner, session lifecycle, cron, subagent, and Discord tests.
6. Lossless Claw automatic/manual compaction integration.
7. Database schema generation and Kysely guards.
8. Import-cycle, formatting, lint, and changed typecheck lanes.
9. Full build because worker packaging and generated database types change.
10. Repeated 16-agent benchmark.
11. 30-minute isolated Gateway soak.
12. Fresh mandatory autoreview until no actionable findings remain.

The implementation work must use the repository's remote Testbox/Crabbox
validation workflow. The `/tmp` benchmark is diagnostic evidence only.

## Deployment Plan

No production deployment occurs until all phase exit criteria pass.

1. Stop the Gateway cleanly.
2. Verify no active run or maintenance operation remains.
3. Back up:
   - OpenClaw config;
   - every agent's `sessions.json`;
   - every agent database;
   - Lossless Claw database;
   - relevant transcript and trajectory directories.
4. Validate backup integrity before migration.
5. Install the built `shariq` branch.
6. Run the explicit doctor migration.
7. Verify row counts, sampled entry hashes, migration provenance, and SQLite
   integrity.
8. Keep migrated JSON files as inactive backups; do not let runtime read them.
9. Start the Gateway.
10. Wait at least 30 seconds.
11. Run `openclaw health`.
12. Verify a Discord message round trip.
13. Verify `/new`.
14. Verify manual `/compact` and an LCM-backed continuation.
15. Verify cron and subagent execution.
16. Observe event-loop, CPU, RSS, heap, worker queue, WAL, and LCM metrics during
    normal load.

Gateway restart alone is enough for new runtime code to load. Existing
sessions should continue after migration; `/new` must not be required as an
upgrade workaround.

## Rollback Plan

Do not rely on the pre-migration JSON backup after new SQLite writes occur.

Rollback requires:

1. Stop the Gateway.
2. Run the offline SQLite-to-JSON rollback export.
3. Verify exported entry count and sampled hashes.
4. Restore the previous OpenClaw build.
5. Restore any config key migrated by doctor.
6. Start the Gateway.
7. Wait 30 seconds and run health plus Discord, `/new`, and LCM checks.

Lossless Claw's database and transcript files are not migrated by Phase 2 and
should not require conversion.

Rollback immediately if:

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

This plan is complete only when:

- session metadata uses SQLite rows in normal runtime;
- one worker owns trajectory rolling-window maintenance;
- `sessions.json` is migration/import/export only;
- PI/OpenClaw and Lossless Claw behavior is unchanged;
- `/new`, `/compact`, cron, subagents, Discord, restart recovery, and plugin SDK
  flows pass;
- benchmark and soak targets pass without lowering the production concurrency
  configuration;
- memory remains bounded;
- health remains ready under the representative workload;
- database-first documentation matches the actual implementation;
- deployment and rollback are both proven from backups.
