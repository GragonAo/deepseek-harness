/**
 * Pure types of the deliverables domain: the ONE home of the `deliverables` projection-key
 * declaration, the `deliverables/presented` session-event declaration, and their payload types,
 * free of this package's host-side value imports (dsh-tools, zod).
 *
 * @module @deepseek-ai/dsh-tool-present/types
 */

import type { CallId } from '@deepseek-ai/dsh-llm'

/** One file a turn hands to the user. */
export interface PresentedFile {
  /**
   * The path the filesystem backend resolved for this declaration — an absolute path in the
   * execution world (for a session-scoped call, `/sessions/<session id>/report.md`). Consumers
   * translate it into their own file vocabulary; the tool never guesses that vocabulary.
   */
  path: string
  /** The model's one-line statement of what this file is, in the user's language. */
  description?: string | undefined
}

/** Every file one turn delivered, in declaration order. */
export interface PresentedTurn {
  /** Turn whose work delivered these files. */
  turn: number
  /** Delivered files; one entry per path, at its first declaration. */
  files: PresentedFile[]
}

/**
 * Whole-value state of the `deliverables` projection: one entry per turn that presented files,
 * ordered by turn, bounded to the most recent `retainTurns` turns.
 */
export interface DeliverablesState {
  turns: PresentedTurn[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The model declared which files this turn delivers to the user. Log-only: the `present` tool
     * writes it and the `deliverables` projection folds it; no model request derives from it, so a
     * declaration can never change what the model sees next.
     *
     * A turn is attributed from its own `turn/start` boundary at append time, so the payload names
     * the turn directly and a later turn cannot adopt an earlier declaration.
     *
     * @param turn - the turn whose work produced these files.
     * @param callId - the `present` call that declared them.
     * @param files - the delivered files, in declaration order.
     */
    'deliverables/presented': {
      turn: number
      callId: CallId
      files: PresentedFile[]
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * Per-turn delivered files, oldest turn first — the list a client renders under the turn that
     * produced them. Whole-value rule: every `deliverables/presented` folds into a new state, and
     * every other event returns the previous reference.
     */
    deliverables: DeliverablesState
  }
}
