# `@deepseek-ai/dsh-session-uploads`

English | [中文](README.zh.md)

A business frontend uploads a document into the session directory and then sends a prompt that names no file, so the model has no way to learn what arrived. This plugin reads the deployment's uploads directory on every prompt assembly and contributes its contents as dynamic runtime context, so the model opens the file instead of asking what was uploaded. The contribution is a runtime-context snapshot: what the model saw is reconstructible from the session log, and the next assembly replaces it.

The directory is addressed relative to the session directory the filesystem provider serves — `/sessions/<session id>/uploads` for `fs-container` — so the deployment configures a name, never a host path. Entries that are neither files nor directories are dropped, names print in sorted order, and the listing is bounded.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `directory` | `"uploads"` | Directory inside the session directory that holds uploaded files. Must be relative, and must not contain a `..` segment. |
| `maxEntries` | `40` | Maximum entries listed per assembly; the remainder is summarized as a count. Must be a positive safe integer. |

A relative name that no session directory can host, or a bound that is not a positive integer, fails at plugin load rather than on the first turn.

## Model Experience

### Uploads inventory for a session that received files

#### What the model sees

Runtime context, contributed on every assembly whose session has a non-empty uploads directory. Names print in order, sizes use binary units with one decimal from MB up, a directory prints with a trailing `/` and no size, entries past `maxEntries` collapse into one count, and an empty directory, a missing directory, a path that is not a directory, or an assembly with no session contributes nothing at all.

##### Uploads inventory

```markdown
Files the user attached to this session:
- /sessions/6f0c/uploads/供述材料.pdf — 300 KB
- /sessions/6f0c/uploads/现场照片.jpg — 2.0 MB
Read a file with the read tool when its contents matter; read_image reads an image.
```

#### Token effect

Proportional to the number of entries and bounded by `maxEntries`. The snapshot is re-derived on every assembly, so a session that never received a file pays nothing.

#### KV Cache effect

The inventory rides in the runtime-context snapshot, which the harness appends after the stable system prompt. Uploading a file changes the snapshot only and leaves the cacheable prefix intact.

## Known Limitations and Deferred Work

- **Filename characters that resemble prompt variables** — context text is interpolated for `{{name}}` variables before it reaches the model, so a file whose name holds both `{{` and a later `}}` fails that assembly instead of printing literally. A deployment that accepts such names should sanitize them at upload.
- **No per-file content preview** — the inventory lists names, sizes, and kinds only; the model reads a file body through the filesystem tools, which is where `read_image`'s image-modality gate applies.
- **The upload directory is the only record** — the inventory has no session event of its own, so a file that arrives between two assemblies appears in the next snapshot without an event marking when it arrived.
