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
import { relativeRefreshedAt, relativeUpdatedAt } from "./time";
import { cn } from "@/lib/utils";
import {
  Callout,
  Chevron,
  Disclosure,
  DotLabel,
  KeyValue,
  Metric,
  MetricRow,
  Pill,
  SegmentedBar,
  Steps,
  Tabs,
  Timeline,
  TONE_TEXT,
  rampColor,
  type BarPart,
  type StepStatus,
  type TabSpec,
  type Tone,
} from "./ui/kit";
import { FindingsReport, isPraise } from "./ui/findings";
import { IconAction, Picker, TooltipProvider } from "./ui/controls";
import {
  describeReset,
  isRateLimitError,
  limitStatus,
  type GitHubLimits,
} from "./github-limits";
type PageData = Snapshot & { hostId: string; preferences: Preferences };
type OverviewTab =
  "queue" | "running" | "attention" | "final" | "recent" | "dismissed";
type DetailTab =
  "findings" | "changes" | "feedback" | "activity" | "history" | "resolver";
/** The overview tab survives a trip to Details and back. */
let lastOverviewTab: OverviewTab = "queue";
/** Queue composition, most team-relevant first; a PR counts under its first match. */
const REQUEST_ORDER = [
  "Team request",
  "Teammate request",
  "Assigned",
  "Authored",
  "Other direct request",
] as const;
const REQUEST_LABELS: Record<(typeof REQUEST_ORDER)[number], string> = {
  "Team request": "Team requests",
  "Teammate request": "Teammate requests",
  Assigned: "Assigned",
  Authored: "Authored",
  "Other direct request": "Other direct requests",
};
const label = (s: string) => s.replaceAll("_", " ");
const resolverCardLabel = (state: string) =>
  state === "resolving"
    ? "Resolver: running"
    : state === "reviewing"
      ? "Resolver: reviewing"
      : null;
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
const BADGE_TONE: Record<
  "neutral" | "danger" | "good" | "running" | "finding",
  Tone
