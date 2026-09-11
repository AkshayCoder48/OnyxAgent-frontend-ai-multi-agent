# Cloud Workspace Recovery — 2026-09-11

Preserved backup of everything that survived the OnyxBase storage incident
for the `workspace_default` snapshot (generation 1, committed
2026-09-11T10:02:06Z — 10 files, 176,598 bytes).

## What happened

- OnyxBase's multi-instance KV lost the committed **manifest record** (both
  the primary `m:` and replica `mr:` copies) and ~70% of the file chunk
  records when their Telegram-mirror writes silently failed. This is the
  backend durability incident documented in
  `src/lib/onyxbase/workspace-sync.ts` (DURABILITY / RECOVERY sections).
- The loss happened **on OnyxBase's side, before any re-push** — nothing the
  app did deleted data, and no re-push ever overwrote the snapshot.
- `retrieve_workspace` now SALVAGES whatever verifies instead of failing
  (see the engine's RECOVERY notes); this folder is the manual equivalent,
  captured with the account's own key during diagnosis.

## Contents

- `raw/` — verbatim OnyxBase responses captured at diagnosis time:
  - `list.json` — key listing (19 records surviving)
  - `pointer.json` — the committed pointer record (intact)
  - `chunks.json` — all 18 surviving file-chunk record values
  - `export.json` — full `/v1/export` account dump (authoritative)
- `salvaged/` — the two files that re-assembled and passed their embedded
  sha-256 prefixes:
  - `recovered_b7cf3e96e1f74fc1_afae8986.bin` (3,526 B) — the sandbox's
    default `~/.bashrc` (Ubuntu template, not user work)
  - `recovered_e42035c31f3798d9_658d8cd8.bin` (123 B) — one chat-log JSON
    line (`push_workspace` tool-call record)

## Honest verdict

The remaining 9 chunk groups were mid-stream holes (missing early chunks).
Gzip streams cannot be decompressed from the middle, so the original project
files (~170 KB) are **not recoverable from OnyxBase**. If another copy of the
work exists anywhere (local machine, editor history), drop the files into the
sandbox and `push_workspace` will commit a fresh, verified snapshot.

## Preventive fixes shipped with this backup

- Per-file `fm:` metadata records (distributed manifest — file-granularity
  recovery)
- Strict pre-commit read-back verification of EVERY staged record (stranded
  writes block the commit instead of advertising broken snapshots)
- Salvage mode + honest reporting on corrupt snapshots
- Empty-push guard (`EMPTY_PUSH_BLOCKED`) — an empty sandbox can never wipe
  a non-empty cloud snapshot without an explicit `force=true`
