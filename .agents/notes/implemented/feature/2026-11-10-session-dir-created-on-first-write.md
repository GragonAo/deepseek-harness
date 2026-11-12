# Agent Note: The tenant file face creates a session directory on first write

Status: implemented

English | [中文](2026-11-10-session-dir-created-on-first-write.zh.md)

## Problem

A session's working directory was created by the sandbox's first command (`mkdir -p /sessions/<sessionId>`) and by nothing else. That is the right owner while the only writer is the model inside the session: nothing writes into a session before the session exists.

Conversation attachments break that. The user picks files in the chat input before the turn is sent, and the product wants those bytes inside the session's working directory, because that directory *is* the model's working directory: the model reads them next to what the turn produces, the artifact listing shows them, and the business-side file browser lists them with the same address. But the session does not exist yet — the product writes `session/<sessionId>/uploads/<name>` when the turn is sent, and the host has no such directory. The face answered `404 file-session-unknown`, which left two bad options: have the business side create the directory out of band (making the business side the owner of the host's session layout), or upload into `user` (a directory that is not the model's working directory, so the model would need an absolute path for the one class of file it was handed).

## Decision

```yaml
tenant-fs-http:
  createSessionDirs: false
```

`createSessionDirs` is a validated `Config` field, defaulting to `false`. With it on, a `PUT` whose target session directory is missing creates `<usersRoot>/<subject>/sessions/<sessionId>` before writing. Nothing else about the address rules changes: the session id must still be a shape that can name a session directory (`sandboxSessionDirOf` accepts `^[A-Za-z0-9][A-Za-z0-9._-]*$`, everything else stays `400 file-path-invalid`, now checked before the directory is created rather than after), and with the field off the answer remains `404 file-session-unknown`.

The default is off because creating directories is not what the byte channel promised: a deployment whose callers only write into sessions that already exist should not be able to leave directories behind through a typo in a path. The multi-tenant app turns it on in its own composition (`packages/tenant/tenant-app/src/compose.ts`), where "an attachment picked in the chat input lands in the session's working directory" is part of the product, not a deployment choice.

The sandbox's own `mkdir -p` is idempotent, so the two writers do not fight: whichever runs first creates the directory, the other finds it.

## Alternatives considered

**The business side creates the session before uploading.** The session is created by the first turn's prompt, and the attachment has to be written before that prompt is submitted — creating the session earlier would either send an empty first turn or split session creation from the first message. It would also put the host's session layout under business-side ownership, which is exactly the coupling the file face exists to remove.

**Upload into `user` and hand the model an absolute path.** The model's working directory is the session directory; attachments under `user` would be addressed `/workspace/…` while everything else in the same turn is relative to the working directory — two conventions inside one conversation, and the artifact listing (`session/<id>/…`) would not show the files the user just attached.

**Create missing directories for every scope.** A typo in a `global` or `case` path would silently build a tree nobody asked for, and those roots belong to other owners. Only the session scope has the "the caller knows this directory is legitimate, the creator has not run yet" property.

**A separate mkdir operation.** A second call the caller has to sequence ahead of the write, for a directory the write already knows it needs, with the same authority to check twice. It buys only the ability to create a directory one wants to leave empty — which a zero-byte file already does more honestly.

## Consequences

The face is now a directory creator for the session scope. What bounds it: the writable-scope gate still decides who may write at all, only the `session` scope participates, and the session component of the address must be a valid session-id shape.

A session that never comes into existence leaves its `uploads/` directory on the host. No listing shows it, it does not sit inside any existing session, and it holds only the attachments that were never sent. Cleanup belongs to the session directory retention policy; the byte channel does not gain a pre-create or reclaim operation for it.

A caller that used to rely on `404 file-session-unknown` to detect "this session does not exist yet" loses that signal where the field is on: the write now succeeds and creates the directory. The two callers in this repository use the response to report a failed upload, not to probe session existence, and the deployment that needs the old answer keeps the default.

## Testing

`packages/tenant/fs-http/tests/fs-http.spec.ts` boots the plugin three ways: with the default config, where a `PUT` into a fresh session answers `404 file-session-unknown` and leaves no directory on the host; with `createSessionDirs: true`, where the first `PUT` to `session/session-2/uploads/供述材料.pdf` answers `200` and the bytes land in the host's session directory; and with `createSessionDirs: true` plus a session id that could never name a directory (`会话一`), which answers `400 file-path-invalid` rather than creating anything.
