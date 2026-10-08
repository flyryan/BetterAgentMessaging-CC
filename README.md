<p align="center">
  <img src="docs/images/hero.png" width="100%" alt="BetterAgentMessaging for Claude Code subagents and agent teams: your message reaches a working teammate at its next step, not after it finishes. A train graph shows three agents climbing through their steps while team-lead's messages land on them mid-task, one agent paused by a hold.">
</p>

# BetterAgentMessaging-CC

A Claude Code mod for subagents and agent teams. When you `SendMessage` a teammate that is busy working, it reads your message at its next step instead of after it has finished. Teammates' messages reach you the same way. You also get directives the harness enforces (`hold:`, `hold ship:`, `release`, `standing:`) and a live view of what every agent is doing.

You keep using `SendMessage`. There are no new tools to learn, no inbox files to manage, and no watchers to keep alive.

## Install

```sh
claude plugin install better-agent-messaging --marketplace flyryan/BetterAgentMessaging-CC
```

Run it in your shell, then restart any open Claude Code sessions. It adds this repository as a plugin marketplace and installs the mod at **user scope**, the default. User scope is the one that matters: the mod has to load in every Claude Code process, which means your session and each teammate's pane. Inside Claude Code, the same install is `/plugin install better-agent-messaging --marketplace flyryan/BetterAgentMessaging-CC`.

