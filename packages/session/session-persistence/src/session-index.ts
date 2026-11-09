/**
 * Cross-tenant conversation-index seam: a subject's conversation figures per
 * tenant, maintained from the stored session logs and served without walking
 * any tenant's session store. A management surface reads it in one query; the
 * backend provider that owns the logs maintains it.
 * @module @deepseek-ai/dsh-session-persistence/src/session-index
 */

/**
 * One subject's conversation figures inside one tenant.
 *
 * The figures follow the session-list rule: a conversation is a session that
 * started a turn of its own — a blank session is not one, and neither is a
 * delegated child. Archive state is not part of them: it belongs to the
 * workspace registry, not the session log.
 */
export interface SessionIndexStats {
  /** The tenant the figures describe, as the tenant was registered. */
  readonly tenant: string
  /** How many conversations the subject has in that tenant. */
  readonly sessionCount: number
  /** Epoch ms of the latest question the subject asked in one of them, or `null` when none recorded one. */
  readonly lastPromptAt: number | null
  /** Epoch ms of the newest counted conversation: its creation, or its last question when that is newer. */
  readonly updatedAt: number
}

/**
 * The conversation index a management surface aggregates over: one read per
 * subject, covering every tenant in the deployment.
 *
 * Implementations derive their rows from the session logs and keep them current
 * as sessions are written, so the figures are a view of the log rather than a
 * second authority. A deployment that mounts no provider serves no index; a
 * consumer reads it through {@link currentSessionIndex} and answers
 * `unavailable` instead of inventing a figure.
 */
export interface SessionIndex {
  /**
   * Read one subject's figures across every tenant, ordered by tenant id.
   * @param user - the authenticated subject whose figures to read.
   * @returns one entry per tenant the subject has conversations in; empty when there are none.
   */
  statsOf(user: string): Promise<readonly SessionIndexStats[]>

  /**
   * Rebuild one tenant's rows from its stored logs, for sessions written before
   * the index existed. Idempotent: rows already advanced are left advanced.
   * @param tenant - the tenant id whose logs to reindex.
   * @returns how many rows the rebuild wrote.
   */
  reindex(tenant: string): Promise<number>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Conversation index; only a backend that maintains one registers it. */
    sessionIndex?: SessionIndex | undefined
  }
}
