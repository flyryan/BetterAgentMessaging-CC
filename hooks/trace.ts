// The trace buffer: one JSON line per intercepted event. The hooks module
// writes the snapshot (the fs noun has no append, so the file is rewritten
// whole, writes chained so an older snapshot never lands last).
const MAX_LINES = 4000

let lines: string[] = []

export function traceLine(ev: string, data: Record<string, unknown> = {}): string {
  lines.push(JSON.stringify({ t: new Date().toISOString(), ev, ...data }))
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES)
  return lines.join('\n') + '\n'
}

export function head(text: unknown, n = 200): string | undefined {
  return typeof text === 'string' ? text.slice(0, n) : undefined
}
