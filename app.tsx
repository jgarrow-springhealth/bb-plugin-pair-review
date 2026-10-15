import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  definePluginApp,
  useRpc,
  useRealtime,
  useBbNavigate,
  Markdown,
  experimental_Diff as Diff,
  experimental_FileLink as FileLink,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  rpcContract,
  Snapshot,
  Details,
  ReviewRow,
  QueueItem,
  Preferences,
} from "./contract";
import "./app.css";
import { queueFilters, repositoryFor } from "./queue";
import { relativeUpdatedAt } from "./time";
type PageData = Snapshot & { hostId: string; preferences: Preferences };
const label = (s: string) => s.replaceAll("_", " ");
const short = (s: string) => s.slice(0, 10);
const when = (s: string) =>
  Number.isFinite(Date.parse(s))
    ? new Date(s).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Unknown time";
let cached: PageData | null = null;
let inflight: Promise<PageData> | null = null;
const subscribers = new Set<(data: PageData) => void>();
function acceptData(value: PageData) {
  if (cached && Date.parse(cached.updatedAt) > Date.parse(value.updatedAt))
    return;
  cached = value;
  subscribers.forEach((fn) => fn(value));
}
function useData() {
  const client = useRpc<typeof rpcContract>();
  const clientRef = useRef(client);
  clientRef.current = client;
  // Host hook clients can change identity between renders. Keep effect
  // dependencies stable while delegating calls to the current client.
  const rpc = useMemo(
    () =>
      new Proxy(client, {
        get: (_target, key) => {
          const value = Reflect.get(clientRef.current, key);
          return typeof value === "function"
            ? value.bind(clientRef.current)
            : value;
        },
      }),
    [],
  );
  const [data, setData] = useState(cached),
    [error, setError] = useState("");
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    try {
      if (!inflight)
        inflight = rpc
          .call("snapshot")
          .then((x) => {
            acceptData(x);
            return x;
          })
          .finally(() => {
            inflight = null;
          });
      await inflight;
      if (mounted.current) setError("");
    } catch (e) {
      if (mounted.current) setError(String(e));
    }
  }, [rpc]);
  useEffect(() => {
    mounted.current = true;
    subscribers.add(setData);
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      mounted.current = false;
      subscribers.delete(setData);
      clearInterval(timer);
    };
  }, [refresh]);
  useRealtime("changed", () => void refresh());
  return {
    rpc,
    data,
    error,
    refresh,
    report: (e: unknown) => setError(String(e)),
  };
}
function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "danger" | "good" | "running" | "finding";
}) {
  return <span className={`pr-badge pr-badge-${tone}`}>{children}</span>;
}
function completedReview(row: ReviewRow) {
  return (
    !row.running &&
    !row.attention &&
    ["findings", "zero_findings"].includes(row.reviewState)
  );
}
function FindingCount({
  count,
  prominent = false,
}: {
  count: number;
  prominent?: boolean;
}) {
  return (
    <span
      className={`pr-finding-count${prominent ? " pr-finding-count-prominent" : ""}`}
      aria-label={`${count} ${count === 1 ? "finding" : "findings"}`}
    >
      <strong>{count}</strong>
      <span>{count === 1 ? "finding" : "findings"}</span>
    </span>
  );
}
function RunningIndicator() {
  return (
    <span
      className="pr-running-indicator"
      role="status"
      aria-label="Review in progress"
      title="Review in progress"
    >
      <span className="pr-spinner" aria-hidden="true" />
    </span>
  );
}
function ChangeSummary({ changes }: { changes: QueueItem["changes"] }) {
  if (!changes) return null;
  return (
    <div
      className="pr-change-stats"
      aria-label={`${changes.files} changed ${changes.files === 1 ? "file" : "files"}, ${changes.additions} additions, ${changes.deletions} deletions`}
    >
      <span>
        <strong>{changes.files}</strong>{" "}
        {changes.files === 1 ? "file" : "files"} changed
      </span>
      <span className="pr-additions">+{changes.additions}</span>
      <span className="pr-deletions">−{changes.deletions}</span>
    </div>
  );
}
function CodeChanges({
  patches,
  selectedFile,
  onSelectedFile,
  error = null,
}: {
  patches: Details["patches"];
  selectedFile: string;
  onSelectedFile: (value: string) => void;
  error?: string | null;
}) {
  return (
    <section className="pr-card border border-border bg-card">
      <h2>Code changes</h2>
      <p className="text-muted-foreground">
        Select one changed file to inspect its committed patch. Analysis is not
        required to view these changes.
      </p>
      <div className="pr-diff-picker">
        <select
          aria-label="Changed file"
          value={selectedFile}
          disabled={!patches.length}
          onChange={(event) => onSelectedFile(event.target.value)}
        >
          {!patches.length && (
            <option value="">No changed files available</option>
          )}
          {patches.map((file, index) => (
            <option value={String(index)} key={`${file.path}-${index}`}>
              {file.path}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="text-destructive">{error}</p>}
      {selectedFile !== "" && patches[Number(selectedFile)] && (
        <div
          className="pr-diff"
          data-file-path={patches[Number(selectedFile)].path}
        >
          <Diff
            patch={patches[Number(selectedFile)].patch}
            path={patches[Number(selectedFile)].path}
          />
        </div>
      )}
    </section>
  );
}
function BriefingCard({
  briefing,
  busy,
  onOpen,
  onGenerate,
}: {
  briefing: Details["briefing"];
  busy: boolean;
  onOpen: () => void;
  onGenerate: () => void;
}) {
  if (!briefing.available) return null;
  const generating = ["queued", "generating"].includes(briefing.state);
  return (
    <section className="pr-card border border-border bg-card">
      <div className="pr-heading">
        <h2>PR briefing</h2>
        <Badge tone={briefing.state === "failed" ? "danger" : "neutral"}>
          {label(briefing.state)}
        </Badge>
      </div>
      <p className="text-muted-foreground">
        A self-contained visual explanation of behavior changes, affected
        surfaces, important flows, and boundaries. Generated independently by
        the PR Briefings plugin.
      </p>
      <div className="pr-actions">
        <Action
          variant="outline"
          disabled={!briefing.file || !briefing.hostId}
          onClick={onOpen}
        >
          Open briefing
        </Action>
        <Action
          variant="outline"
          disabled={busy || generating}
          onClick={onGenerate}
        >
          {generating
            ? "Generating…"
            : briefing.state === "ready"
              ? "Regenerate"
              : "Generate briefing"}
        </Action>
      </div>
      {briefing.stale && (
        <p className="text-destructive">
          This briefing describes an earlier PR head. Regenerate it for the
          current changes.
        </p>
      )}
      {briefing.error && <p className="text-destructive">{briefing.error}</p>}
    </section>
  );
}
function CardIssue({ reviewFailed = false }: { reviewFailed?: boolean }) {
  return (
    <div className="pr-card-issue" role="note">
      <Icon name="TriangleAlert" className="size-4" />
      <div>
        <strong>
          {reviewFailed ? "Review couldn’t finish" : "Action required"}
        </strong>
        <span>
          {reviewFailed
            ? "Open Details to see the full error and preserved-work information."
            : "Open Details to see the required action and preserved-work information."}
        </span>
      </div>
    </div>
  );
}
function ResolverIssue() {
  return (
    <div className="pr-card-issue" role="note">
      <Icon name="TriangleAlert" className="size-4" />
      <div>
        <strong>Review completed</strong>
        <span>
          A previous resolver run failed. Findings are still available.
        </span>
      </div>
    </div>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      className="pr-empty border border-dashed border-border text-muted-foreground"
      role="status"
    >
      {children}
    </div>
  );
}
function Action({
  icon,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { icon?: string }) {
  return (
    <Button {...props}>
      {icon && <Icon name={icon} className="size-4" />}
      {children}
    </Button>
  );
}
function ResolverLoopDialog({
  open,
  defaultRounds,
  busy,
  onOpenChange,
  onStart,
}: {
  open: boolean;
  defaultRounds: number;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (maxRounds?: number) => Promise<void>;
}) {
  const [override, setOverride] = useState(false);
  const [rounds, setRounds] = useState(defaultRounds);
  useEffect(() => {
    if (open) {
      setOverride(false);
      setRounds(defaultRounds);
    }
  }, [open, defaultRounds]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start resolver loop</DialogTitle>
          <DialogDescription>
            The resolver will assess Pair Review findings and human PR feedback,
            fix only valid in-scope issues, rerun Pair Review, and repeat until
            a clean gate review or the round limit is reached. Nothing is pushed
            without separate human validation.
          </DialogDescription>
        </DialogHeader>
        <div className="pr-resolver-options">
          <label>
            <input
              type="radio"
              name="resolver-round-mode"
              checked={!override}
              onChange={() => setOverride(false)}
            />
            <span>
              <strong>Use default</strong>
              <small className="text-muted-foreground">
                Up to {defaultRounds} round{defaultRounds === 1 ? "" : "s"};
                stops early when clean.
              </small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="resolver-round-mode"
              checked={override}
              onChange={() => setOverride(true)}
            />
            <span>
              <strong>Override for this run</strong>
              <small className="text-muted-foreground">
                Choose a maximum from 1 to 5 rounds.
              </small>
            </span>
          </label>
          {override && (
            <label className="pr-resolver-rounds">
              Maximum rounds
              <Input
                aria-label="Maximum resolver rounds"
                type="number"
                min={1}
                max={5}
                value={rounds}
                onChange={(event) => setRounds(Number(event.target.value))}
              />
            </label>
          )}
        </div>
        <DialogFooter>
          <Action
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Action>
          <Action
            icon="Play"
            disabled={
              busy ||
              (override &&
                (!Number.isInteger(rounds) || rounds < 1 || rounds > 5))
            }
            onClick={() => void onStart(override ? rounds : undefined)}
          >
            {busy ? "Starting…" : "Start resolver loop"}
          </Action>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PairReviewPage({ subPath }: { subPath: string }) {
  const { rpc, data, error, refresh } = useData(),
    navigate = useBbNavigate();
  const match = subPath.match(/^([A-Za-z0-9_-]+)\/(\d+)$/);
  const batchSelection = match
    ? { batchId: match[1], index: Number(match[2]) }
    : null;
  const prMatch = subPath.match(
    /^pr\/([^/]+)\/([^/]+)\/([^/]+)\/([1-9][0-9]*)$/,
  );
  const prUrl = prMatch
    ? `https://${prMatch[1]}/${prMatch[2]}/${prMatch[3]}/pull/${prMatch[4]}`
    : null;
  const detailOpen = !!(batchSelection || prUrl);
  const [resolvedSelection, setResolvedSelection] = useState<{
    batchId: string;
    index: number;
  } | null>(null);
  const [startedSelection, setStartedSelection] = useState<{
    subPath: string;
    batchId: string;
    index: number;
  } | null>(null);
  const [prInfo, setPrInfo] = useState<QueueItem | null>(null);
  const [prPatches, setPrPatches] = useState<Details["patches"]>([]);
  const [prPatchError, setPrPatchError] = useState<string | null>(null);
  const [prFeedback, setPrFeedback] = useState<Details["feedback"] | null>(
    null,
  );
  const [prCanResolve, setPrCanResolve] = useState(false);
  const [prBriefing, setPrBriefing] = useState<Details["briefing"] | null>(
    null,
  );
  const activeStartedSelection =
    startedSelection?.subPath === subPath
      ? { batchId: startedSelection.batchId, index: startedSelection.index }
      : null;
  const selection =
    activeStartedSelection ?? batchSelection ?? resolvedSelection;
  const [details, setDetails] = useState<Details | null>(null),
    [detailsError, setDetailsError] = useState(""),
    [urls, setUrls] = useState(""),
    [actionError, setActionError] = useState(""),
    [queueError, setQueueError] = useState(""),
    [queueLoading, setQueueLoading] = useState(false),
    [local, setLocal] = useState({ path: "", branch: "", base: "" }),
    [busy, setBusy] = useState(""),
    [filter, setFilter] = useState("All"),
    [repoFilter, setRepoFilter] = useState("All"),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState(new Set<string>()),
    [collapsed, setCollapsed] = useState(new Set<string>(["dismissed"])),
    [selectedFile, setSelectedFile] = useState(""),
    [showFeedback, setShowFeedback] = useState(false),
    [resolverDialogOpen, setResolverDialogOpen] = useState(false);
  useEffect(() => {
    let live = true;
    setDetails(null);
    setDetailsError("");
    setSelectedFile("");
    setShowFeedback(false);
    setResolvedSelection(null);
    setPrInfo(null);
    setPrPatches([]);
    setPrPatchError(null);
    setPrFeedback(null);
    setPrCanResolve(false);
    setPrBriefing(null);
    if (!detailOpen) return;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        let target = activeStartedSelection ?? batchSelection;
        let availablePrPatches: Details["patches"] = [];
        if (prUrl && !activeStartedSelection) {
          const result = await rpc.call("prDetails", { url: prUrl });
          if (!live) return;
          setPrInfo(result.pr);
          availablePrPatches = result.patches;
          setPrPatches(availablePrPatches);
          setPrPatchError(result.patchError);
          setPrFeedback(result.feedback);
          setPrCanResolve(result.canResolve);
          setPrBriefing(result.briefing);
          setResolvedSelection(result.review);
          target = result.review;
        }
        const value = target ? await rpc.call("details", target) : null;
        if (live) {
          setDetails(value);
          const availablePatches = value?.patches ?? availablePrPatches;
          setSelectedFile((current) => {
            const index = Number(current);
            return current !== "" &&
              Number.isInteger(index) &&
              availablePatches[index]
              ? current
              : availablePatches.length
                ? "0"
                : "";
          });
          setDetailsError("");
        }
      } catch (e) {
        if (live) setDetailsError(String(e));
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [rpc, subPath, activeStartedSelection?.batchId]);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setActionError("");
    setBusy(key);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy("");
    }
  };
  const hostname = data?.preferences.hostname;
  const teams = data?.preferences.teams,
    teammates = data?.preferences.teammates;
  const refreshQueue = useCallback(async () => {
    setQueueLoading(true);
    setQueueError("");
    try {
      const value = await rpc.call("refresh");
      const current = cached;
      if (
        current &&
        current.preferences.hostname === hostname &&
        current.preferences.teams === teams &&
        current.preferences.teammates === teammates
      )
        acceptData({ ...current, ...value });
    } catch (e) {
      setQueueError(String(e));
    } finally {
      setQueueLoading(false);
    }
  }, [rpc, hostname, teams, teammates]);
  useEffect(() => {
    if (!hostname) return;
    void refreshQueue();
  }, [hostname, refreshQueue]);
  useEffect(() => {
    setRepoFilter("All");
    setSelected(new Set());
  }, [hostname]);
  const open = (row: ReviewRow) =>
    navigate.toPluginPanel("reviews", {
      subPath: `${row.batchId}/${row.index}`,
    });
  const openPR = (q: QueueItem) => {
    const url = new URL(q.url),
      parts = url.pathname.split("/");
    navigate.toPluginPanel("reviews", {
      subPath: `pr/${url.hostname}/${parts[1]}/${parts[2]}/${parts[4]}`,
    });
  };
  const start = async (list: string[], openDetails = true) => {
    const result = await rpc.call("start", { urls: list });
    setUrls("");
    setSelected(new Set());
    if (openDetails) {
      navigate.toPluginPanel("reviews", { subPath: `${result.batchId}/0` });
    } else if (detailOpen && list.length === 1) {
      const next = { batchId: result.batchId, index: 0 };
      setStartedSelection({ subPath, ...next });
      // Do not wait for the next snapshot tick: show the accepted running batch
      // on the current details page immediately, then keep polling it above.
      setDetails(await rpc.call("details", next));
      setDetailsError("");
    }
  };
  const action = async (
    row: ReviewRow,
    kind:
      | "cancel"
      | "retry"
      | "attempt"
      | "validate"
      | "recover"
      | "dismiss"
      | "restore",
  ) => {
    let confirmed = false;
    if (kind === "cancel") {
      confirmed = window.confirm(
        "Cancel this entire batch? Retained checkouts and completed results will be preserved.",
      );
      if (!confirmed) return false;
    }
    if (kind === "dismiss") {
      confirmed = window.confirm(
        "Dismiss this run from the active Pair Review lists? Its retained evidence and native Pair Review history will not be deleted, and you can restore it from Dismissed runs.",
      );
      if (!confirmed) return false;
    }
    if (kind === "validate") {
      confirmed = window.confirm(
        `Confirm you inspected EVERY change and ran focused behavioral validation in a credential-free environment. ${row.publish ? "This will publish to the existing PR branch using an exact SHA lease." : "This will commit the fixes only in the isolated local checkout."}`,
      );
      if (!confirmed) return false;
    }
    await rpc.call("action", {
      batchId: row.batchId,
      index: row.index,
      action: kind,
      confirmed,
    });
    return true;
  };
  const startResolverLoop = async (maxRounds?: number) => {
    const target = details
      ? {
          batchId: details.row.batchId,
          index: details.row.index,
          confirmed: true as const,
          ...(maxRounds ? { maxRounds } : {}),
        }
      : prInfo
        ? {
            url: prInfo.url,
            confirmed: true as const,
            ...(maxRounds ? { maxRounds } : {}),
          }
        : null;
    if (!target) throw Error("No pull request is selected");
    const next = await rpc.call("resolverStart", target);
    setResolverDialogOpen(false);
    navigate.toPluginPanel("reviews", {
      subPath: `${next.batchId}/${next.index}`,
    });
  };
  const allRows = data?.rows ?? [],
    dismissedRows = allRows.filter((r) => r.dismissed),
    rows = allRows.filter((r) => !r.dismissed);
  const running = rows.filter((r) => r.running && !r.superseded),
    attention = rows.filter(
      (r) => !r.running && !r.superseded && !!r.attention,
    ),
    recentRows = rows.filter(
      (r) => !r.running && !attention.includes(r) && !r.submitted,
    );
  const runningKeys = new Set(running.map((r) => r.key));
  const latestRowsByKey = new Map<string, ReviewRow>();
  for (const row of rows)
    if (!row.superseded && !latestRowsByKey.has(row.key))
      latestRowsByKey.set(row.key, row);
  const currentQueueByKey = new Map(
    (data?.queue ?? []).map((item) => [item.key, item]),
  );
  const isOutdated = (row: ReviewRow) => {
    const current = currentQueueByKey.get(row.key);
    return !!current && current.head !== row.head;
  };
  const issueFor = (key: string) => {
    const row = latestRowsByKey.get(key);
    return row?.attention && !row.running ? row : null;
  };
  const completedFor = (key: string) => {
    const row = latestRowsByKey.get(key);
    return row && completedReview(row) ? row : null;
  };
  const queue = (data?.queue ?? []).filter(
    (q) =>
      !(
        data?.preferences.hideReviewed &&
        q.freshness === "current" &&
        !runningKeys.has(q.key)
      ),
  );
  const repositories = [
    ...new Set(queue.map((q) => repositoryFor(q.url))),
  ].sort((a, b) => a.localeCompare(b));
  const repoQueue = queue.filter(
    (q) => repoFilter === "All" || repositoryFor(q.url) === repoFilter,
  );
  const filtered = repoQueue.filter(
    (q) =>
      (filter === "All" || q.tags.includes(filter)) &&
      `${q.subject} ${q.title} ${q.author}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const section = (
    key: string,
    title: string,
    count: number,
    description: string,
    children: ReactNode,
  ) => (
    <section id={`pr-${key}`} className="pr-section">
      <button
        className="pr-section-heading"
        aria-expanded={!collapsed.has(key)}
        onClick={() => toggle(key)}
      >
        <Icon
          name={collapsed.has(key) ? "ChevronRight" : "ChevronDown"}
          className="size-4"
        />
        <div>
          <h2>{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <Badge>{count}</Badge>
      </button>
      {!collapsed.has(key) && children}
    </section>
  );
  const card = (r: ReviewRow) => (
    <article className="pr-review-card border border-border bg-card" key={r.id}>
      <div className="pr-heading">
        <h3 title={r.title}>{r.title}</h3>
        {r.running && !r.superseded ? (
          <RunningIndicator />
        ) : r.dismissed ? (
          <Badge>Dismissed</Badge>
        ) : r.superseded ? (
          <Badge>Historical attempt</Badge>
        ) : r.attention ? (
          <Badge tone="danger">
            {r.reviewState === "needs_attention"
              ? "Review failed"
              : "Needs attention"}
          </Badge>
        ) : completedReview(r) ? (
          <span className="pr-statuses">
            <FindingCount count={r.count} />
            {isOutdated(r) && <Badge tone="finding">Outdated</Badge>}
          </span>
        ) : (
          <Badge>{label(r.reviewState)}</Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {r.subject} · {r.author}
      </p>
      <ChangeSummary changes={r.changes} />
      <p className="pr-meta text-muted-foreground">
        {when(r.updatedAt)} · <code>{short(r.head)}</code> · attempt {r.attempt}
      </p>
      <div className="pr-badges">
        <Badge>{label(r.resolverState)}</Badge>
      </div>
      {!r.dismissed && r.attention && (
        <CardIssue reviewFailed={r.reviewState === "needs_attention"} />
      )}
      {!r.dismissed && r.resolverError && !r.attention && <ResolverIssue />}
      <div className="pr-actions">
        <Action icon="Zap" onClick={() => open(r)}>
          Details
        </Action>
        {r.url && !r.running && !r.dismissed && (
          <Action
            variant="outline"
            icon="Play"
            disabled={!!busy}
            onClick={() => void run(r.id, () => start([r.url!], false))}
          >
            Review latest changes
          </Action>
        )}
        {!r.running &&
          (r.dismissed ? (
            <Action
              variant="outline"
              disabled={!!busy}
              onClick={() =>
                void run(`restore-${r.id}`, () => action(r, "restore"))
              }
            >
              Restore
            </Action>
          ) : (
            <Action
              variant="outline"
              disabled={!!busy}
              onClick={() =>
                void run(`dismiss-${r.id}`, () => action(r, "dismiss"))
              }
            >
              Dismiss run
            </Action>
          ))}
        {r.url && (
          <Action
            variant="outline"
            icon="ExternalLink"
            onClick={() => navigate.openUrl(r.url!)}
          >
            Open PR
          </Action>
        )}
      </div>
    </article>
  );
  return (
    <div className="pr-page bg-background text-foreground">
      <ResolverLoopDialog
        open={resolverDialogOpen}
        defaultRounds={data?.preferences.resolverMaxRounds ?? 3}
        busy={busy === "resolver-loop"}
        onOpenChange={setResolverDialogOpen}
        onStart={(maxRounds) =>
          run("resolver-loop", () => startResolverLoop(maxRounds))
        }
      />
      {!detailOpen && (
        <div className="pr-overview">
          <section className="pr-start border border-border bg-card">
            <div className="pr-heading">
              <h2>Start a Pair Review</h2>
            </div>
            <p className="text-muted-foreground text-sm">
              Paste GitHub pull request URLs. When PR Briefings is enabled, its
              independent report starts concurrently.
            </p>
            <form
              className="pr-start-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run("start", () => start(urls.trim().split(/\s+/)));
              }}
            >
              <Input
                value={urls}
                onChange={(e) => setUrls(e.target.value)}
                placeholder="Paste GitHub pull request URLs"
                aria-label="GitHub pull request URLs"
              />
              <Action
                type="submit"
                icon="Play"
                disabled={!!busy || !urls.trim() || !data?.health.ready}
              >
                Start Pair Review
              </Action>
              <Action
                type="button"
                variant="outline"
                icon="RefreshCw"
                disabled={!!busy || queueLoading}
                onClick={() => void refreshQueue()}
              >
                {queueLoading ? "Refreshing GitHub…" : "Refresh from GitHub"}
              </Action>
            </form>
            <details className="pr-local">
              <summary>
                <Icon name="ChevronRight" className="pr-local-chevron size-4" />
                <div>
                  <strong>Local checkout or branch</strong>
                  <span className="text-muted-foreground">
                    Analyze committed changes without a pull request.
                  </span>
                </div>
              </summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("local", async () => {
                    const input = {
                      urls: [],
                      local: {
                        path: local.path,
                        branch: local.branch,
                        ...(local.base ? { base: local.base } : {}),
                      },
                    };
                    const preview = await rpc.call("preview", input);
                    if (
                      !window.confirm(
                        `Review committed branch ${local.branch}? Resolved base: ${preview.base} (${preview.baseSha}). Head: ${preview.head}. Publication is disabled.`,
                      )
                    )
                      return;
                    const result = await rpc.call("start", {
                      ...input,
                      local: {
                        ...input.local,
                        expectedHead: preview.head,
                        expectedBase: preview.baseSha,
                      },
                    });
                    navigate.toPluginPanel("reviews", {
                      subPath: `${result.batchId}/0`,
                    });
                  });
                }}
              >
                <Input
                  placeholder="Absolute checkout path"
                  aria-label="Local checkout path"
                  value={local.path}
                  onChange={(e) => setLocal({ ...local, path: e.target.value })}
                />
                <Input
                  placeholder="Branch"
                  aria-label="Local branch"
                  value={local.branch}
                  onChange={(e) =>
                    setLocal({ ...local, branch: e.target.value })
                  }
                />
                <Input
                  placeholder="Base (optional)"
                  aria-label="Local base"
                  value={local.base}
                  onChange={(e) => setLocal({ ...local, base: e.target.value })}
                />
                <Action
                  type="submit"
                  disabled={
                    !!busy ||
                    !local.path ||
                    !local.branch ||
                    !data?.health.ready
                  }
                >
                  Confirm local review
                </Action>
              </form>
            </details>
            <div className="pr-health text-sm text-muted-foreground">
              <span
                className={`pr-dot ${data?.health.ready ? "pr-dot-ready" : ""}`}
              />
              {data?.health.repository ? (
                <a
                  className="pr-repository-link"
                  href={data.health.repository.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Pair Review ${data.health.version ?? "unknown"} · Pi ${data.health.reviewModel} · shared database · port ${data.health.port}`}
                >
                  {data.health.repository.name}
                  <Icon name="ExternalLink" className="size-3" />
                </a>
              ) : data ? (
                "Pair Review"
              ) : (
                "Checking Pair Review…"
              )}
              {data && <span>Updated {when(data.updatedAt)}</span>}
            </div>
            {data?.health.error && (
              <details className="pr-health-error" role="alert">
                <summary className="text-destructive text-sm">
                  Pair Review needs attention
                </summary>
                <p className="text-sm text-muted-foreground">
                  {data.health.error}
                </p>
              </details>
            )}
          </section>
          {(error || actionError) && (
            <div
              className="pr-error text-destructive border border-border"
              role="alert"
            >
              {error || actionError}
              <Action variant="outline" onClick={() => void refresh()}>
                Retry connection
              </Action>
            </div>
          )}
          {data?.warnings.length ? (
            <div
              className="pr-error text-destructive border border-border"
              role="status"
            >
              {data.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          ) : null}
          <section
            className="pr-queue-controls"
            aria-labelledby="pr-queue-controls-title"
          >
            <div className="pr-queue-controls-heading">
              <div>
                <h2 id="pr-queue-controls-title">Filter and batch PR queue</h2>
                <p className="text-sm text-muted-foreground">
                  These controls apply to Your PR queue below; running and
                  retained reviews remain unchanged.
                </p>
              </div>
              <div className="pr-queue-controls-heading-actions">
                <Badge>{filtered.length} visible</Badge>
                <Action
                  disabled={!selected.size || !!busy || !data?.health.ready}
                  onClick={() =>
                    void run("batch", () =>
                      start(
                        queue
                          .filter((q) => selected.has(q.key))
                          .map((q) => q.url),
                      ),
                    )
                  }
                >
                  Review selected ({selected.size})
                </Action>
              </div>
            </div>
            {queueError && (
              <div
                className="pr-error text-destructive border border-border"
                role="alert"
              >
                GitHub queue could not be refreshed: {queueError}
                <Action
                  variant="outline"
                  disabled={queueLoading}
                  onClick={() => void refreshQueue()}
                >
                  Retry PR discovery
                </Action>
              </div>
            )}
            <div className="pr-filters">
              {queueFilters.map(([t, title]) => (
                <Action
                  key={t}
                  variant={filter === t ? "default" : "outline"}
                  onClick={() => setFilter(t)}
                >
                  {title}
                  <Badge>
                    {t === "All"
                      ? repoQueue.length
                      : repoQueue.filter((q) => q.tags.includes(t)).length}
                  </Badge>
                </Action>
              ))}
            </div>
            <div className="pr-queue-tools">
              <label className="pr-repo-filter">
                Repository
                <select
                  aria-label="Filter by repository"
                  value={repoFilter}
                  onChange={(e) => setRepoFilter(e.target.value)}
                >
                  <option value="All">All repositories</option>
                  {repositories.map((repo) => (
                    <option key={repo} value={repo}>
                      {repo}
                    </option>
                  ))}
                </select>
              </label>
              <Input
                placeholder="Search PRs"
                aria-label="Search PR queue"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Action
                variant="outline"
                onClick={() => setSelected(new Set(filtered.map((q) => q.key)))}
              >
                Select visible
              </Action>
              <Action variant="outline" onClick={() => setSelected(new Set())}>
                Clear selection
              </Action>
            </div>
          </section>
          <nav
            className="pr-jump border border-border bg-card"
            aria-label="Review sections"
          >
            <span>Jump to</span>
            {(
              [
                ["running", "Running", running.length],
                ["recent", "Recent", recentRows.length],
                ["queue", "Queue", queue.length],
                ["attention", "Needs attention", attention.length],
                ["dismissed", "Dismissed", dismissedRows.length],
              ] as const
            ).map(([id, title, count]) => (
              <button
                key={id}
                onClick={() => {
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                  });
                  document
                    .getElementById(`pr-${id}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                {title}
                <Badge>{count}</Badge>
              </button>
            ))}
            <Action
              variant="outline"
              onClick={() =>
                setCollapsed(
                  collapsed.size === 5
                    ? new Set()
                    : new Set([
                        "queue",
                        "running",
                        "attention",
                        "recent",
                        "dismissed",
                      ]),
                )
              }
            >
              {collapsed.size === 5 ? "Expand all" : "Collapse all"}
            </Action>
          </nav>
          {section(
            "running",
            "Running",
            running.length,
            "Closing this page does not cancel a running batch.",
            <>
              <div className="pr-card-grid">{running.map(card)}</div>
              {!running.length && <Empty>No reviews are running.</Empty>}
            </>,
          )}
          {section(
            "recent",
            "Recent reviews",
            recentRows.length,
            "Completed reviews and historical attempts. Results stay local.",
            <>
              <div className="pr-card-grid">{recentRows.map(card)}</div>
              {!recentRows.length && <Empty>No retained reviews yet.</Empty>}
            </>,
          )}
          {section(
            "queue",
            "Your PR queue",
            queue.length,
            "Review requests, assigned PRs, and PRs you authored on GitHub.",
            <>
              <div className="pr-card-grid" aria-busy={queueLoading}>
                {filtered.map((q) => (
                  <article
                    className="pr-review-card border border-border bg-card"
                    key={q.key}
                  >
                    <div className="pr-heading">
                      <input
                        type="checkbox"
                        aria-label={`Select ${q.subject}`}
                        checked={selected.has(q.key)}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            e.target.checked
                              ? next.add(q.key)
                              : next.delete(q.key);
                            return next;
                          })
                        }
                      />
                      <h3 title={q.title}>{q.title}</h3>
                      {runningKeys.has(q.key) || busy === q.key ? (
                        <RunningIndicator />
                      ) : issueFor(q.key) ? (
                        <Badge tone="danger">
                          {issueFor(q.key)?.reviewState === "needs_attention"
                            ? "Review failed"
                            : "Needs attention"}
                        </Badge>
                      ) : q.freshness === "current" && completedFor(q.key) ? (
                        <FindingCount count={completedFor(q.key)!.count} />
                      ) : (
                        <Badge
                          tone={q.freshness === "stale" ? "finding" : "neutral"}
                        >
                          {q.freshness === "stale"
                            ? "Outdated"
                            : q.freshness === "current"
                              ? "Reviewed"
                              : q.freshness === "unknown"
                                ? "Freshness unknown"
                                : "Not reviewed"}
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {q.subject} · {q.author}
                    </p>
                    <ChangeSummary changes={q.changes} />
                    <div className="pr-badges">
                      {q.tags.map((t) => (
                        <Badge key={t}>{t}</Badge>
                      ))}
                    </div>
                    <p className="pr-meta text-muted-foreground">
                      Last updated{" "}
                      {q.updatedAt ? relativeUpdatedAt(q.updatedAt) : "unknown"}
                    </p>
                    {issueFor(q.key) && (
                      <CardIssue
                        reviewFailed={
                          issueFor(q.key)?.reviewState === "needs_attention"
                        }
                      />
                    )}
                    {q.previousAt && (
                      <p className="pr-meta text-muted-foreground">
                        Reviewed {when(q.previousAt)} · {q.previousModel}
                      </p>
                    )}
                    <div className="pr-actions">
                      <Action icon="Zap" onClick={() => openPR(q)}>
                        Details
                      </Action>
                      <Action
                        variant="outline"
                        icon="Play"
                        disabled={
                          !!busy ||
                          !data?.health.ready ||
                          running.some((r) => r.key === q.key)
                        }
                        onClick={() =>
                          void run(q.key, () => start([q.url], false))
                        }
                      >
                        {busy === q.key
                          ? "Starting review…"
                          : running.some((r) => r.key === q.key)
                            ? "Review running"
                            : "Review latest changes"}
                      </Action>
                      <Action
                        variant="outline"
                        icon="ExternalLink"
                        onClick={() => navigate.openUrl(q.url)}
                      >
                        Open PR
                      </Action>
                    </div>
                  </article>
                ))}
              </div>
              {!filtered.length && (
                <Empty>
                  {!data || queueLoading
                    ? "Loading your GitHub PR queue…"
                    : queueError
                      ? "PR discovery failed. Retry above; no partial queue was saved."
                      : search
                        ? "No matching PRs."
                        : queue.length
                          ? "No PRs match this filter."
                          : "No open PRs match your review requests, assignments, or authorship. Current reviews may be hidden in settings."}
                </Empty>
              )}
            </>,
          )}
          {section(
            "attention",
            "Needs attention",
            attention.length,
            "Preserved work, stale refs, and validation needs.",
            <>
              <div className="pr-card-grid">{attention.map(card)}</div>
              {!attention.length && <Empty>Nothing needs attention.</Empty>}
            </>,
          )}
          {section(
            "dismissed",
            "Dismissed runs",
            dismissedRows.length,
            "Hidden from active lists. Evidence remains retained and can be restored.",
            <>
              <div className="pr-card-grid">{dismissedRows.map(card)}</div>
              {!dismissedRows.length && <Empty>No dismissed runs.</Empty>}
            </>,
          )}
        </div>
      )}
      {detailOpen && (
        <main className="pr-detail border-border">
          <Action
            variant="ghost"
            icon="ArrowLeft"
            onClick={() => navigate.toPluginPanel("reviews")}
          >
            Overview
          </Action>
          {actionError && (
            <p role="alert" className="pr-error text-destructive">
              {actionError}
            </p>
          )}
          {detailsError && (
            <p role="alert" className="pr-error text-destructive">
              {detailsError}
            </p>
          )}
          {(!data || (!details && !prInfo)) && !detailsError && (
            <Empty>Loading review details…</Empty>
          )}
          {prInfo && !details && !selection && data && !detailsError && (
            <>
              <header className="pr-detail-header">
                <div className="pr-heading">
                  <h1>{prInfo.title}</h1>
                  {busy === "latest" ? (
                    <RunningIndicator />
                  ) : (
                    <Badge>Not reviewed</Badge>
                  )}
                </div>
                <p>
                  {prInfo.subject} · {prInfo.author}
                </p>
                <p className="pr-meta text-muted-foreground">
                  Latest discovered head:{" "}
                  <code title={prInfo.head}>{short(prInfo.head)}</code>
                </p>
                <ChangeSummary changes={prInfo.changes} />
                <div className="pr-actions">
                  <Action
                    icon="Play"
                    disabled={
                      !!busy ||
                      !data.health.ready ||
                      running.some((r) => r.key === prInfo.key)
                    }
                    onClick={() =>
                      void run("latest", () => start([prInfo.url], false))
                    }
                  >
                    Review latest changes
                  </Action>
                  {prCanResolve && (
                    <Action
                      icon="RefreshCw"
                      disabled={!!busy}
                      onClick={() => setResolverDialogOpen(true)}
                    >
                      Start resolver loop
                    </Action>
                  )}
                  <Action
                    variant="outline"
                    icon="ExternalLink"
                    disabled={!!busy}
                    onClick={() =>
                      void run("pair-review-app", async () => {
                        const { url } = await rpc.call("openFork", {
                          url: prInfo.url,
                        });
                        navigate.openUrl(url);
                      })
                    }
                  >
                    Open Pair Review
                  </Action>
                  <Action
                    variant="outline"
                    icon="GitPullRequest"
                    onClick={() => navigate.openUrl(prInfo.url)}
                  >
                    Pull request
                  </Action>
                  <Action
                    variant="outline"
                    icon="RefreshCw"
                    disabled={queueLoading}
                    onClick={() => void refreshQueue()}
                  >
                    {queueLoading
                      ? "Refreshing GitHub…"
                      : "Refresh from GitHub"}
                  </Action>
                </div>
              </header>
              {prBriefing && (
                <BriefingCard
                  briefing={prBriefing}
                  busy={!!busy}
                  onOpen={() => {
                    if (!prBriefing.file || !prBriefing.hostId) return;
                    const accepted = navigate.experimental_openFilePreview({
                      target: {
                        kind: "host",
                        hostId: prBriefing.hostId,
                        path: prBriefing.file,
                      },
                      location: null,
                    });
                    if (!accepted)
                      setActionError(
                        "BB could not open the briefing in the side panel.",
                      );
                  }}
                  onGenerate={() =>
                    void run("brief", () =>
                      rpc.call("briefingGenerate", { url: prInfo.url }),
                    )
                  }
                />
              )}
              <section className="pr-card border border-border bg-card">
                <h2>Review summary</h2>
                <p>
                  No retained review is available for this PR. Opening Details
                  does not start a review. Choose Review latest changes to run
                  Pair Review on the current committed changes.
                </p>
              </section>
              <CodeChanges
                patches={prPatches}
                selectedFile={selectedFile}
                onSelectedFile={setSelectedFile}
                error={prPatchError}
              />
              <section className="pr-card border border-border bg-card">
                <div className="pr-heading">
                  <h2>Resolver loop</h2>
                  <Badge>{prFeedback?.comments.length ?? 0} comments</Badge>
                </div>
                <p className="text-muted-foreground">
                  A resolver loop can begin from existing human feedback without
                  first running Pair Review. It judges each comment for factual
                  correctness, relevance, and PR scope before editing, then uses
                  Pair Review for each follow-up gate.
                </p>
                {prCanResolve && (
                  <Action
                    icon="Play"
                    disabled={!!busy}
                    onClick={() => setResolverDialogOpen(true)}
                  >
                    Start resolver loop
                  </Action>
                )}
                {prFeedback?.error && (
                  <p className="text-destructive">{prFeedback.error}</p>
                )}
              </section>
              {prFeedback && (
                <section className="pr-card border border-border bg-card">
                  <div className="pr-heading">
                    <h2>Human PR feedback</h2>
                    <Badge>
                      {prFeedback.complete
                        ? "Complete snapshot"
                        : "Unavailable"}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Read-only unresolved review threads, review summaries, and
                    PR conversation from people other than the PR author.
                  </p>
                  <Action
                    variant="outline"
                    onClick={() => setShowFeedback(!showFeedback)}
                  >
                    {showFeedback ? "Hide feedback" : "Show feedback"}
                  </Action>
                  {showFeedback && !prFeedback.comments.length && (
                    <p className="text-muted-foreground">
                      {prFeedback.complete
                        ? "No unresolved human feedback was found."
                        : prFeedback.error || "Human feedback is unavailable."}
                    </p>
                  )}
                  {showFeedback &&
                    prFeedback.comments.map((comment, index) => (
                      <article className="pr-feedback" key={index}>
                        <h3>
                          {comment.author} · {comment.location}
                        </h3>
                        <Markdown content={comment.body} />
                      </article>
                    ))}
                </section>
              )}
            </>
          )}
          {details && data && (
            <>
              <header className="pr-detail-header">
                <div className="pr-heading">
                  <h1>{details.row.title}</h1>
                  {details.row.running || busy === "latest" ? (
                    <RunningIndicator />
                  ) : details.row.dismissed ? (
                    <Badge>Dismissed</Badge>
                  ) : details.row.attention ? (
                    <Badge tone="danger">Needs attention</Badge>
                  ) : completedReview(details.row) ? (
                    <span className="pr-statuses">
                      <FindingCount count={details.row.count} />
                      {isOutdated(details.row) && (
                        <Badge tone="finding">Outdated</Badge>
                      )}
                    </span>
                  ) : (
                    <Badge>{label(details.row.reviewState)}</Badge>
                  )}
                </div>
                <p>
                  {details.row.subject} · {details.row.author}
                </p>
                <p className="pr-meta text-muted-foreground">
                  {when(details.row.updatedAt)} · pi · {details.row.model} ·{" "}
                  <code title={details.row.head}>
                    {short(details.row.head)}
                  </code>
                </p>
                <ChangeSummary changes={details.changes} />
                <div className="pr-actions">
                  <Action
                    variant="outline"
                    icon="ExternalLink"
                    disabled={!!busy}
                    onClick={() =>
                      void run("pair-review-app", async () => {
                        const { url } = await rpc.call("openFork", {
                          batchId: details.row.batchId,
                          index: details.row.index,
                        });
                        navigate.openUrl(url);
                      })
                    }
                  >
                    Open Pair Review
                  </Action>
                  {details.row.url && (
                    <Action
                      variant="outline"
                      icon="GitPullRequest"
                      onClick={() => navigate.openUrl(details.row.url!)}
                    >
                      Pull request
                    </Action>
                  )}
                  {details.row.canResolve && (
                    <Action
                      icon="RefreshCw"
                      disabled={!!busy || details.row.running}
                      onClick={() => setResolverDialogOpen(true)}
                    >
                      Start resolver loop
                    </Action>
                  )}
                  {details.row.url && (
                    <Action
                      variant="outline"
                      icon="RefreshCw"
                      disabled={queueLoading}
                      onClick={() => void refreshQueue()}
                    >
                      {queueLoading
                        ? "Refreshing GitHub…"
                        : "Refresh from GitHub"}
                    </Action>
                  )}
                  {details.row.url && (
                    <Action
                      icon="Zap"
                      disabled={!!busy || details.row.running}
                      onClick={() =>
                        void run("latest", () =>
                          start([details.row.url!], false),
                        )
                      }
                    >
                      {details.row.attention
                        ? "Start fresh review"
                        : "Review latest changes"}
                    </Action>
                  )}
                  {!details.row.running &&
                    (details.row.dismissed ? (
                      <Action
                        variant="outline"
                        disabled={!!busy}
                        onClick={() =>
                          void run("restore", () =>
                            action(details.row, "restore"),
                          )
                        }
                      >
                        Restore run
                      </Action>
                    ) : (
                      <Action
                        variant="ghost"
                        disabled={!!busy}
                        onClick={() =>
                          void run("dismiss", async () => {
                            if (await action(details.row, "dismiss"))
                              navigate.toPluginPanel("reviews");
                          })
                        }
                      >
                        Dismiss run
                      </Action>
                    ))}
                  {details.row.running && (
                    <Action
                      variant="outline"
                      disabled={!!busy}
                      onClick={() =>
                        void run("cancel", () => action(details.row, "cancel"))
                      }
                    >
                      Cancel batch
                    </Action>
                  )}
                  {details.row.running && (
                    <Action
                      variant="outline"
                      disabled={!!busy}
                      onClick={() =>
                        void run("recover", () =>
                          action(details.row, "recover"),
                        )
                      }
                    >
                      Recover if stopped
                    </Action>
                  )}
                </div>
              </header>
              <BriefingCard
                briefing={details.briefing}
                busy={!!busy}
                onOpen={() => {
                  if (!details.briefing.file || !details.briefing.hostId)
                    return;
                  const accepted = navigate.experimental_openFilePreview({
                    target: {
                      kind: "host",
                      hostId: details.briefing.hostId,
                      path: details.briefing.file,
                    },
                    location: null,
                  });
                  if (!accepted)
                    setActionError(
                      "BB could not open the briefing in the side panel.",
                    );
                }}
                onGenerate={() => {
                  if (!details.row.url) return;
                  void run("brief", () =>
                    rpc.call("briefingGenerate", { url: details.row.url! }),
                  );
                }}
              />
              {details.row.reviewState !== "needs_attention" && (
                <section className="pr-card border border-border bg-card">
                  <h2>Review summary</h2>
                  <p>{details.summary}</p>
                  {data?.queue.find(
                    (q) =>
                      q.key === details.row.key && q.head !== details.row.head,
                  ) && (
                    <p className="text-destructive">
                      This review describes an earlier PR head. Review latest
                      changes before using these findings.
                    </p>
                  )}
                </section>
              )}
              <CodeChanges
                patches={details.patches}
                selectedFile={selectedFile}
                onSelectedFile={setSelectedFile}
              />
              {details.row.attention && (
                <section className="pr-card pr-attention-card border border-border bg-card">
                  <h2>
                    {details.row.reviewState === "needs_attention"
                      ? "Review could not finish"
                      : "Human decision required"}
                  </h2>
                  <p>
                    {details.row.reviewState === "needs_attention"
                      ? "Pair Review stopped before it could produce verified findings. Start a fresh review or inspect the technical details below."
                      : "This review has retained work that needs a person to inspect before continuing."}
                  </p>
                  <details className="pr-diagnostics">
                    <summary>Technical details</summary>
                    <p className="text-destructive">{details.row.attention}</p>
                    <p>
                      Reviewed head: <code>{details.row.head}</code>
                    </p>
                    {details.row.path && (
                      <p className="pr-path">
                        Work preserved at:{" "}
                        <FileLink
                          target={{
                            kind: "host",
                            hostId: data!.hostId,
                            path: details.row.path,
                          }}
                        >
                          {details.row.path}
                        </FileLink>
                      </p>
                    )}
                  </details>
                  <div className="pr-actions">
                    {details.row.canAttempt && !details.row.url && (
                      <Action
                        variant="outline"
                        disabled={!!busy || details.row.running}
                        onClick={() =>
                          void run("attempt", () =>
                            action(details.row, "attempt"),
                          )
                        }
                      >
                        Fresh review attempt
                      </Action>
                    )}
                    {details.row.canRetry && (
                      <Action
                        variant="outline"
                        disabled={!!busy || details.row.running}
                        onClick={() =>
                          void run("retry", () => action(details.row, "retry"))
                        }
                      >
                        Retry optional resolution
                      </Action>
                    )}
                    {details.row.canValidate && (
                      <Action
                        disabled={!!busy || details.row.running}
                        onClick={() =>
                          void run("validate", () =>
                            action(details.row, "validate"),
                          )
                        }
                      >
                        {details.row.publish
                          ? "Publish human-validated fixes"
                          : "Commit human-validated fixes locally"}
                      </Action>
                    )}
                  </div>
                </section>
              )}
              {details.row.resolverError && !details.row.attention && (
                <section className="pr-card border border-border bg-card">
                  <h2>Review completed; resolver run failed</h2>
                  <p>
                    Pair Review completed successfully. Its findings remain
                    available; no resolver fixes were accepted.
                  </p>
                  <p className="text-destructive">
                    {details.row.resolverError}
                  </p>
                  {details.row.path && (
                    <p className="pr-path">
                      Resolver checkout retained for diagnostics at:{" "}
                      <FileLink
                        target={{
                          kind: "host",
                          hostId: data!.hostId,
                          path: details.row.path,
                        }}
                      >
                        {details.row.path}
                      </FileLink>
                    </p>
                  )}
                  {details.row.canRetry && (
                    <div className="pr-actions">
                      <Action
                        variant="outline"
                        disabled={!!busy || details.row.running}
                        onClick={() =>
                          void run("retry", () => action(details.row, "retry"))
                        }
                      >
                        Retry optional resolution
                      </Action>
                    </div>
                  )}
                </section>
              )}
              <section className="pr-findings">
                <div className="pr-findings-heading">
                  <div>
                    <h2>Findings</h2>
                    <p className="text-sm text-muted-foreground">
                      Review observations from the exact captured changes.
                    </p>
                  </div>
                  <FindingCount count={details.findings.length} prominent />
                </div>
                {!details.findings.length ? (
                  <Empty>No findings for this run.</Empty>
                ) : (
                  <div className="pr-finding-list">
                    {details.findings.map((f, index) => (
                      <article
                        className="pr-finding border border-border bg-card"
                        key={f.id}
                      >
                        <header className="pr-finding-header">
                          <span className="pr-finding-index" aria-hidden="true">
                            {index + 1}
                          </span>
                          <div className="pr-finding-title">
                            <h3>{f.title}</h3>
                            <p
                              className="pr-finding-location"
                              title={`${f.file}${f.line ? `:${f.line}` : ""}`}
                            >
                              {f.sourcePath ? (
                                <FileLink
                                  target={{
                                    kind: "host",
                                    hostId: data!.hostId,
                                    path: f.sourcePath,
                                  }}
                                  location={
                                    f.line
                                      ? {
                                          kind: "line",
                                          line: f.line,
                                          column: null,
                                        }
                                      : undefined
                                  }
                                >
                                  {f.file}
                                  {f.line ? `:${f.line}` : ""}
                                </FileLink>
                              ) : (
                                <>
                                  {f.file}
                                  {f.line ? `:${f.line}` : ""}
                                </>
                              )}
                            </p>
                          </div>
                          <div className="pr-finding-tags">
                            {f.kind && (
                              <Badge
                                tone={
                                  f.kind === "praise" ? "neutral" : "finding"
                                }
                              >
                                {label(f.kind)}
                              </Badge>
                            )}
                            {f.severity && <Badge>{label(f.severity)}</Badge>}
                            {f.disposition && (
                              <Badge>{label(f.disposition)}</Badge>
                            )}
                          </div>
                        </header>
                        <div className="pr-finding-body">
                          <section className="pr-finding-comment">
                            <h4>Comment</h4>
                            <Markdown content={f.body} />
                          </section>
                          {f.suggestion && (
                            <section className="pr-finding-suggestion">
                              <h4>Suggestion</h4>
                              <Markdown content={f.suggestion} />
                            </section>
                          )}
                        </div>
                        {f.reason && (
                          <footer className="pr-finding-resolution">
                            <strong>Resolution note</strong>
                            <span>{f.reason}</span>
                          </footer>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </section>
              <section className="pr-card border border-border bg-card">
                <div className="pr-heading">
                  <h2>Resolver activity</h2>
                  <Badge>{label(details.row.resolverState)}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  Read-only recent session activity. No shared writer is
                  attached.
                </p>
                {details.activity.length ? (
                  <div className="pr-activity">
                    {details.activity.map((line, i) => (
                      <pre key={i}>{line}</pre>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground">
                    No resolver activity captured.
                  </p>
                )}
              </section>
              <section className="pr-card border border-border bg-card">
                <div className="pr-heading">
                  <h2>Human PR feedback</h2>
                  <Badge>
                    {details.feedback.complete
                      ? "Complete snapshot"
                      : "Unavailable"}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  Read-only snapshot of unresolved review threads, review
                  summaries, and PR conversation from people other than the PR
                  author. On a PR you own, a manual resolver loop can
                  disposition every item for truth, relevance, and scope;
                  nothing is posted to GitHub.
                </p>
                <Action
                  className="pr-feedback-toggle"
                  variant="outline"
                  onClick={() => setShowFeedback(!showFeedback)}
                >
                  {showFeedback ? "Hide feedback" : "Show feedback"}
                </Action>
                {showFeedback && (
                  <>
                    {!details.feedback.comments.length && (
                      <p className="text-muted-foreground">
                        {details.feedback.complete
                          ? "No unresolved human feedback was found."
                          : details.feedback.error ||
                            "Human feedback is unavailable."}
                      </p>
                    )}
                    {details.feedback.comments.map((c, i) => (
                      <article className="pr-feedback" key={i}>
                        <div className="pr-heading">
                          <h3>
                            {c.author} · {c.location}
                          </h3>
                          {c.disposition && (
                            <Badge>{label(c.disposition)}</Badge>
                          )}
                        </div>
                        <Markdown content={c.body} />
                        {c.reason && (
                          <p className="text-sm text-muted-foreground">
                            Resolver: {c.reason}
                          </p>
                        )}
                      </article>
                    ))}
                  </>
                )}
              </section>
            </>
          )}
        </main>
      )}
    </div>
  );
}
function AttentionCount() {
  const { data } = useData();
  const count =
    data?.rows.filter((r) => !r.dismissed && !r.superseded && !!r.attention)
      .length ?? 0;
  return count ? (
    <span className="text-xs text-muted-foreground">{count}</span>
  ) : null;
}
function ConfigurationHelp() {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Changes in the fields above are saved by BB and apply to the next
        operation. Set <strong>Pair Review installation</strong> to <code>pair-review</code>{" "}
        for the original installed app on the BB server PATH, or to an absolute
        or <code>~/</code> directory for a compatible local fork. Choose the
        native Pair Review provider used for analysis and a separately guarded
        resolver provider. A legacy <code>~/.pair-review/pi-settings.json</code>{" "}
        may still supply team and teammate metadata, but plugin settings control
        providers and models. Provider and GitHub credentials remain in their
        native stores; this plugin does not store secret settings.
      </p>
      <div>
        <Action
          variant="outline"
          disabled={busy}
          onClick={async () => {
            if (!window.confirm("Reset every Pair Review setting to its default?"))
              return;
            setBusy(true);
            setMessage("");
            try {
              await rpc.call("resetSettings");
              setMessage("Defaults restored. Reopen Pair Review settings to refresh the fields above.");
            } catch (error) {
              setMessage(`Reset failed: ${String(error)}`);
            } finally {
              setBusy(false);
            }
          }}
        >
          Reset all to defaults
        </Action>
      </div>
      {message && (
        <p role="status" className="text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "configuration-help",
    title: "Configuration notes",
    description: "How Pair Review applies and resets these settings.",
    component: ConfigurationHelp,
  });
  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "settings",
    label: "Pair Review settings",
    icon: "Settings2",
    onActivate: ({ openPluginDetails }) => openPluginDetails(),
  });
  app.slots.navPanel({
    id: "reviews",
    title: "Pair Review",
    icon: "Search",
    path: "reviews",
    component: PairReviewPage,
    experimental_sidebarAccessory: AttentionCount,
  });
});
