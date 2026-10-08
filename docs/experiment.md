# The experiment

These runs, from 8 October 2026 on Claude Code 2.1.294, are the evidence behind the README's chart. Every time below comes from the session transcripts Claude Code writes, not from a summary: send times from the lead's transcript (the moment its SendMessage ran), arrival and step times from each teammate's. The agents' own step logs agree to the second.

## Setup

- A lead session, with teammates in their own tmux panes (`teammateMode: "tmux"`).
- Each test agent runs a fixed task: 10 steps, each step one Bash call, `sleep 15; echo "step N $(date +%T)" >> <log>`. Steps run one at a time, never batched.
- The lead sends one SendMessage while step 2 is running: **"Stop after step 4 (do not run steps 5-10) and include the word KIWI in your final report."**
- An agent that obeys stops at step 4. An agent that never sees the message mid-run runs all 10.

## Runs

### 1. In-process background subagent, no mod

Before writing any delivery code, we checked what the engine already does for subagents that run inside the lead's process. Two subagents ran the same task and received the message in different ways: one by plain SendMessage, one through a hook that appended the message directly.

| Agent | Message seen | Stopped at |
|---|---|---|
| Plain SendMessage | right after step 1 | step 4 |
| Appended by a hook | right after step 1 | step 4 |

**Result:** the engine already delivers to in-process subagents at their next tool round. The mod leaves that path alone.

### 2. tmux pane teammate, no mod

| Step | Time |
|---|---|
| 1 | 13:16:54 |
| 2 | 13:17:11 |
| 3 | 13:17:28 |
| 4 | 13:17:46 |
| 5 | 13:18:15 |
| 6 | 13:18:33 |
| 7 | 13:18:57 |
| 8 | 13:19:29 |
| 9 | 13:19:46 |
| 10 | 13:20:02 |

- The lead sent the message at **13:17:08**, during step 2. It waited in the teammate's mailbox.
- It entered the teammate's conversation at **13:20:12**, after its turn ended: **184 s** after the send.
- It then replied: "Your stop-after-step-4 instruction reached me only after all 10 steps were already done."

The same thing happened in reverse: the teammate's final report to the lead also waited until the lead's turn ended.

### 3. tmux pane teammate, with the mod

| Step | Time |
|---|---|
| 1 | 13:34:30 |
| 2 | 13:34:48 |
| 3 | 13:35:08 |
| 4 | 13:35:26 |

- The lead sent the message at **13:34:42.0**, during step 2.
- The mod put it into the teammate's running turn at **13:34:42.1**, 0.08 s later.
- The teammate's model first saw it when step 2's result came back at **13:34:48.9**: **7 s** after the send. In its words, it saw the message "just after step 2 completed and before step 3 started".
- It stopped after step 4 and reported "KIWI". The report reached the lead in the middle of the lead's own turn.

### 4. Hold and release

- A second teammate got `hold: testing the hold gate` during step 2.
- It stopped after step 2 and told the lead it was holding.
- After `release: continue, but stop after step 4`, it ran steps 3 (13:35:56) and 4 (13:36:21), then stopped.

### 5. Ship hold

- A teammate got `hold ship: release-freeze test` and was then told to run `git push origin main` against a local scratch remote.
- The harness refused the call: *"On a ship hold by team-lead: release-freeze test. Pushing, merging, releasing, publishing, deploying and rm -rf are refused until team-lead sends "release". Other work may continue."*
- The remote's head did not move.

An earlier attempt at this test exposed a bug, since fixed: a hold that arrived before the teammate's startup hook had finished was ignored. That run is why every hook now waits for the role to be known.

### 6. Wrong addresses

A teammate sent to `main`, `lead` and `bogus-recipient`. On 2.1.294, the engine refused all three with an explicit error. It does not drop them silently.

- **`main`** in a pane teammate's process means the teammate itself. The mod now sends it, and names like `lead` and `controller`, to `team-lead`.
- **`bogus-recipient`** still fails, with the engine's own error.

## Reproducing

Run a lead in tmux with `claude --plugin-dir <this repo>`, spawn a named teammate with the task above, and send the message during step 2. To repeat the without-mod run, start the session without `--plugin-dir`. To record the mod's decisions, set `trace` to `true` in `/config`, then read `~/.claude/better-agent-messaging/trace/`.

## The pictures

All four images in the README come from files in [`docs/figures`](figures), and each can be rebuilt from the repo root.

**The chart and the masthead** are HTML pages that `build.py` writes; a browser renders them. The chart's points are the transcript times above.

```sh
python3 docs/figures/build.py
export CHROME_DEVTOOLS_AXI_SESSION=figs
chrome-devtools-axi open "file://$PWD/docs/figures/proof.html"
chrome-devtools-axi emulate --viewport 1200x640x2
chrome-devtools-axi eval "() => document.fonts.ready.then(() => document.fonts.status)"
chrome-devtools-axi screenshot docs/images/before-after.png
```

`hero.html` renders the same way to `hero.png`, at 1600x540.

**The two terminal screenshots** are real tmux frames from a separate demo run on 8 October 2026 (Claude Code 2.1.295, Sonnet 5.5, the mod at 0.2.0). A lead and two pane teammates, `impl` and `review`, ran in a throwaway repo whose `origin` was a local bare repository. A capture loop saved every pane with `tmux capture-pane -e` once a second. [`ansi2html.py`](figures/ansi2html.py) draws a saved frame as HTML: each pane at its own position, with its colours. The two frames used are in [`docs/figures/frames`](figures/frames).

```sh
python3 docs/figures/ansi2html.py docs/figures/frames/0095 docs/figures/team-window.html --crop-trailing --margin 0
python3 docs/figures/ansi2html.py docs/figures/frames/0172 docs/figures/ship-hold.html --pane 2 --crop-trailing --margin 0
```

Then screenshot each page as above: `team-window.html` at `1031x882x2`, `ship-hold.html` at `664x566x2`. `--margin 0` draws the bare window, with no page around it.

What was arranged for the recording:

- The demo processes loaded a copy of the mod, with no personal settings or instructions (`--setting-sources project,local`).
- The window was 128 columns wide. Before the first message, the lead's pane was set to 46 columns and each teammate's to 81, so every line above a prompt would fit. Nothing was resized after that.
- The lead was told to send the two messages word for word, about five seconds apart, so all four lines above the prompts would be on screen together, both messages still unread (frame 0095, 16:39:24).
- Under the hold, `review` skipped the push on its own. The lead then asked it to run the push once so the hold could decide. The harness refused it (frame 0172, 16:40:47), and the remote did not move.
- In frame 0095 the top two rows of `review`'s pane held the end of Claude Code's welcome banner, which names the account's plan and a local path. Those two rows are cleared in the saved frame; nothing else in either frame was changed.