> = {
  neutral: "neutral",
  danger: "bad",
  good: "good",
  running: "info",
  finding: "warn",
};
function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "danger" | "good" | "running" | "finding";
}) {
  return (
    <Pill tone={BADGE_TONE[tone]} className={`pr-badge pr-badge-${tone}`}>
      {children}
    </Pill>
  );
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
const changeLabel = (changes: NonNullable<QueueItem["changes"]>) =>
  `${changes.files} changed ${changes.files === 1 ? "file" : "files"}, ${changes.additions} additions, ${changes.deletions} deletions`;
function ChangeSummary({ changes }: { changes: QueueItem["changes"] }) {
  if (!changes) return null;
  return (
    <div className="pr-change-stats" aria-label={changeLabel(changes)}>
      <span className={cn("pr-additions", !changes.additions && "pr-zero")}>
        +{changes.additions}
      </span>
      <span className={cn("pr-deletions", !changes.deletions && "pr-zero")}>
        −{changes.deletions}
      </span>
      <span className="pr-change-files">
        {changes.files} {changes.files === 1 ? "file" : "files"}
      </span>
    </div>
  );
}
function ChangeMetric({
  changes,
  active,
  onClick,
}: {
  changes: QueueItem["changes"];
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <Metric
      label="Change size"
      value={
        changes ? (
          <span aria-label={changeLabel(changes)}>
            <span
              className={cn("pr-additions", !changes.additions && "pr-zero")}
            >
              +{changes.additions}
            </span>{" "}
            <span
              className={cn("pr-deletions", !changes.deletions && "pr-zero")}
            >
              −{changes.deletions}
            </span>
          </span>
        ) : (
          "—"
        )
      }
      note={
        changes
          ? `${changes.files} ${changes.files === 1 ? "file" : "files"}`
          : "Size unknown"
      }
      active={active}
      onClick={onClick}
    />
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
    <section className="pr-panel" aria-labelledby="pr-code-changes-title">
      <h2 id="pr-code-changes-title">Code changes</h2>
      <p className="pr-panel-caption">
        Select one changed file to inspect its committed patch. Analysis is not
        required to view these changes.
      </p>
      <div className="pr-diff-picker">
        <Picker
          label="Changed file"
          value={selectedFile}
          onChange={onSelectedFile}
          placeholder="No changed files available"
          mono
          className="w-full"
          options={patches.map((file, index) => ({
            value: String(index),
            label: file.path,
          }))}
        />
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
  onOpenThread,
  onGenerate,
}: {
  briefing: Details["briefing"];
  busy: boolean;
  onOpen: () => void;
  onOpenThread: () => void;
  onGenerate: () => void;
}) {
  if (!briefing.available) return null;
  const generating = ["queued", "generating"].includes(briefing.state);
  return (
    <section className="pr-frame" aria-label="PR briefing">
      <div className="pr-panel-heading">
        <h2>PR briefing</h2>
        <Badge tone={briefing.state === "failed" ? "danger" : "neutral"}>
          {label(briefing.state)}
        </Badge>
      </div>
      <p className="pr-panel-caption">
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
        <span
          title={
            briefing.threadId
              ? "Open the retained BB thread for this briefing"
              : "No retained briefing thread is available"
          }
        >
          <Action
            variant="outline"
            disabled={!briefing.threadId}
            onClick={onOpenThread}
          >
            Open briefing thread
          </Action>
        </span>
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
      <Icon name="AlertTriangle" className="size-3.5" />
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
      <Icon name="AlertTriangle" className="size-3.5" />
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
/** GitHub refused a request for rate limiting: say when it lifts, calmly. */
function RateLimitNotice({
  status,
  what,
  action,
}: {
  status: { resetAt: string | null; secondary: boolean } | null;
  what: string;
  action?: ReactNode;
}) {
  return (
    <Callout
      tone="warn"
      role="alert"
      title={
        status?.secondary
          ? "GitHub asked Pair Review to slow down"
          : "GitHub's API rate limit is used up"
      }
    >
      <p>
        {status?.resetAt
          ? `It resets at ${describeReset(status.resetAt)}. ${what}`
          : status?.secondary
            ? `Wait a few minutes before trying again. ${what}`
            : `Checking when it resets… ${what}`}
      </p>
      {action}
    </Callout>
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
    [tab, setTabState] = useState<OverviewTab>(lastOverviewTab),
    [detailTab, setDetailTab] = useState<DetailTab | null>(null),
    [healthOpen, setHealthOpen] = useState(false),
    [selectedFile, setSelectedFile] = useState(""),
    [resolverDialogOpen, setResolverDialogOpen] = useState(false),
    [localOpen, setLocalOpen] = useState(false);
  const reloadDetailsRef = useRef<(() => void) | null>(null);
  // Set when GitHub rate-limits a request; cleared once a request succeeds.
  const [githubLimit, setGithubLimit] = useState<{
    resetAt: string | null;
    secondary: boolean;
  } | null>(null);
  const [githubLimits, setGithubLimits] = useState<GitHubLimits | null>(null);
  // Reading the limits is free: GitHub does not count this call.
  const noteRateLimit = useCallback(
    async (error: unknown) => {
      if (!isRateLimitError(error)) return;
      setGithubLimit(
        (current) => current ?? { resetAt: null, secondary: false },
      );
      try {
        const limits = await rpc.call("rateLimit");
        setGithubLimits(limits);
        setGithubLimit(limitStatus(limits));
      } catch {
        setGithubLimit({ resetAt: null, secondary: true });
      }
    },
    [rpc],
  );
  const limitedUntil =
    githubLimit?.resetAt && Date.parse(githubLimit.resetAt) > Date.now()
      ? githubLimit.resetAt
      : null;
  const refreshLabel = (loading: boolean) =>
    loading
      ? "Refreshing GitHub…"
      : limitedUntil
        ? `Refresh after ${new Date(limitedUntil).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
        : "Refresh from GitHub";
  useEffect(() => {
    let live = true;
    setDetails(null);
    setDetailsError("");
    setSelectedFile("");
    setDetailTab(null);
    setResolvedSelection(null);
    setPrInfo(null);
    setPrPatches([]);
    setPrPatchError(null);
    setPrFeedback(null);
    setPrCanResolve(false);
    setPrBriefing(null);
    if (!detailOpen) return;
    let loading = false;
    // A PR page asks GitHub once when it opens, and again only on request or
    // when this PR's local review changes. The 3-second poll below reads local
    // state only, so an open tab never spends API quota.
    let fetchPr = true,
      prFailed = false,
      prTarget: { batchId: string; index: number } | null = null;
    const watchesPr = !!prUrl && !activeStartedSelection;
    const load = async () => {
      if (loading) return;
      if (watchesPr && prFailed && !fetchPr) return;
      loading = true;
      try {
        let target = activeStartedSelection ?? batchSelection;
        let availablePrPatches: Details["patches"] = [];
        if (watchesPr) {
          if (fetchPr) {
            fetchPr = false;
            prFailed = false;
            let result: Awaited<ReturnType<typeof rpc.call<"prDetails">>>;
            try {
              result = await rpc.call("prDetails", { url: prUrl! });
            } catch (e) {
              prFailed = true;
              throw e;
            }
            if (!live) return;
            setPrInfo(result.pr);
            availablePrPatches = result.patches;
            setPrPatches(availablePrPatches);
            setPrPatchError(result.patchError);
            setPrFeedback(result.feedback);
            setPrCanResolve(result.canResolve);
            setPrBriefing(result.briefing);
            setResolvedSelection(result.review);
            prTarget = result.review;
          }
          target = prTarget;
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
        if (live) {
          setDetailsError(String(e));
          void noteRateLimit(e);
        }
      } finally {
        loading = false;
      }
    };
    reloadDetailsRef.current = () => {
      fetchPr = true;
      void load();
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      live = false;
      reloadDetailsRef.current = null;
      clearInterval(timer);
    };
  }, [rpc, subPath, activeStartedSelection?.batchId]);
  const prKey = prMatch
    ? `${prMatch[1]}/${prMatch[2]}/${prMatch[3]}#${prMatch[4]}`.toLowerCase()
    : null;
  const reviewSignature =
    prKey && data
      ? data.rows
          .filter((r) => r.key === prKey)
          .map(
            (r) =>
              `${r.id}:${r.reviewState}:${r.running}:${r.dismissed}:${r.superseded}`,
          )
          .join("|")
      : null;
  const seenReviewSignature = useRef<{ key: string; signature: string } | null>(
    null,
  );
  useEffect(() => {
    if (!prKey || reviewSignature === null) {
      seenReviewSignature.current = null;
      return;
    }
    const seen = seenReviewSignature.current;
    seenReviewSignature.current = { key: prKey, signature: reviewSignature };
    if (seen && seen.key === prKey && seen.signature !== reviewSignature)
      reloadDetailsRef.current?.();
  }, [prKey, reviewSignature]);
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
      setGithubLimit(null);
    } catch (e) {
      setQueueError(String(e));
      void noteRateLimit(e);
    } finally {
      setQueueLoading(false);
    }
  }, [rpc, hostname, teams, teammates, noteRateLimit]);
  // Opening the page shows the last saved queue and its age; GitHub is asked
  // again only on request. The exception is a first run, or settings (host,
  // teams, teammates) that changed so the saved queue no longer applies.
  const needsFirstRefresh =
    !!hostname && data != null && data.queueRefreshedAt == null;
  useEffect(() => {
    if (needsFirstRefresh) void refreshQueue();
  }, [needsFirstRefresh, refreshQueue]);
  // Setup health shows the remaining budget; reading it costs no quota.
  useEffect(() => {
    if (!healthOpen) return;
    let live = true;
    rpc
      .call("rateLimit")
      .then((limits) => live && setGithubLimits(limits))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [healthOpen, rpc]);
  // A details page refreshes the queue and then re-reads its own PR.
  const refreshFromGitHub = () => {
    void refreshQueue();
    reloadDetailsRef.current?.();
  };
  const previousHostname = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      previousHostname.current &&
      hostname &&
      previousHostname.current !== hostname
    ) {
      setRepoFilter("All");
      setSelected(new Set());
    }
    previousHostname.current = hostname;
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
        "Stop this PR's run? Other reviews in the same batch will continue, and retained checkouts or completed results will be preserved.",
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
  const running = rows.filter((r) => r.running && !r.superseded),
    attention = rows.filter(
      (r) => !r.running && !r.superseded && !!r.attention,
    ),
    finalReviewRows = rows.filter(
      (r) =>
        !r.running &&
        !r.superseded &&
        !r.attention &&
        !r.submitted &&
        r.finalReview &&
        !isOutdated(r),
    ),
    recentRows = rows.filter(
      (r) =>
        !r.running &&
        !attention.includes(r) &&
        !finalReviewRows.includes(r) &&
        !r.submitted,
    );
  const runningKeys = new Set(running.map((r) => r.key));
  const movedQueueKeys = new Set(
    [...running, ...attention, ...recentRows, ...finalReviewRows].map(
      (row) => row.key,
    ),
  );
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
      !movedQueueKeys.has(q.key) &&
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
  const selectedQueue = queue.filter((q) => selected.has(q.key));
  const setTab = (next: OverviewTab) => {
    lastOverviewTab = next;
    setTabState(next);
  };
  const primaryRequest = (q: QueueItem) =>
    REQUEST_ORDER.find((tag) => q.tags.includes(tag)) ?? "Other direct request";
  const requestParts: BarPart[] = REQUEST_ORDER.map((tag, index) => ({
    id: tag,
    label: REQUEST_LABELS[tag],
    value: queue.filter((q) => primaryRequest(q) === tag).length,
    color: rampColor(index),
  })).filter((part) => part.value > 0);
  const fromTeam = queue.filter(
    (q) =>
      q.tags.includes("Team request") || q.tags.includes("Teammate request"),
  ).length;
  const reviewStatus = (r: ReviewRow) =>
    r.running && !r.superseded ? (
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
    );
  const reviewIcon = (r: ReviewRow): { name: string; tone: Tone } =>
    r.dismissed
      ? { name: "Archive", tone: "neutral" }
      : r.running && !r.superseded
        ? { name: "Loading", tone: "info" }
        : r.attention
          ? { name: "AlertTriangle", tone: "bad" }
          : completedReview(r)
            ? r.count
              ? { name: "FileText", tone: "warn" }
              : { name: "CircleCheck", tone: "good" }
            : { name: "Clock", tone: "neutral" };
  const reviewRow = (r: ReviewRow) => {
    const icon = reviewIcon(r);
    return (
      <article className="pr-row" key={r.id}>
        <span className="pr-row-icon" aria-hidden="true">
          <Icon
            name={icon.name}
            className={cn("size-4", TONE_TEXT[icon.tone])}
          />
        </span>
        <div className="pr-row-main">
          <h3 title={r.title}>{r.title}</h3>
          <p className="pr-row-meta">
            {r.subject} · {r.author} · {when(r.updatedAt)} ·{" "}
            <code>{short(r.head)}</code> · attempt {r.attempt}
          </p>
          {(resolverCardLabel(r.resolverState) ||
            (!r.dismissed && (r.attention || r.resolverError))) && (
            <div className="pr-row-notes">
              {resolverCardLabel(r.resolverState) && (
                <Badge tone="running">
                  {resolverCardLabel(r.resolverState)}
                </Badge>
              )}
              {!r.dismissed && r.attention && (
                <CardIssue reviewFailed={r.reviewState === "needs_attention"} />
              )}
              {!r.dismissed && r.resolverError && !r.attention && (
                <ResolverIssue />
              )}
            </div>
          )}
        </div>
        <div className="pr-row-size">
          <ChangeSummary changes={r.changes} />
        </div>
        <div className="pr-row-status">{reviewStatus(r)}</div>
        <div className="pr-row-actions">
          <Action size="sm" onClick={() => open(r)}>
            Details
          </Action>
          {r.url && !r.running && !r.dismissed && (
            <IconAction
              icon="Play"
              label="Review latest changes"
              disabled={!!busy}
              onClick={() => void run(r.id, () => start([r.url!], false))}
            />
          )}
          {!r.running &&
            (r.dismissed ? (
              <Action
                size="sm"
                variant="outline"
                disabled={!!busy}
                onClick={() =>
                  void run(`restore-${r.id}`, () => action(r, "restore"))
                }
              >
                Restore
              </Action>
            ) : (
              <IconAction
                icon="Archive"
                label="Dismiss run"
                disabled={!!busy}
                onClick={() =>
                  void run(`dismiss-${r.id}`, () => action(r, "dismiss"))
                }
              />
            ))}
          {r.url && (
            <IconAction
              icon="ExternalLink"
              label="Open PR"
              onClick={() => navigate.openUrl(r.url!)}
            />
          )}
        </div>
      </article>
    );
  };
  const queueStatus = (q: QueueItem) =>
    runningKeys.has(q.key) || busy === q.key ? (
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
      <Badge tone={q.freshness === "stale" ? "finding" : "neutral"}>
        {q.freshness === "stale"
          ? "Outdated"
          : q.freshness === "current"
            ? "Reviewed"
            : q.freshness === "unknown"
              ? "Freshness unknown"
              : "Not reviewed"}
      </Badge>
    );
  const queueRow = (q: QueueItem) => {
    const reviewRunning = running.some((r) => r.key === q.key);
    return (
      <article
        className={cn(
          "pr-row pr-queue-row",
          selected.has(q.key) && "pr-row-selected",
        )}
        key={q.key}
      >
        <span className="pr-row-select">
          <input
            type="checkbox"
            aria-label={`Select ${q.subject}`}
            checked={selected.has(q.key)}
            onChange={(e) =>
              setSelected((prev) => {
                const next = new Set(prev);
                e.target.checked ? next.add(q.key) : next.delete(q.key);
                return next;
              })
            }
          />
        </span>
        <div className="pr-row-main">
          <h3 title={q.title}>{q.title}</h3>
          <p className="pr-row-meta">
            {q.subject} · {q.author}
            {q.previousAt && (
              <>
                {" "}
                · Reviewed {when(q.previousAt)} · {q.previousModel}
              </>
            )}
          </p>
          {issueFor(q.key) && (
            <div className="pr-row-notes">
              <CardIssue
                reviewFailed={
                  issueFor(q.key)?.reviewState === "needs_attention"
                }
              />
            </div>
          )}
        </div>
        <div className="pr-row-tags">
          {q.tags.map((t) => (
            <DotLabel
              key={t}
              tone={
                t === "Team request" || t === "Teammate request"
                  ? "info"
                  : t === "Authored"
                    ? "good"
                    : "neutral"
              }
            >
              {t}
            </DotLabel>
          ))}
        </div>
        <div className="pr-row-size">
          <ChangeSummary changes={q.changes} />
        </div>
        <div className="pr-row-updated">
          <span className="sr-only">Last updated </span>
          {q.updatedAt ? relativeUpdatedAt(q.updatedAt) : "unknown"}
        </div>
        <div className="pr-row-status">{queueStatus(q)}</div>
        <div className="pr-row-actions">
          <Action size="sm" onClick={() => openPR(q)}>
            Details
          </Action>
          <IconAction
            icon="Play"
            label={
              busy === q.key
                ? "Starting review…"
                : reviewRunning
                  ? "Review running"
                  : "Review latest changes"
            }
            disabled={!!busy || !data?.health.ready || reviewRunning}
            onClick={() => void run(q.key, () => start([q.url], false))}
          />
          <IconAction
            icon="ExternalLink"
            label="Open PR"
            onClick={() => navigate.openUrl(q.url)}
          />
        </div>
      </article>
    );
  };
  const reviewPanel = (
    id: OverviewTab,
    title: string,
    description: string,
    rowsInPanel: ReviewRow[],
    empty: string,
  ) => (
    <section
      id={`pr-${id}`}
      className="pr-panel"
      aria-labelledby={`pr-${id}-title`}
    >
      <h2 id={`pr-${id}-title`} className="sr-only">
        {title}
      </h2>
      <p className="pr-panel-caption">{description}</p>
      {rowsInPanel.length ? (
        <div className="pr-rows">{rowsInPanel.map(reviewRow)}</div>
      ) : (
        <Empty>{empty}</Empty>
      )}
    </section>
  );
  const overviewTabs: TabSpec<OverviewTab>[] = [
    { id: "queue", label: "PR Queue", count: queue.length },
    {
      id: "running",
      label: "Running",
      count: running.length,
      adornment: running.length ? (
        <span className="pr-spinner pr-spinner-small" aria-hidden="true" />
      ) : undefined,
    },
    { id: "attention", label: "Needs attention", count: attention.length },
    { id: "final", label: "Final Review", count: finalReviewRows.length },
    { id: "recent", label: "Recent reviews", count: recentRows.length },
    { id: "dismissed", label: "Dismissed", count: dismissedRows.length },
  ];
  // ---- Details: shared derived values ----------------------------------
  const detailRow = details?.row ?? null;
  const attempts = detailRow
    ? allRows
        .filter((r) => r.key === detailRow.key)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    : [];
  const queueEntry = detailRow
    ? (data?.queue ?? []).find((q) => q.key === detailRow.key)
    : undefined;
  const praiseCount = details?.findings.filter(isPraise).length ?? 0;
  const actionableCount = (details?.findings.length ?? 0) - praiseCount;
  const activeDetailTab: DetailTab =
    detailTab ?? (details ? "findings" : "changes");
  const attemptTitle = (r: ReviewRow) =>
    r.running && !r.superseded
      ? "Review running"
      : r.attention
        ? r.reviewState === "needs_attention"
          ? "Review failed"
          : "Needs attention"
        : completedReview(r)
          ? r.count
            ? `${r.count} ${r.count === 1 ? "finding" : "findings"}`
            : "No findings"
          : label(r.reviewState);
  const attemptTone = (r: ReviewRow): Tone =>
    r.running && !r.superseded
      ? "info"
      : r.attention
        ? "bad"
        : completedReview(r)
          ? r.count
            ? "warn"
            : "good"
          : "neutral";
  const progress = (r: ReviewRow) => {
    const done = completedReview(r);
    const triaged = done && (r.finalReview || r.count === 0);
    const failed = !!r.attention && !r.running;
    return [
      { title: "Queued", detail: r.subject, status: "done" as StepStatus },
      {
        title: "Reviewed",
        detail: r.running
          ? "Pair Review is running"
          : `${r.model.split("/").pop()} · ${when(r.updatedAt)}`,
        status: (r.running
          ? "current"
          : failed
            ? "blocked"
            : done
              ? "done"
              : "current") as StepStatus,
      },
      {
        title: "Triage findings",
        detail: done
          ? `${r.count} ${r.count === 1 ? "finding" : "findings"}`
          : "After the review",
        status: (triaged
          ? "done"
          : done && !r.submitted
            ? "current"
            : r.submitted
              ? "done"
              : "todo") as StepStatus,
      },
      {
        title: "Final review",
        detail: r.submitted
          ? "Submitted on GitHub"
          : "Submit on GitHub yourself",
        status: (r.submitted
          ? "done"
          : triaged && !isOutdated(r)
            ? "current"
            : "todo") as StepStatus,
      },
    ];
  };
  const openBriefing = (briefing: Details["briefing"]) => {
    if (!briefing.file || !briefing.hostId) return;
    const accepted = navigate.experimental_openFilePreview({
      target: { kind: "host", hostId: briefing.hostId, path: briefing.file },
      location: null,
    });
    if (!accepted)
      setActionError("BB could not open the briefing in the side panel.");
  };
  const feedbackPanel = (feedback: Details["feedback"], intro: string) => (
    <section className="pr-panel" aria-labelledby="pr-feedback-title">
      <div className="pr-panel-heading">
        <h2 id="pr-feedback-title">Human PR feedback</h2>
        <Badge>{feedback.complete ? "Complete snapshot" : "Unavailable"}</Badge>
      </div>
      <p className="pr-panel-caption">{intro}</p>
      {!feedback.comments.length && (
        <p className="text-muted-foreground">
          {feedback.complete
            ? "No unresolved human feedback was found."
            : feedback.error || "Human feedback is unavailable."}
        </p>
      )}
      {feedback.comments.map((c, i) => (
        <article className="pr-feedback" key={i}>
          <div className="pr-heading">
            <h3>
              {c.author} · {c.location}
            </h3>
            {c.disposition && <Badge>{label(c.disposition)}</Badge>}
          </div>
          <Markdown content={c.body} />
          {c.reason && (
            <p className="text-sm text-muted-foreground">
              Resolver: {c.reason}
            </p>
          )}
        </article>
      ))}
    </section>
  );
  return (
    <TooltipProvider delayDuration={300}>
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
            <header className="pr-page-header">
              <div className="pr-page-title">
                <h1>Pair Review</h1>
                <div className="pr-health text-sm text-muted-foreground">
                  <span className="pr-health-source">
                    <span
                      className={`pr-dot ${data?.health.ready ? "pr-dot-ready" : ""}`}
                    />
                    {data?.health.repository ? (
                      <a
                        className="pr-repository-link"
                        href={data.health.repository.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Pair Review ${data.health.version ?? "unknown"} · ${data.health.provider ?? "pi"} ${data.health.reviewModel ?? ""} · shared database · port ${data.health.port}`}
                      >
                        {data.health.repository.name}
                        <Icon name="ExternalLink" className="size-3" />
                      </a>
                    ) : data ? (
                      "Pair Review"
                    ) : (
                      "Checking Pair Review…"
                    )}
                  </span>
                  {data && (
                    <span
                      className="pr-health-updated"
                      title={
                        data.queueRefreshedAt
                          ? `Last refreshed ${when(data.queueRefreshedAt)}`
                          : undefined
                      }
                    >
                      {data.queueRefreshedAt &&
                      relativeRefreshedAt(data.queueRefreshedAt)
                        ? `Refreshed ${relativeRefreshedAt(data.queueRefreshedAt)}`
                        : "Not refreshed yet"}
                    </span>
                  )}
                </div>
              </div>
              <div className="pr-quick-start">
                <form
                  className="pr-quick-start-form"
                  aria-label="Start a Pair Review"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run("start", () => start(urls.trim().split(/\s+/)));
                  }}
                >
                  <Input
                    className="pr-quick-start-input"
                    value={urls}
                    onChange={(e) => setUrls(e.target.value)}
                    placeholder="Paste GitHub PR URLs to review"
                    aria-label="GitHub pull request URLs"
                    aria-describedby="pr-quick-start-help"
                  />
                  <Action
                    type="submit"
                    size="sm"
                    icon="Play"
                    disabled={!!busy || !urls.trim() || !data?.health.ready}
                  >
                    Start Pair Review
                  </Action>
                  <Action
                    type="button"
                    variant="outline"
                    size="sm"
                    icon="RotateCcw"
                    disabled={!!busy || queueLoading || !!limitedUntil}
                    onClick={() => void refreshQueue()}
                  >
                    {refreshLabel(queueLoading)}
                  </Action>
                </form>
                <div className="pr-quick-start-meta">
                  <span id="pr-quick-start-help">
                    Separate several URLs with spaces. PR Briefings starts
                    alongside when enabled.
                  </span>
                  <button
                    type="button"
                    className="pr-text-button"
                    onClick={() => setLocalOpen(true)}
                  >
                    Review a local branch…
                  </button>
                </div>
              </div>
            </header>
            {data?.health.error && (
              <Callout
                tone="bad"
                role="alert"
                title="Pair Review needs attention"
              >
                <details className="pr-health-error">
                  <summary className="text-sm">Show the error</summary>
                  <p className="text-sm text-muted-foreground">
                    {data.health.error}
                  </p>
                </details>
              </Callout>
            )}
            {(error || actionError) && (
              <div
                className="pr-error text-destructive border border-border"
                role="alert"
              >
                {error || actionError}
                <Action
                  variant="outline"
                  size="sm"
                  onClick={() => void refresh()}
                >
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
              className="pr-frame pr-summary"
              aria-label="Review summary"
            >
              <MetricRow>
                <Metric
                  label="PR queue"
                  value={queue.length}
                  note={
                    data?.health.teams?.length || data?.health.teammates?.length
                      ? `${fromTeam} from your team`
                      : "Requests, assignments and your PRs"
                  }
                  tone="info"
                  active={tab === "queue"}
                  onClick={() => setTab("queue")}
                />
                {running.length > 0 && (
                  <Metric
                    label="Running"
                    value={running.length}
                    note="Keeps going if you leave"
                    tone="info"
                    active={tab === "running"}
                    onClick={() => setTab("running")}
                  />
                )}
                <Metric
                  label="Needs attention"
                  value={attention.length}
                  note="Failed or unverifiable runs"
                  tone={attention.length ? "warn" : "neutral"}
                  active={tab === "attention"}
                  onClick={() => setTab("attention")}
                />
                <Metric
                  label="Final review"
                  value={finalReviewRows.length}
                  note="Every finding triaged"
                  tone={finalReviewRows.length ? "good" : "neutral"}
                  active={tab === "final"}
                  onClick={() => setTab("final")}
                />
                <Metric
                  label="Recent reviews"
                  value={recentRows.length}
                  note="Retained results"
                  active={tab === "recent"}
                  onClick={() => setTab("recent")}
                />
              </MetricRow>
              {requestParts.length > 1 && (
                <SegmentedBar
                  parts={requestParts}
                  unit="PRs"
                  selected={tab === "queue" && filter !== "All" ? filter : null}
                  onSelect={(id) => {
                    setFilter(filter === id && tab === "queue" ? "All" : id);
                    setTab("queue");
                  }}
                />
              )}
            </section>
            <Dialog open={localOpen} onOpenChange={setLocalOpen}>
              <DialogContent className="sm:max-w-[600px]">
                <DialogHeader>
                  <DialogTitle>Review a local branch</DialogTitle>
                  <DialogDescription>
                    Review committed changes from a branch that already exists
                    on this computer. Publication is disabled for local reviews.
                  </DialogDescription>
                </DialogHeader>
                <div className="pr-local-guidance text-sm text-muted-foreground">
                  Pair Review compares the committed tip of your branch with a
                  base ref. Uncommitted changes are not included. At the
                  repository root, run <code>pwd</code> for the checkout path
                  and <code>git branch --show-current</code> for the branch
                  name.
                </div>
                <form
                  className="pr-local-dialog-form"
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
                      setLocalOpen(false);
                      navigate.toPluginPanel("reviews", {
                        subPath: `${result.batchId}/0`,
                      });
                    });
                  }}
                >
                  <label className="pr-local-field pr-local-path">
                    <span>Absolute checkout path</span>
                    <Input
                      placeholder="/Users/you/Code/repository"
                      aria-label="Local checkout path"
                      aria-describedby="pr-local-path-help"
                      value={local.path}
                      onChange={(e) =>
                        setLocal({ ...local, path: e.target.value })
                      }
                    />
                    <small
                      id="pr-local-path-help"
                      className="text-muted-foreground"
                    >
                      Full path to the local Git checkout; use <code>pwd</code>{" "}
                      at its root.
                    </small>
                  </label>
                  <label className="pr-local-field">
                    <span>Branch</span>
                    <Input
                      placeholder="feature/my-change"
                      aria-label="Local branch"
                      aria-describedby="pr-local-branch-help"
                      value={local.branch}
                      onChange={(e) =>
                        setLocal({ ...local, branch: e.target.value })
                      }
                    />
                    <small
                      id="pr-local-branch-help"
                      className="text-muted-foreground"
                    >
                      Local branch containing the committed changes to review.
                    </small>
                  </label>
                  <label className="pr-local-field">
                    <span>
                      Base ref{" "}
                      <span className="text-muted-foreground">(optional)</span>
                    </span>
                    <Input
                      placeholder="origin/main"
                      aria-label="Local base"
                      aria-describedby="pr-local-base-help"
                      value={local.base}
                      onChange={(e) =>
                        setLocal({ ...local, base: e.target.value })
                      }
                    />
                    <small
                      id="pr-local-base-help"
                      className="text-muted-foreground"
                    >
                      Compare from this ref, such as <code>origin/main</code>.
                      Blank uses <code>origin/HEAD</code>.
                    </small>
                  </label>
                  <DialogFooter className="pr-local-dialog-footer">
                    <Action
                      type="button"
                      variant="outline"
                      onClick={() => setLocalOpen(false)}
                    >
                      Cancel
                    </Action>
                    <Action
                      type="submit"
                      icon="Play"
                      disabled={
                        !!busy ||
                        !local.path ||
                        !local.branch ||
                        !data?.health.ready
                      }
                    >
                      Confirm local review
                    </Action>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
            <section className="pr-frame" aria-label="Pair Review lists">
              <Tabs
                label="Pair Review lists"
                tabs={overviewTabs}
                value={tab}
                onChange={setTab}
              >
                {tab === "queue" && (
                  <section
                    id="pr-queue"
                    className="pr-panel"
                    aria-labelledby="pr-queue-title"
                  >
                    <h2 id="pr-queue-title" className="sr-only">
                      PR Queue
                    </h2>
                    <p className="pr-panel-caption">
                      Review requests, assigned PRs, and authored PRs not
                      already represented in another list.
                    </p>
                    {queueError && isRateLimitError(queueError) ? (
                      <RateLimitNotice
                        status={githubLimit}
                        what={
                          data?.queueRefreshedAt
                            ? "The queue below is from your last refresh."
                            : "Refresh then to load your pull requests."
                        }
                      />
                    ) : queueError ? (
                      <div
                        className="pr-error text-destructive border border-border"
                        role="alert"
                      >
                        GitHub queue could not be refreshed: {queueError}
                        <Action
                          variant="outline"
                          size="sm"
                          disabled={queueLoading}
                          onClick={() => void refreshQueue()}
                        >
                          Retry PR discovery
                        </Action>
                      </div>
                    ) : null}
                    <div className="pr-toolbar" aria-label="PR queue filters">
                      <div
                        className="pr-filters"
                        role="group"
                        aria-label="Request type"
                      >
                        {queueFilters.map(([t, title]) => (
                          <button
                            type="button"
                            key={t}
                            className="pr-filter"
                            aria-pressed={filter === t}
                            onClick={() => setFilter(t)}
                          >
                            {title}
                            <span className="pr-filter-count">
                              {t === "All"
                                ? repoQueue.length
                                : repoQueue.filter((q) => q.tags.includes(t))
                                    .length}
                            </span>
                          </button>
                        ))}
                      </div>
                      <div className="pr-queue-tools">
                        <Picker
                          label="Filter by repository"
                          value={repoFilter}
                          onChange={setRepoFilter}
                          className="pr-repo-picker"
                          options={[
                            { value: "All", label: "All repositories" },
                            ...repositories.map((repo) => ({
                              value: repo,
                              label: repo,
                            })),
                          ]}
                        />
                        <Input
                          className="pr-search"
                          placeholder="Search title, number or author"
                          aria-label="Search PR queue"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                        <span className="pr-toolbar-spacer" />
                        <span className="pr-visible-count">
                          {filtered.length} visible
                        </span>
                        <Action
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setSelected(new Set(filtered.map((q) => q.key)))
                          }
                        >
                          Select visible
                        </Action>
                        <Action
                          size="sm"
                          variant="ghost"
                          disabled={!selected.size}
                          onClick={() => setSelected(new Set())}
                        >
                          Clear selection
                        </Action>
                        <Action
                          size="sm"
                          icon="Layers"
                          disabled={
                            !selectedQueue.length ||
                            !!busy ||
                            !data?.health.ready
                          }
                          onClick={() =>
                            void run("batch", () =>
                              start(selectedQueue.map((q) => q.url)),
                            )
                          }
                        >
                          Review selected ({selectedQueue.length})
                        </Action>
                      </div>
                    </div>
                    {filtered.length > 0 && (
                      <div className="pr-rows" aria-busy={queueLoading}>
                        <div
                          className="pr-row pr-queue-row pr-row-header"
                          aria-hidden="true"
                        >
                          <span />
                          <span>Pull request</span>
                          <span>Request</span>
                          <span>Size</span>
                          <span>Updated</span>
                          <span>Status</span>
                          <span />
                        </div>
                        {filtered.map(queueRow)}
                      </div>
                    )}
                    {!filtered.length && (
                      <Empty>
                        {!data || queueLoading
                          ? "Loading your GitHub PR queue…"
                          : queueError
                            ? "PR discovery failed. Retry above; no partial queue was saved."
                            : data.queueRefreshedAt == null
                              ? "No saved queue yet. Choose Refresh from GitHub to load your pull requests."
                              : search
                                ? "No matching PRs."
                                : queue.length
                                  ? "No PRs match this filter."
                                  : "No open PRs match your review requests, assignments, or authorship. Current reviews may be hidden in settings."}
                      </Empty>
                    )}
                  </section>
                )}
                {tab === "running" &&
                  reviewPanel(
                    "running",
                    "Running",
                    "Closing this page does not cancel a running batch.",
                    running,
                    "No reviews are running.",
                  )}
                {tab === "recent" &&
                  reviewPanel(
                    "recent",
                    "Recent reviews",
                    "Completed reviews and historical attempts. Results stay local.",
                    recentRows,
                    "No retained reviews yet.",
                  )}
                {tab === "final" &&
                  reviewPanel(
                    "final",
                    "Final Review",
                    "Reviewed PRs with no findings or with every finding accepted or dismissed.",
                    finalReviewRows,
                    "No PRs are ready for final review.",
                  )}
                {tab === "attention" &&
                  reviewPanel(
                    "attention",
                    "Needs attention",
                    "Preserved work, stale refs, and validation needs.",
                    attention,
                    "Nothing needs attention.",
                  )}

                {tab === "dismissed" &&
                  reviewPanel(
                    "dismissed",
                    "Dismissed runs",
                    "Hidden from active lists. Evidence remains retained and can be restored.",
                    dismissedRows,
                    "No dismissed runs.",
                  )}
              </Tabs>
            </section>
            {data && (
              <section className="pr-frame" aria-label="Setup health">
                <Disclosure
                  open={healthOpen}
                  onToggle={() => setHealthOpen(!healthOpen)}
                  header={
                    <span className="pr-disclosure-header">
                      <Chevron open={healthOpen} />
                      <strong>Setup health</strong>
                      <DotLabel tone={data.health.ready ? "good" : "bad"}>
                        {data.health.ready ? "Ready" : "Not ready"}
                      </DotLabel>
                    </span>
                  }
                >
                  {() => (
                    <div className="pr-health-details">
                      <KeyValue
                        pairs={[
                          [
                            "Pair Review",
                            `${data.health.version ?? "unknown version"}${data.health.databaseSchema ? ` · schema ${data.health.databaseSchema}` : ""}`,
                          ],
                          [
                            "Review",
                            `${data.health.provider ?? "pi"} · ${data.health.reviewModel ?? data.preferences.reviewModel}`,
                          ],
                          [
                            "Resolver",
                            `${data.health.resolverProvider ?? "pi"} · ${data.health.fixModel ?? data.preferences.fixModel}`,
                          ],
                          [
                            "Teams",
                            data.health.teams?.length
                              ? data.health.teams.join(", ")
                              : "None configured",
                          ],
                          [
                            "Teammates",
                            data.health.teammates?.length
                              ? `${data.health.teammates.length} configured`
                              : "None configured",
                          ],
                          [
                            "Database",
                            `Shared${data.health.port ? ` · port ${data.health.port}` : ""}`,
                          ],
                          [
                            "GitHub API",
                            githubLimits?.core
                              ? `${githubLimits.core.remaining.toLocaleString()} of ${githubLimits.core.limit.toLocaleString()} requests left · resets ${describeReset(githubLimits.core.resetAt)}`
                              : "Checking…",
                          ],
                          [
                            "GitHub search",
                            githubLimits?.search
                              ? `${githubLimits.search.remaining} of ${githubLimits.search.limit} searches left · resets ${describeReset(githubLimits.search.resetAt)}`
                              : "Checking…",
                          ],
                        ]}
                      />
                    </div>
                  )}
                </Disclosure>
              </section>
            )}
          </div>
        )}
        {detailOpen && (
          <main className="pr-detail border-border">
            <Action
              variant="ghost"
              size="sm"
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
            {detailsError && isRateLimitError(detailsError) ? (
              <RateLimitNotice
                status={githubLimit}
                what="This page loads once it can reach GitHub again."
                action={
                  <div className="pr-actions">
                    <Action
                      variant="outline"
                      size="sm"
                      disabled={!!limitedUntil}
                      onClick={() => reloadDetailsRef.current?.()}
                    >
                      Retry
                    </Action>
                  </div>
                }
              />
            ) : detailsError ? (
              <div role="alert" className="pr-error text-destructive">
                <p>{detailsError}</p>
                <Action
                  variant="outline"
                  size="sm"
                  onClick={() => reloadDetailsRef.current?.()}
                >
                  Retry
                </Action>
              </div>
            ) : null}
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
                  <p className="pr-detail-meta">
                    {prInfo.subject} · {prInfo.author} ·{" "}
                    <code>{prInfo.branch}</code> → latest discovered head{" "}
                    <code title={prInfo.head}>{short(prInfo.head)}</code>
                  </p>
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
                        variant="outline"
                        icon="RotateCcw"
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
                      variant="ghost"
                      icon="RotateCcw"
                      disabled={queueLoading || !!limitedUntil}
                      onClick={refreshFromGitHub}
                    >
                      {refreshLabel(queueLoading)}
                    </Action>
                  </div>
                </header>
                <section className="pr-frame" aria-label="At a glance">
                  <MetricRow>
                    <ChangeMetric changes={prInfo.changes} />
                    <Metric
                      label="Human feedback"
                      value={prFeedback?.comments.length ?? 0}
                      note={
                        prFeedback?.complete
                          ? "Unresolved comments"
                          : "Snapshot unavailable"
                      }
                    />
                    <Metric
                      label="Pair Review"
                      value="Not reviewed"
                      note="Opening Details never starts analysis"
                    />
                  </MetricRow>
                </section>
                {prBriefing && (
                  <BriefingCard
                    briefing={prBriefing}
                    busy={!!busy}
                    onOpen={() => openBriefing(prBriefing)}
                    onOpenThread={() => {
                      if (prBriefing.threadId)
                        navigate.toThread(prBriefing.threadId);
                    }}
                    onGenerate={() =>
                      void run("brief", () =>
                        rpc.call("briefingGenerate", { url: prInfo.url }),
                      )
                    }
                  />
                )}
                <section
                  className="pr-frame"
                  aria-labelledby="pr-summary-title"
                >
                  <h2 id="pr-summary-title">Review summary</h2>
                  <p>
                    No retained review is available for this PR. Opening Details
                    does not start a review. Choose Review latest changes to run
                    Pair Review on the current committed changes.
                  </p>
                </section>
                <section className="pr-frame" aria-label="Pull request details">
                  <Tabs
                    label="Pull request details"
                    value={activeDetailTab}
                    onChange={setDetailTab}
                    tabs={[
                      {
                        id: "changes",
                        label: "Changes",
                        count: prPatches.length,
                      },
                      {
                        id: "feedback",
                        label: "Feedback",
                        count: prFeedback?.comments.length ?? 0,
                      },
                      { id: "resolver", label: "Resolver loop" },
                    ]}
                  >
                    {activeDetailTab === "changes" && (
                      <CodeChanges
                        patches={prPatches}
                        selectedFile={selectedFile}
                        onSelectedFile={setSelectedFile}
                        error={prPatchError}
                      />
                    )}
                    {activeDetailTab === "feedback" &&
                      (prFeedback ? (
                        feedbackPanel(
                          prFeedback,
                          "Read-only unresolved review threads, review summaries, and PR conversation from people other than the PR author.",
                        )
                      ) : (
                        <Empty>Human feedback is unavailable.</Empty>
                      ))}
                    {activeDetailTab === "resolver" && (
                      <section
                        className="pr-panel"
                        aria-labelledby="pr-resolver-title"
                      >
                        <div className="pr-panel-heading">
                          <h2 id="pr-resolver-title">Resolver loop</h2>
                          <Badge>
                            {prFeedback?.comments.length ?? 0} comments
                          </Badge>
                        </div>
                        <p className="pr-panel-caption">
                          A resolver loop can begin from existing human feedback
                          without first running Pair Review. It judges each
                          comment for factual correctness, relevance, and PR
                          scope before editing, then uses Pair Review for each
                          follow-up gate.
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
                    )}
                  </Tabs>
                </section>
              </>
            )}
            {details && detailRow && data && (
              <>
                <header className="pr-detail-header">
                  <div className="pr-heading">
                    <h1>{detailRow.title}</h1>
                    {detailRow.running || busy === "latest" ? (
                      <RunningIndicator />
                    ) : detailRow.dismissed ? (
                      <Badge>Dismissed</Badge>
                    ) : detailRow.attention ? (
                      <Badge tone="danger">Needs attention</Badge>
                    ) : completedReview(detailRow) ? (
                      <span className="pr-statuses">
                        <FindingCount count={detailRow.count} />
                        {isOutdated(detailRow) && (
                          <Badge tone="finding">Outdated</Badge>
                        )}
                      </span>
                    ) : (
                      <Badge>{label(detailRow.reviewState)}</Badge>
                    )}
                  </div>
                  <p className="pr-detail-meta">
                    {detailRow.subject} · {detailRow.author}
                    {detailRow.branch && (
                      <>
                        {" "}
                        · <code>{detailRow.branch}</code>
                      </>
                    )}{" "}
                    →{" "}
                    <code title={detailRow.head}>{short(detailRow.head)}</code>{" "}
                    · {when(detailRow.updatedAt)} ·{" "}
                    {data.health.provider ?? "pi"} · {detailRow.model}
                  </p>
                  <div className="pr-actions">
                    {detailRow.url && (
                      <Action
                        icon="Play"
                        disabled={!!busy || detailRow.running}
                        onClick={() =>
                          void run("latest", () =>
                            start([detailRow.url!], false),
                          )
                        }
                      >
                        {detailRow.attention
                          ? "Start fresh review"
                          : "Review latest changes"}
                      </Action>
                    )}
                    {detailRow.canResolve && (
                      <Action
                        variant="outline"
                        icon="RotateCcw"
                        disabled={!!busy || detailRow.running}
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
                            batchId: detailRow.batchId,
                            index: detailRow.index,
                          });
                          navigate.openUrl(url);
                        })
                      }
                    >
                      Open Pair Review
                    </Action>
                    {detailRow.url && (
                      <Action
                        variant="outline"
                        icon="GitPullRequest"
                        onClick={() => navigate.openUrl(detailRow.url!)}
                      >
                        Pull request
                      </Action>
                    )}
                    {detailRow.running && (
                      <Action
                        variant="outline"
                        disabled={!!busy}
                        onClick={() =>
                          void run("cancel", () => action(detailRow, "cancel"))
                        }
                      >
                        Stop review
                      </Action>
                    )}
                    {detailRow.running && (
                      <Action
                        variant="outline"
                        disabled={!!busy}
                        onClick={() =>
                          void run("recover", () =>
                            action(detailRow, "recover"),
                          )
                        }
                      >
                        Recover if stopped
                      </Action>
                    )}
                    {detailRow.url && (
                      <Action
                        variant="ghost"
                        icon="RotateCcw"
                        disabled={queueLoading || !!limitedUntil}
                        onClick={refreshFromGitHub}
                      >
                        {refreshLabel(queueLoading)}
                      </Action>
                    )}
                    {!detailRow.running &&
                      (detailRow.dismissed ? (
                        <Action
                          variant="outline"
                          disabled={!!busy}
                          onClick={() =>
                            void run("restore", () =>
                              action(detailRow, "restore"),
                            )
                          }
                        >
                          Restore run
                        </Action>
                      ) : (
                        <Action
                          variant="ghost"
                          icon="Archive"
                          disabled={!!busy}
                          onClick={() =>
                            void run("dismiss", async () => {
                              if (await action(detailRow, "dismiss"))
                                navigate.toPluginPanel("reviews");
                            })
                          }
                        >
                          Dismiss run
                        </Action>
                      ))}
                  </div>
                </header>
                <section
                  className="pr-frame pr-summary"
                  aria-label="At a glance"
                >
                  <MetricRow>
                    <Metric
                      label="Findings"
                      value={completedReview(detailRow) ? actionableCount : "—"}
                      note={
                        completedReview(detailRow)
                          ? praiseCount
                            ? `+ ${praiseCount} praise`
                            : "Actionable"
                          : "No verified results yet"
                      }
                      tone={
                        completedReview(detailRow) && actionableCount
                          ? "warn"
                          : "neutral"
                      }
                      active={activeDetailTab === "findings"}
                      onClick={() => setDetailTab("findings")}
                    />
                    <ChangeMetric
                      changes={details.changes}
                      active={activeDetailTab === "changes"}
                      onClick={() => setDetailTab("changes")}
                    />
                    <Metric
                      label="Attempts"
                      value={attempts.length}
                      note={(() => {
                        const failed = attempts.filter(
                          (r) => r.reviewState === "needs_attention",
                        ).length;
                        return failed ? `${failed} failed` : "None failed";
                      })()}
                      active={activeDetailTab === "history"}
                      onClick={() => setDetailTab("history")}
                    />
                    <Metric
                      label="Freshness"
                      value={
                        !queueEntry
                          ? "Not in queue"
                          : isOutdated(detailRow)
                            ? "New commits"
                            : "Current"
                      }
                      note={
                        !queueEntry
                          ? "Closed, merged or local"
                          : isOutdated(detailRow)
                            ? `GitHub head is now ${short(queueEntry.head)}`
                            : "Head unchanged since review"
                      }
                      tone={
                        !queueEntry
                          ? "neutral"
                          : isOutdated(detailRow)
                            ? "warn"
                            : "good"
                      }
                    />
                  </MetricRow>
                  <Steps label="Review progress" items={progress(detailRow)} />
                </section>
                {detailRow.attention && (
                  <section
                    className="pr-frame pr-attention-card"
                    aria-labelledby="pr-attention-title"
                  >
                    <Callout
                      tone="bad"
                      title={
                        <h2 id="pr-attention-title">
                          {detailRow.reviewState === "needs_attention"
                            ? "Review could not finish"
                            : "Human decision required"}
                        </h2>
                      }
                    >
                      <p>
                        {detailRow.reviewState === "needs_attention"
                          ? "Pair Review stopped before it could produce verified findings. Start a fresh review or inspect the technical details below."
                          : "This review has retained work that needs a person to inspect before continuing."}
                      </p>
                    </Callout>
                    <details className="pr-diagnostics">
                      <summary>Technical details</summary>
                      <p className="text-destructive">{detailRow.attention}</p>
                      <p>
                        Reviewed head: <code>{detailRow.head}</code>
                      </p>
                      {detailRow.path && (
                        <p className="pr-path">
                          Work preserved at:{" "}
                          <FileLink
                            target={{
                              kind: "host",
                              hostId: data.hostId,
                              path: detailRow.path,
                            }}
                          >
                            {detailRow.path}
                          </FileLink>
                        </p>
                      )}
                    </details>
                    <div className="pr-actions">
                      {detailRow.canAttempt && !detailRow.url && (
                        <Action
                          variant="outline"
                          disabled={!!busy || detailRow.running}
                          onClick={() =>
                            void run("attempt", () =>
                              action(detailRow, "attempt"),
                            )
                          }
                        >
                          Fresh review attempt
                        </Action>
                      )}
                      {detailRow.canRetry && (
                        <Action
                          variant="outline"
                          disabled={!!busy || detailRow.running}
                          onClick={() =>
                            void run("retry", () => action(detailRow, "retry"))
                          }
                        >
                          Retry optional resolution
                        </Action>
                      )}
                      {detailRow.canValidate && (
                        <Action
                          disabled={!!busy || detailRow.running}
                          onClick={() =>
                            void run("validate", () =>
                              action(detailRow, "validate"),
                            )
                          }
                        >
                          {detailRow.publish
                            ? "Publish human-validated fixes"
                            : "Commit human-validated fixes locally"}
                        </Action>
                      )}
                    </div>
                  </section>
                )}
                {detailRow.resolverError && !detailRow.attention && (
                  <section
                    className="pr-frame"
                    aria-labelledby="pr-resolver-error-title"
                  >
                    <Callout
                      tone="warn"
                      title={
                        <h2 id="pr-resolver-error-title">
                          Review completed; resolver run failed
                        </h2>
                      }
                    >
                      <p>
                        Pair Review completed successfully. Its findings remain
                        available; no resolver fixes were accepted.
                      </p>
                      <p className="text-destructive">
                        {detailRow.resolverError}
                      </p>
                      {detailRow.path && (
                        <p className="pr-path">
                          Resolver checkout retained for diagnostics at:{" "}
                          <FileLink
                            target={{
                              kind: "host",
                              hostId: data.hostId,
                              path: detailRow.path,
                            }}
                          >
                            {detailRow.path}
                          </FileLink>
                        </p>
                      )}
                    </Callout>
                    {detailRow.canRetry && (
                      <div className="pr-actions">
                        <Action
                          variant="outline"
                          disabled={!!busy || detailRow.running}
                          onClick={() =>
                            void run("retry", () => action(detailRow, "retry"))
                          }
                        >
                          Retry optional resolution
                        </Action>
                      </div>
                    )}
                  </section>
                )}
                <BriefingCard
                  briefing={details.briefing}
                  busy={!!busy}
                  onOpen={() => openBriefing(details.briefing)}
                  onOpenThread={() => {
                    if (details.briefing.threadId)
                      navigate.toThread(details.briefing.threadId);
                  }}
                  onGenerate={() => {
                    if (!detailRow.url) return;
                    void run("brief", () =>
                      rpc.call("briefingGenerate", { url: detailRow.url! }),
                    );
                  }}
                />
                {detailRow.reviewState !== "needs_attention" && (
                  <section
                    className="pr-frame"
                    aria-labelledby="pr-summary-title"
                  >
                    <h2 id="pr-summary-title">Review summary</h2>
                    <p>{details.summary}</p>
                    {isOutdated(detailRow) && (
                      <p className="text-destructive">
                        This review describes an earlier PR head. Review latest
                        changes before using these findings.
                      </p>
                    )}
                  </section>
                )}
                <section className="pr-frame" aria-label="Review details">
                  <Tabs
                    label="Review details"
                    value={activeDetailTab}
                    onChange={setDetailTab}
                    tabs={[
                      {
                        id: "findings",
                        label: "Findings",
                        count: details.findings.length,
                      },
                      {
                        id: "changes",
                        label: "Changes",
                        count: details.patches.length,
                      },
                      {
                        id: "feedback",
                        label: "Feedback",
                        count: details.feedback.comments.length,
                      },
                      { id: "activity", label: "Resolver activity" },
                      {
                        id: "history",
                        label: "History",
                        count: attempts.length,
                      },
                    ]}
                  >
                    {activeDetailTab === "findings" &&
                      (details.findings.length ? (
                        <FindingsReport
                          key={detailRow.id}
                          findings={details.findings}
                          hostId={data.hostId}
                        />
                      ) : (
                        <Empty>No findings for this run.</Empty>
                      ))}
                    {activeDetailTab === "changes" && (
                      <CodeChanges
                        patches={details.patches}
                        selectedFile={selectedFile}
                        onSelectedFile={setSelectedFile}
                      />
                    )}
                    {activeDetailTab === "feedback" &&
                      feedbackPanel(
                        details.feedback,
                        "Read-only snapshot of unresolved review threads, review summaries, and PR conversation from people other than the PR author. On a PR you own, a manual resolver loop can disposition every item for truth, relevance, and scope; nothing is posted to GitHub.",
                      )}
                    {activeDetailTab === "activity" && (
                      <section
                        className="pr-panel"
                        aria-labelledby="pr-activity-title"
                      >
                        <div className="pr-panel-heading">
                          <h2 id="pr-activity-title">Resolver activity</h2>
                          <Badge>{label(detailRow.resolverState)}</Badge>
                        </div>
                        <p className="pr-panel-caption">
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
                    )}
                    {activeDetailTab === "history" && (
                      <section
                        className="pr-panel"
                        aria-labelledby="pr-history-title"
                      >
                        <h2 id="pr-history-title" className="sr-only">
                          Review history
                        </h2>
                        <p className="pr-panel-caption">
                          Every retained attempt for this pull request, newest
                          first. Results stay local.
                        </p>
                        <Timeline
                          label="Review attempts"
                          items={attempts.map((r) => ({
                            key: r.id,
                            time: when(r.updatedAt),
                            title: attemptTitle(r),
                            tone: attemptTone(r),
                            current: r.id === detailRow.id,
                            onOpen: () => open(r),
                            detail: [
                              r.model,
                              `attempt ${r.attempt}`,
                              short(r.head),
                              r.submitted ? "submitted" : null,
                              r.dismissed ? "dismissed" : null,
                              r.superseded ? "historical" : null,
                            ]
                              .filter(Boolean)
                              .join(" · "),
                          }))}
                        />
                      </section>
                    )}
                  </Tabs>
                </section>
              </>
            )}
          </main>
        )}
      </div>
    </TooltipProvider>
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
        operation. Set <strong>Pair Review installation</strong> to{" "}
        <code>pair-review</code> for the original installed app on the BB server
        PATH, or to an absolute or <code>~/</code> directory for a compatible
        local fork. Choose the native Pair Review provider used for analysis and
        a separately guarded resolver provider. A legacy{" "}
        <code>~/.pair-review/pi-settings.json</code> may still supply team and
        teammate metadata, but plugin settings control providers and models.
        Provider and GitHub credentials remain in their native stores; this
        plugin does not store secret settings.
      </p>
      <div>
        <Action
          variant="outline"
          disabled={busy}
          onClick={async () => {
            if (
              !window.confirm("Reset every Pair Review setting to its default?")
            )
              return;
            setBusy(true);
            setMessage("");
            try {
              await rpc.call("resetSettings");
              setMessage(
                "Defaults restored. Reopen Pair Review settings to refresh the fields above.",
              );
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
