/** A hold the controller put on one agent loop with a `hold:` message. */
export type Hold = {
  /** `all`: every tool but SendMessage is refused; `ship`: shipping actions only. */
  scope: 'all' | 'ship'
  reason: string
  /** Who sent it (`team-lead`, or `main` for the session's own subagents). */
  by: string
  at: number
}

/** What a pane teammate's mod writes about itself for the lead to read. */
export type TeammateStatus = {
  name: string
  team: string
  sessionId: string
  turn: 'running' | 'idle' | 'ended'
  tool?: string
  toolSince?: number
  lastActivity: number
  hold?: Hold
  standing: string[]
  unseen: number
  updatedAt: number
}

/**
 * The last message put into this process's running turn, shown in the band:
 * unread until a model request carries it (`readAt`), then briefly as read.
 */
export type Arrival = { from: string; text: string; at: number; readAt?: number }

/** One agent as the lead shows it: ListAgents context, the /relay pane. */
export type AgentRow = {
  key: string
  name: string
  kind: 'subagent' | 'teammate'
  status: string
  tool?: string
  toolSince?: number
  lastActivity?: number
  hold?: Hold
  standing: number
  unseen: number
  stale?: string
}

declare module 'claude-code' {
  interface PluginState {
    'better-agent-messaging': {
      /** Holds by loop: an in-process agent's id, or `main` for this process's own loop. */
      holds: Record<string, Hold>
      /** Standing orders by loop, and `*` for those every new spawn receives. */
      standing: Record<string, string[]>
      /** The lead's view of every agent, refreshed every few seconds. */
      rows: AgentRow[]
      /** Whether this process's main turn is running, kept across a reload of the mod. */
      isTurnRunning: boolean
      /** The last mid-turn arrival, or null once it has been shown long enough. */
      arrival: Arrival | null
    }
  }
}
