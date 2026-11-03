# Agent Note: Configurable writable scopes and DELETE on the tenant file face

Status: implemented

English | [中文](2026-08-13-tenant-file-face-writable-scopes.zh.md)

## Problem

The tenant file face (`packages/tenant/fs-http`, mounted at `/files`) let a caller read every scope but write only two of them: `session` and `user`. That matches its original consumer — a case's working files, which belong to one session or one person inside one tenant.

A business surface that owns a **cross-case** asset per subject breaks that assumption. Report templates are the case that forced this: the same template set has to be usable from every case, so it lives in the subject's user-global directory (sandbox `/global`, host `<usersRoot>/<subject>/work`), and the authenticated business side has to maintain it — upload, replace, rename, delete — from the product UI. Before this change the file face answered `403 file-readonly` for any write there, and offered no deletion at all, for any scope.

The face could not simply be widened for everyone: `case`, `global`, and `system` are written by other owners (the business face, the admin face, and operations respectively), and a deployment that never needed the exception should not silently acquire the ability to overwrite them.

## Decision

```yaml
tenant-fs-http:
  writableScopes: [session, user]   # default; a deployment may add global (or any other scope)
```

`writableScopes` is a validated `Config` field, defaulting to `[session, user]`. Every scope root carries a `writable` flag decided by that set (`DEFAULT_WRITABLE_SCOPES` in `roots.ts` is the default, not the answer), so naming a scope makes its `PUT`/`DELETE` behave exactly like `user`. Unknown scope names fail the plugin load rather than being ignored; `writableScopes: []` is a valid read-only deployment.

The face also gained `DELETE /files/<scope>/<path>`:

- **Authority follows the writable set.** Writing a directory and removing from it are the same authority; splitting them would let a caller delete a file it cannot replace.
- **Files only.** A directory answers `409 file-is-directory`. Deleting a tree (and deciding whether its contents should die with it) is a business decision; the byte channel does not make it.
- **A missing file is a `404`.** The surface reports what it found rather than claiming a removal; a caller that wants an idempotent delete maps `404` to "already gone" (the jeecg bridge does).
- **Scope-only addresses are refused** (`400`), like `PUT`.

The existing write semantics are unchanged: temp file + rename, ETag as `"<size>-<mtimeNs>"`, `If-Match`/`If-None-Match`.

Write authority on this face is business-side only. Sandbox mount policy is a different setting (`caseReadOnly` / `usersReadOnly`, owned by the container providers): opening `global` here does **not** give the model inside the sandbox write access to `/global`.

## Alternatives considered

**A business method per asset class** (`file.template.upload`, `skill.install`, `…`). This is the shape the file face exists to replace. Each method re-implements the same list / read / conditional write / ETag / size-limit code, and each copy drifts: a deployment that fixes a bug in one does not get it in the others, and a new asset class pays the whole cost again. Templates are bytes in a directory; they do not need a vocabulary of their own.

**Always-writable `global`.** Simpler, and wrong: the default posture of a multi-tenant deployment is least privilege. A deployment that does not hand that directory to the business side should not be one configuration mistake away from overwriting it.

**A second storage face for cross-case assets.** A parallel mount, plugin, or route for "shared files" would duplicate the scope-root resolution, the ETag convention, and the size limits — and the two would eventually disagree about what a filename may contain.

**Recursive delete, or `DELETE` on a directory.** Refused rather than deferred: once the channel can delete a tree, every accidental `DELETE /files/user` is unrecoverable data loss, and the caller that genuinely wants it can enumerate and remove entries itself.

**`Range` support in the same change.** Out of scope; large reads still stream whole. Adding conditional delete or partial writes would have multiplied the test surface for no consumer.

## Consequences

A deployment that wants report templates (or any other user-global asset) under business-side control must now set the same scope in **two places**: `writableScopes` here and the business side's own mirror of it (`dsh.files.writable-scopes` in the jeecg bridge). Both defaults exclude `global`, so a half-configured deployment fails loudly at the first write — locally with an actionable message, or from the host as `403 file-readonly` — instead of appearing to work.

The face is now one grant away from a destructive operation. That risk is bounded by the two rules above (files only, writable scopes only) and by the fact that the authority matches `PUT`: a caller that can delete a file could already overwrite it with zero bytes.

A successful delete reports the address that is gone, not a version, and a missing file answers `404`: a client that cached an ETag must re-list rather than read `404` as "never existed".

## Testing

`packages/tenant/fs-http/tests/fs-http.spec.ts` boots the plugin twice: once with the default config (writes and deletes outside `session`/`user` answer `403`, and the `Allow` header advertises `GET, HEAD, PUT, DELETE`), and once with `writableScopes: ['user', 'global']`, where a template can be written to, listed in, and deleted from `global/报告模板/`, while `case` and `system` stay read-only. Further cases cover a bare-scope `DELETE` (`400`), a missing file (`404`), a directory (`409`), and a config naming an unknown scope (load rejected with the available names). `packages/tenant/fs-http/tests/roots.spec.ts` pins the flag itself: a scope is writable only when the deployment names it.
