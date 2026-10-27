## What you get

- A **Pair Review** page for requested, assigned, and authored GitHub PRs, with optional team and teammate classification.
- Read-only details with the committed diff, statistics, retained findings, activity, and available human feedback.
- Explicit reviews for one PR, a selected batch, or a local branch, with results and exact SHAs retained locally.
- Your choice of Pair Review analysis provider: Claude Code, Codex, Copilot, OpenCode, Cursor Agent, Pi, OMP, Antigravity, or Muse.
- A separately confirmed resolver loop for PRs you authored, powered by Pi, Claude Code, or Codex. It evaluates findings and human comments, proposes guarded edits, reruns Pair Review, and stops when clean or at the configured 1–5 round limit.
- Reviews you start outside BB, in the Pair Review app or from a terminal or Pi session, show up on the page (in progress or finished, with findings) so you can kick one off elsewhere and check on it here.
- A verified link to the native Pair Review run. Optional PR Briefings, Projects & Sections and Stack Control integrations appear only when those plugins are installed. With Stack Control, the summary card gets a **Test stack** figure: the one thing to know first (failed, a service down, expiring, behind the PR, test scenarios verified, or ready to test) with the stack name and time left. It opens the stack, or launches one prefilled with the PR when there is none.

Opening Details never starts analysis or changes code. Review never starts resolution. Publication is off by default; enabling it still requires a converged resolver, explicit human-validation attestation, ownership and unchanged-ref checks, and an exact-SHA lease.

## Typical workflow

Filter the queue and inspect a committed patch before spending provider usage. Start one review or a batch, then return for retained findings and feedback. For a PR you own, optionally start the separately confirmed resolver and inspect every change before publication.

## How it works

The plugin runs Pair Review or a compatible fork on the enrolled server. Reviews use its native provider adapters and shared SQLite database. Unknown builds fail closed through verified legacy fingerprints or a machine-readable adapter contract.

GitHub discovery, metadata, diffs, and feedback use authenticated `gh` reads. Ordinary review does not comment, resolve threads, edit PR metadata, push, or merge. Evidence and isolated checkouts stay under `~/.pair-review/pi-batches`.

The resolver supports Pi's constrained SDK tools or Claude/Codex CLIs rooted in a bounded temporary copy that excludes credential-shaped paths and links. External agents cannot edit the retained checkout directly: the plugin rejects new/deleted files and applies only validated existing-file changes through its guarded editor. Claude receives only restricted read/edit tools. Codex uses its `workspace-write` sandbox; writes and direct network are blocked outside the copy, while read access follows the installed Codex policy. Behavioral validation remains a human responsibility.

## Configuration

Use **Settings → Installed plugins → Pair Review**. Choose the installation, GitHub hostname, review and resolver providers/models, reasoning, resolver rounds, feedback capture, queue visibility, teams, teammates, concurrency, and guarded publication opt-in.

Plugin settings control provider and model selection. A legacy `~/.pair-review/pi-settings.json` may still supply team and teammate metadata, but does not override providers or models. Credentials remain in the selected CLI or Pi credential store and are never plugin settings.

## Requirements

- BB 0.45 or newer with an enrolled server machine
- Node.js 24+, Git, and authenticated GitHub CLI on that machine
- Installed [`@in-the-loop-labs/pair-review`](https://github.com/in-the-loop-labs/pair-review) or compatible local fork
- The selected provider CLI/configuration and a supported model
- For Claude/Codex resolver mode, a native CLI login; ambient API-key variables are deliberately not forwarded to the agent subprocess
- Canonical HTTPS PRs on the configured hostname; cross-repository fork heads are unsupported

Pi is optional when Claude Code or Codex is selected for both review and resolution. The resolver receives no GitHub-write capability, and repository content and feedback are always treated as untrusted input.