**Requirements:** Claude Code 2.1.294 or later, which is where mods (function hooks) are available. It works with plain background subagents and with [agent teams](https://code.claude.com/docs/en/agent-teams); teammates in their own tmux panes gain the most.

<details>
<summary>Check, update or remove it</summary>

```sh
claude plugin list                            # listed and enabled?
claude plugin update better-agent-messaging   # then restart open sessions
claude plugin uninstall better-agent-messaging
```

In a session, `/agent-status` exists only while the mod is loaded.
</details>

> An independent open-source project. Not affiliated with or endorsed by Anthropic. The mods API is early access, so a later Claude Code release may change it.

## The problem

Run an agent team with teammates in their own tmux panes, and send a busy teammate "stop after step 4", and the message waits in its mailbox until its turn is over. It arrives after step 10. Reports travel the same way: a teammate's update to the lead waits until the lead's own turn ends.

Here is that exact run, before and after the mod: the same teammate, the same task and the same message.

<p align="center">
  <img src="docs/images/before-after.png" width="100%" alt="Chart of steps reached over time. Without the mod the teammate runs all 10 steps and reads the message 184 seconds after it was sent. With the mod it reads the message 7 seconds after the send, between steps 2 and 3, and stops at step 4.">
</p>

Without the mod, the teammate read the message 184 seconds after it was sent, once all ten steps were done. With the mod, it read it 7 seconds in, at its next step, and stopped at step 4. [Read about the runs](docs/experiment.md).

## Use it

Send messages exactly as before. A teammate that is working gets your message at its next step, framed so it knows it came from you mid-task and that it outranks its original brief. Your teammates' reports land in your turn while you are still working. You see it arrive too: a line directly above the pane's prompt shows who sent it, whether the agent has read it yet, and its first line, such as `team-lead sent (unread): stop after step 4`. It says `(read)` once the agent's next model request carries the message, then clears 15 seconds later. The transcript keeps the whole message under the sender's name in its team color, the way Claude Code shows a teammate's message.

### Directives

Start a message's first line with one of these, and the agent's own process enforces it:

| First line | What happens |
|---|---|
| `hold: <reason>` | The harness refuses every tool the agent calls (SendMessage still works) until you send `release`. A hold also covers any helper agents it starts. |
| `hold ship: <reason>` | Only shipping is refused: `git push`, PR merges, releases, `npm publish`, deploys, `rm -rf`. Other work carries on. |
| `release` or `release: <note>` | Lifts the hold. |
| `standing: <rule>` | A rule that stays in force. It is restated to the agent after its context is compacted. |
| `standing clear` | Drops the standing orders. |

```text
SendMessage  to: "review"   message: "hold ship: QA hasn't signed off yet"
SendMessage  to: "all"      message: "standing: run the test suite before every commit"
```

Send to `all` to reach every running or idle agent and teammate at once. (`SendMessage` refuses `*` before any mod can see it.) A standing order sent to `all` is also written into the brief of every agent you spawn afterwards.

The lead learns these directives without being told. The mod adds a short section to its system prompt, or, where Claude Code keeps installed plugins out of the system prompt (machines with managed settings, Team and Enterprise plans), a note in its conversation that it reads from its second request on. Every agent you spawn learns how to read them from a paragraph added to its brief.

### See what your agents are doing

<p align="center">
  <img src="docs/images/team-window.png" width="100%" alt="A tmux window with three Claude Code panes. Left, the lead, which has just sent two messages mid-task; above its prompt one dim line reads: review can't ship: QA hasn't signed off. Top right, teammate impl, on step 4 of 8; above its prompt: team-lead sent: also write DONE to impl.log after your last step. Bottom right, teammate review, on check 4; above its prompt: team-lead sent: hold ship: QA hasn't signed off, and below it, team-lead blocked shipping: QA hasn't signed off.">
</p>

- **Above the prompt**, a dim line appears only when there is something Claude Code's own agent list doesn't show, always led by the agent's name: `review can't ship: QA hasn't signed off`, `docs is paused: waiting for review`, `impl looks stuck: in Bash for 47m`. A held teammate's own pane shows its hold the same way (`team-lead blocked shipping: …`), and any pane shows a message that arrived mid-turn until it has been read (`impl sent (unread): tests pass, opening the PR`).
- **ListAgents** results gain a live-state table. When the lead lists its agents, it sees what each one is doing.
- **`/agent-status`** opens the same table in a pane.
- **Stale agents** are reported to the lead on their own. An agent counts as stale after 20 minutes with no step and no tool running, or after 45 minutes inside a single tool call. Both times are configurable.

<p align="center">
  <img src="docs/images/ship-hold.png" width="602" alt="Teammate review's pane. It runs git push origin main once, and the harness refuses it: Error: On a ship hold by team-lead: QA hasn't signed off. Pushing, merging, releasing, publishing, deploying and rm -rf are refused until team-lead sends release. Other work may continue. review reports the refusal and does not retry. Above its prompt: team-lead blocked shipping: QA hasn't signed off.">
</p>

Under `hold ship:`, `review` first holds back on its own. Asked to try the push once anyway, it is refused by the harness, not by its own judgement, and the remote does not move.

### Smaller fixes that come with it

- **Wrong addresses.** In a pane teammate's process, `"main"` names the teammate itself, so a teammate that reports to `"main"` or `"lead"` used to fail. The mod sends it to `team-lead`.
- **Whole final answers.** A teammate whose turn ended without messaging you used to reach you only as a short idle notice. Now its whole final answer is forwarded.
- **Late arrivals.** A message that lands just as an agent finishes its last step starts a short follow-up turn, so it is never left unread.

## What it does not do

- **It cannot interrupt a running command.** A message lands at the agent's next step, and a hold refuses the next tool call. A 10-minute build already running finishes first.
- **It leaves subagent delivery to the engine.** On 2.1.294 the engine already gives a background subagent a message at its next tool round, so the mod doesn't touch that path. Holds, standing orders and the live view still apply to subagents.
- **Directives come only from `team-lead`.** A pane teammate takes directives from `team-lead` alone. The team mailbox is a file any process of the same user can write, so this prevents mistakes, not attacks.
- **`hold ship:` reads command text.** It matches Bash commands against a pattern. Treat it as a safety net, not a sandbox, and set `shipPattern` for anything else it should catch.

## Configuration

These appear under the mod's name in `/config`:

| Setting | Default | |
|---|---|---|
| `staleMinutes` | `20` | No step and no tool for this long counts as stale. |
| `toolStaleMinutes` | `45` | One tool call running this long counts as stale. |
| `shipPattern` | empty | A regular expression for more Bash commands `hold ship:` refuses. The built-in list always applies. |
| `trace` | `false` | Writes every decision the mod makes to `~/.claude/better-agent-messaging/trace/`. |

## How it works

Every process of the team loads the mod. Each one fixes delivery for its own conversation and enforces the directives aimed at the agents it runs. Teammates write a small status file that the lead reads for its live view. [How it works](docs/how-it-works.md) walks through the delivery path, the hold gate, the status files and the Claude Code events the mod hooks.

## Development

```sh
git clone https://github.com/flyryan/BetterAgentMessaging-CC
cd BetterAgentMessaging-CC
claude --plugin-dir .            # run a session with your working copy
claude plugin validate .         # what the engine will load, and what it would refuse
claude plugin test .             # the test suite
tsc -p .                         # type-check, once a session has loaded the mod
```

## License

[MIT](LICENSE) © Ryan Duff
