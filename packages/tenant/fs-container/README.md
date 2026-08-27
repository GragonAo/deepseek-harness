# @deepseek-ai/dsh-fs-container

English | [中文](README.zh.md)

Container provider for the [`dsh-fs`](../../fs/fs) capability seam. Paths, contents, listings, writes, and edits operate inside the ambient tenant's container — the same execution world the subprocess provider serves — so file operations never escape the tenant's isolation boundary.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-fs-container'
  config:
    root: '/workspace'   # container path relative requests resolve against
```

The provider injects `containerRuntime` (e.g. [`dsh-container-docker`](../container-docker)); `/workspace` must be the tenant workspace mount that provider publishes. The image must carry GNU coreutils (`stat`, `cat`, `find`, `base64`).

## Model Experience

### Filesystem access inside the tenant container

#### What the model sees

Nothing. The `ctx.fs` provider serves the file tools and shell consumers below the model: no tools, prompts, or session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix.

## Known Limitations and Deferred Work

- **Path identity is lexical, not realpath.** `resolve` normalizes but does not resolve symlinks, so aliases do not share identity; `lstat` still reports the link type.
- **Version tokens are stat identities** (`kind|size|mtime`). A rewrite within the same mtime second may not advance the version.
- **`streamText` is one chunk**: the whole file is captured over `cat` rather than streamed; very large files are not streamed.
- **Binary detection is NUL-based** and `readBytes` round-trips `base64`; close to full size-capped reads, not a streaming raw path.
- **CRLF files are LF-normalized on edit** and not restored afterwards.
- **Write is rename-atomic but not durability-verified**: `cat > tmp && mv` is atomic within the container filesystem; no `fsync` wait.