# @deepseek-ai/dsh-mcp-servers-postgres

English | [中文](README.zh.md)

The PostgreSQL medium for the external MCP server registry: two shared units in the `dsh_system` schema, one cache per register, and the quota policy a write enforces.

It implements the five primitives [`dsh-mcp-servers`](../mcp-servers/README.md) declares, so every rule about *what* may be stored stays in that package; this one decides *where* it lives and *how much* of it a deployment tolerates.

## Storage

| unit | table | rows |
| --- | --- | --- |
| `mcp_system_servers` | `server` | one row per deployment-wide server |
| `mcp_user_servers` | `server` | one row per user-owned server, keyed by owner |

Both units are **shared**: a unit holds every tenant's and user's rows rather than partitioning per owner. That is the deliberate inversion of the usual tenant isolation rule, and it is what makes a user's personal MCP server follow them across cases — a per-partition table would tie the row to the case in which it was created. The two lists are disjoint by construction: an administrator writes `mcp_system_servers`, a user writes `mcp_user_servers`, and neither method can reach the other table.

`mcp_system_servers` participates in the global revision: a write reports the new revision, and a write carrying a stale `expectedRevision` is refused with `McpServerRevisionConflict` instead of overwriting another administrator's change. The user register has one writer per row, so it is last-write-wins and carries no revision.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-mcp-servers-postgres'
  config:
    maxSystemServers: 32     # quota on the deployment-wide list
    maxUserServers: 8        # quota per user
    allowPrivateHosts: true  # whether a row may point at loopback/private ranges (both registers)
```

`allowPrivateHosts` applies to both registers and to the connectivity test, so an endpoint a surface can test is an endpoint the same deployment will store. Set it to false for a public-only deployment.

## Startup

`[Service.init]` loads the system register **and** pre-loads every user register in one pass, so the first session of any user does not pay a read on its first mount. `refreshUsers()` re-reads the whole user table; after that, reads come from the cache and writes keep it current.

## Model Experience

Indirectly, through dsh-mcp-external, which mounts the rows this medium persists.

#### KV Cache effect

No direct cost. A write changes which servers every running session mounts at its next step, and that prefix effect is described by `dsh-mcp-external`.

## Known Limitations and Deferred Work

- **Tenants share two tables.** It is the point of the feature, but it means a database-level read of `mcp_user_servers` sees every user's endpoints and header names. Treat the schema's read access as equivalent to a secret store's.
- **Header values are plaintext columns.** They must be replayed to the endpoint, so they cannot be hashed.
- **A user's rows are not cleaned up on user deletion.** Nothing walks the table when an account disappears; a deployment that needs that must add it.
- **`refreshUsers()` is whole-table.** Fine for hundreds of users; a deployment with tens of thousands should switch it to a per-owner read on first use.
- **No cross-instance notification.** Two host processes sharing one database see each other's writes only at their next load, not immediately.
