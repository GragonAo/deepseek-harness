# Agent Note: Session forget removes registry accounting and the archive slot

Status: implemented

English | [中文](2026-10-19-session-forget-removes-registry-accounting.zh.md)

## Problem

Hard-deleting a session removes its log, its live agent, and its telemetry. Nothing tells the workspace registry, which keeps two durable traces of it: a workspace record's `sessionIds` slot, and the registry-global `archivedSessionIds` set. Both outlive the session. A stale slot makes a workspace's session count and candidate order wrong, and a stale archive membership keeps the id inside the `host/archived-sessions-changed` snapshot that the tenant carrier filters client frames by, so the frames keep naming a session that no longer exists. Archiving deliberately preserves the slot because a later unarchive restores the session's position; a deleted session has no position to restore, so that guarantee must not hold for it.

## Decision

**`ctx.workspaceRegistry.forgetSession(sessionId)` removes one session from the ambient request partition's registry state completely: every workspace record that accounts it loses the id from `sessionIds`, and the id leaves `archivedSessionIds`.**

- Commit order: the account writes commit first and the archive write is last, because the archive snapshot is the value subscribers derive their frames from. A failure in the account phase rejects with no archive write, so no frame ever claims an archive removal that workspace accounting still contradicts. Each write is durable on its own; the operation has no pending-mutation marker (see Alternatives considered).
- Idempotence and rejection: an id accounted nowhere and unarchived writes nothing at all, and an id this partition has never seen is a success. `archiveSession` rejects such an id (`WorkspaceUnknownSessionError`) because the archive set is a display fact about a session the user can see; forgetting follows a delete, so an absent session is the expected state and a retry after a partial delete must not fail on it.
- Scope of the writes: only records that actually account the id are written, decided from the durable record rather than the filtered `sessionIds` projection — a candidate the projection hides is still accounted and is dropped here, while an unrelated workspace is never rewritten (and so never emits a change frame for this operation).
- Workspace registration is untouched: the directory stays registered, and a workspace whose last session is forgotten remains an empty group rather than disappearing.

## Alternatives considered

**The hard-delete path detaches from each workspace and drops the archive entry itself.** Rejected: that path lives outside this package, would have to enumerate workspaces before writing, and could not keep the archive write last without duplicating this ordering rule in a second owner.

**Removing the workspace record instead of the account slot.** Rejected: the registration is the directory, not the session. Deleting one session must not unregister the folder or its other sessions.

**Writing the archive set first, then the accounts.** Rejected: the first write publishes an archive snapshot without the id while workspaces still account it, and a failure between the two writes brings a deleted session back into every grouping surface.

**A durable pending-mutation marker, like create and delete use.** Rejected: `pendingMutation` exists because one workspace is split across the order singleton and the `workspaces` table, where an interrupted pair leaves order and table diverging in a way startup cannot explain. The writes here are two independent facts — an account slot and an archive membership — so an interruption leaves a legible state (archived, unaccounted) that a repeated `forgetSession` settles, and it adds no order/table divergence to recover.

**Reusing `Workspace.detachSession` as the public forgetting surface.** Rejected: it is per workspace, so the caller would need the same enumeration the registry already has, and it cannot express the archive half. `forgetSession` uses it internally, which keeps one workspace-record write path.

## Consequences

The archive slot guarantee of the [session archive decision](../feature/2026-07-31-session-archive-global-set.md) holds only until a hard delete forgets the session; unarchiving still restores a position for every session that exists. Nothing here deletes a session, a log, or a directory: `forgetSession` edits registry state only, and the caller owns everything else, so calling it for a live session would simply ungroup that session. A failure between the account writes and the archive write leaves the id archived but unaccounted, which a retry completes — the reverse order's failure mode (an unarchived id still accounted, visible again) is what the chosen order avoids.

## Testing

`packages/workspace/workspace/tests/workspace.spec.ts` pins the removal from both places with the emitted change order (`workspaces` put before the global put), the account-only and archive-only halves, write-free idempotence for both a forgotten and an unknown id, and an injected account-write failure that publishes nothing and completes on retry. The hard-delete path that calls this method, its RPC surface, and the tenant carrier's frame filter are pinned by their own packages' suites.
