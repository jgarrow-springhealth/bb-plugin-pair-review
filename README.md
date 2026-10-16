# Pair Review for BB

Pair Review brings a local-first GitHub pull-request review workflow into BB. It discovers PRs that need your attention, runs either the original installed [Pair Review app](https://github.com/in-the-loop-labs/pair-review) or a compatible local fork, preserves review evidence, and keeps resolver and publication actions behind separate confirmations.

## What you can do

- Browse review requests, assignments, authored PRs, team requests, and retained review runs from the **Pair Review** sidebar page.
- Inspect a PR's committed patch before analysis, then review Pair Review findings, human review feedback, activity, and retained results in **Details**.
- Start a review for one PR, a selected batch, or a local branch. Choose any native Pair Review analysis provider—including Claude Code, Codex, Copilot, OpenCode, Cursor, Pi, OMP, Antigravity, or Muse—and keep Pair Review's normal HOME, history, and shared SQLite database.
- Start a resolver loop only with an explicit confirmation. It evaluates each finding or human comment, edits an isolated checkout, reruns the full review, and stops early when clean or at the configured 1–5 round limit.
- Open the verified run in the native Pair Review app. Compatible running apps are reused; supported retained legacy runs can open in an isolated viewer.
- Optionally show PR briefings and recent review links when the separate **PR Briefings** and **Projects & Sections** plugins are installed.

Opening **Details** never starts analysis or resolution. Reviews remain local. Publication is off by default and is possible only after a resolver loop converges, the user gives a separate human-validation attestation, ownership and refs are rechecked, and the exact-SHA lease succeeds.

## Prerequisites

- BB `>=0.45` with Plugin SDK `>=0.6.15`, and an enrolled BB server machine.
- Node.js 24 or newer, Git, and GitHub CLI (`gh`) available on that machine's `PATH`.
- `gh` authenticated for the configured hostname with access to the PRs you review. Verify with:

  ```sh
  gh auth status --hostname github.com
  ```

- [`@in-the-loop-labs/pair-review`](https://github.com/in-the-loop-labs/pair-review), either installed so its `pair-review` command is on the BB server's `PATH`, or available as a local fork directory. Released versions 5.2.3 and 5.3.4 are accepted only at their verified adapter fingerprints. Other builds must expose the compatible machine-readable adapter contract; unknown or incompatible builds fail closed.
- The CLI and authentication required by your selected provider. Native reviews use Pair Review's own provider adapters and configuration. Claude and Codex resolver modes call `claude` or `codex` from the BB server's `PATH`; Pi resolver mode uses Pi's provider configuration.

Pi is not required for reviews or resolution when Claude Code or Codex is selected. Existing CLI subscription logins are used from their native credential stores. For safety, the guarded Claude/Codex resolver does not forward ambient provider API-key environment variables into the agent process; authenticate the CLI itself before starting a resolver loop. Queue browsing and committed-patch inspection use GitHub CLI reads and never invoke a model.

GitHub PR URLs must use HTTPS on the configured hostname. Cross-repository fork heads are not supported.

## Installation

Install the latest compatible 0.1 release from GitHub:

```sh
bb plugin install 'git:https://github.com/jgarrow-springhealth/bb-plugin-pair-review.git@^0.1.0'
```

BB shows the resolved source and asks for confirmation because third-party plugins run with full trust. Prefer a tagged release or explicit ref when one is available. For local development installs:

```sh
bb plugin install .
bb plugin reload pair-review
```

## Open and use Pair Review

1. Open **Pair Review** in the BB sidebar. Discovery runs automatically; **Refresh** repeats the read-only GitHub queries.
2. Filter by request type, repository, or text. Choose **Details** to inspect the patch without starting a review.
3. Choose **Review latest changes**, paste explicit PR URLs, or select several queue items and choose **Review selected**.
4. Open **Details** to inspect findings, source patches, saved feedback, and run activity. **Open Pair Review** opens the verified native run.
5. For a PR you authored, choose **Start resolver loop** and confirm the maximum rounds. Resolution never starts as a side effect of review.
6. If fixes converge, inspect every change and run behavioral validation before choosing the final validation action. With publication disabled, the commit stays in the isolated local checkout; with publication enabled, the guarded final action may push to the existing PR branch.

`bb pair-review status` prints the retained batch snapshot as JSON for read-only diagnostics.

## Configuration

Open **Settings → Installed plugins → Pair Review**, or use the **Pair Review settings** action in BB's sidebar footer. BB renders and persists the native settings form, validates values on save, and offers **Reset all to defaults** below it. The same values can be managed with `bb plugin config pair-review`.

| Setting | Default | Behavior |
| --- | --- | --- |
| Pair Review installation | `pair-review` | Use the original installed command from the BB server's `PATH`, or enter an absolute/`~/` directory for a compatible local fork. |
| GitHub hostname | `github.com` | Lowercase hostname used by PR validation and `gh`. |
| Review provider | `pi` | Native Pair Review analysis provider: Pi, Claude, Codex, Copilot, OpenCode, Cursor Agent, Antigravity, OMP, or Muse. |
| Review model | `openai/gpt-5` | Model identifier understood by the selected review provider; aliases such as `opus` are accepted by Pair Review. |
| Resolver provider | `pi` | Guarded resolver agent: Pi SDK, Claude Code CLI, or Codex CLI. |
| Resolver model | `openai/gpt-5` | Model identifier understood by the selected resolver provider. |
| Review reasoning | `medium` | Native review reasoning: off, minimal, low, medium, high, or xhigh. |
| Resolver reasoning | `medium` | Reasoning for the separately confirmed resolver. |
| Default resolver loop rounds | `3` | Proposed maximum, validated from 1 through 5. |
| Publish after explicit human validation | Off | Off keeps fixes local; on permits only the guarded exact-SHA publication path. |
| Capture human feedback during reviews | On | Captures complete unresolved review threads, summaries, and PR conversation when possible. Manual loops always refresh it. |
| Hide current reviews in the queue | On | Hides PR heads already reviewed while leaving stale heads visible. |
| Review teams | Empty | Up to 20 comma-separated `OWNER/TEAM` values for team-request discovery when Pi settings are absent. |
| Teammate GitHub handles | Empty | Up to 100 comma-separated handles for request classification when Pi settings are absent. |
| Preparation concurrency | `4` | Concurrent checkout preparation, validated from 1 through 16. |

Plugin settings choose the review and resolver providers and models. When present, the legacy `~/.pair-review/pi-settings.json` file still supplies team and teammate discovery metadata; it no longer overrides provider or model choices. No credential or token is a plugin setting.

## Permissions, data, and external services

- **GitHub:** discovery, PR metadata, diffs, and feedback use authenticated `gh` API reads. Normal review execution does not submit reviews, comments, resolve threads, edit PR metadata, or merge. Enabling publication does not bypass the separate final confirmation and ref/ownership checks.
- **Local processes and files:** the trusted host worker runs the configured installed Pair Review command or local fork and uses Git in isolated retained directories. Evidence and checkouts live under `~/.pair-review/pi-batches`; Pair Review keeps its own configuration and database under `~/.pair-review`.
- **Model provider:** native reviews use Pair Review's selected provider adapter. The resolver uses Pi's constrained SDK tools or a Claude/Codex agent rooted in a sanitized temporary source copy; only validated existing-file edits are applied to the retained checkout. Claude runs in restricted mode with only read/edit tools. Codex runs under its `workspace-write` sandbox, which blocks writes outside the copy and direct network access but may allow read-only host paths according to the installed Codex policy. Provider credentials remain in native stores, not BB plugin settings.
- **Optional BB plugins:** PR Briefings and Projects & Sections add integrations when installed; Pair Review works without them.

Repository content, comments, findings, diffs, and tool output are treated as untrusted input. The resolver has no shell, network, repository credentials, or GitHub-write tool.

## Development and verification

```sh
npm ci --ignore-scripts
node scripts/link-host.mjs   # contributor test setup; not an end-user step
npm run typecheck
npm test
npm run test:pair-review-compat  # set PAIR_REVIEW_EXECUTABLE for a specific build
npm run build
```

`link-host.mjs` links a development checkout to a locally installed `@earendil-works/pi-coding-agent` package so tests can resolve the optional Pi resolver SDK. By default it looks under the global npm root; contributors can instead set `PI_HOST_ROOT` to that package directory. This is contributor test setup only: clean GitHub plugin builds and normal Claude/Codex use do not run the script.

The compatibility suite requires an actual Pair Review executable and is separate from offline unit and UI tests. Offline tests do not prove provider authentication, live GitHub access, native app startup, or guarded publication.

## Screenshots

A synthetic retained review rendered through the real production UI shows the
primary outcome: evidence attached to each finding, with severity, location,
commentary, and a concrete suggestion. No model or GitHub write was used for
this capture:

![Pair Review retained findings](docs/screenshots/review-findings.png)

The queue overview shows how reviews start and how pull requests can be filtered
or selected in batches. Live repository, count, and queue data are omitted:

![Pair Review queue overview](docs/screenshots/queue-overview.png)

Public pull-request details show the changed-file selector, committed patch,
resolver boundary, and human-feedback surface without starting an analysis:

![Pair Review pull-request details](docs/screenshots/pr-details.png)

The native BB settings page exposes Pair Review's validated configuration.
Configured installation, team, and teammate values are irreversibly redacted;
credentials remain in their native stores. The capture excludes the unrelated
installed-plugin list.

![Pair Review settings in BB](docs/screenshots/settings.png)

Private development captures are intentionally excluded from this public tree. Only sanitized release screenshots belong under `docs/screenshots/`.

## License

The BB plugin code in this repository is MIT licensed © 2026 Janessa Garrow.
See [LICENSE](LICENSE). The separately installed Pair Review application has
its own license and distribution terms.
