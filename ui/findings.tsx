// The retained findings of one review, grouped by file or severity.
//
// Adapted from the Findings component of bb-plugin-genui
// (https://github.com/ComicBit/bb-plugin-genui), Copyright ComicBit, licensed
// under the Apache License, Version 2.0; see licenses/bb-plugin-genui-LICENSE.
// Modifications: reads Pair Review findings (kind, severity, suggestion,
// disposition, retained source path) instead of tool reports; adds the
// Actionable/Praise filter; links into the retained checkout through BB.
import { useMemo, useState } from "react";
import {
  Markdown,
  experimental_FileLink as FileLink,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Details } from "../contract";
import {
  Chevron,
  Disclosure,
  FOCUS_RING,
  Pill,
  Segmented,
  TONE_DOT,
  type Tone,
} from "./kit";

export type Finding = Details["findings"][number];
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export const SEVERITIES: readonly Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

const SEVERITY_ALIASES: Record<string, Severity> = {
  critical: "critical",
  blocker: "critical",
  fatal: "critical",
  high: "high",
  major: "high",
  error: "high",
  severe: "high",
  medium: "medium",
  moderate: "medium",
  warning: "medium",
  warn: "medium",
  low: "low",
  minor: "low",
  nit: "low",
  trivial: "low",
  info: "info",
  note: "info",
};

export const isPraise = (finding: Finding) =>
  finding.kind?.toLowerCase() === "praise";

/** Pair Review's own words (`major`, `minor`) on one five-step scale. */
export function severityOf(finding: Finding): Severity {
  if (isPraise(finding)) return "info";
  return SEVERITY_ALIASES[finding.severity?.toLowerCase() ?? ""] ?? "info";
}

const SEVERITY_STYLE: Record<
  Severity,
  { icon: string; ink: string; fill: string; tone: Tone }
> = {
  critical: {
    icon: "AlertCircle",
    ink: "text-destructive",
    fill: "bg-destructive",
    tone: "bad",
  },
  high: {
    icon: "CircleX",
    ink: "text-destructive",
    fill: "bg-destructive/70",
    tone: "bad",
  },
  medium: {
    icon: "AlertTriangle",
    ink: "text-warning-text",
    fill: "bg-warning",
    tone: "warn",
  },
  low: {
    icon: "Info",
    ink: "text-[var(--color-timeline-accent,var(--primary))]",
    fill: "bg-[var(--color-timeline-accent,var(--primary))]",
    tone: "info",
  },
  info: {
    icon: "Info",
    ink: "text-muted-foreground",
    fill: "bg-muted-foreground/40",
    tone: "neutral",
  },
};

export const severityTone = (severity: Severity) =>
  SEVERITY_STYLE[severity].tone;

/** The edge color of an open finding: its severity, or green for praise. */
function accentOf(finding: Finding): string {
  if (isPraise(finding)) return "var(--success)";
  switch (severityOf(finding)) {
    case "critical":
    case "high":
      return "var(--destructive)";
    case "medium":
      return "var(--warning)";
    case "low":
      return "var(--color-timeline-accent,var(--primary))";
    default:
      return "color-mix(in oklch, var(--muted-foreground) 55%, transparent)";
  }
}

const label = (value: string) =>
  value.replaceAll("_", " ").replaceAll("-", " ");

function SeverityMark({ finding }: { finding: Finding }) {
  if (isPraise(finding))
    return (
      <Icon
        name="Star"
        aria-hidden
        className="size-3.5 shrink-0 text-success"
      />
    );
  const style = SEVERITY_STYLE[severityOf(finding)];
  return (
    <Icon
      name={style.icon}
      aria-hidden
      className={cn("size-3.5 shrink-0", style.ink)}
    />
  );
}

type Counts = Record<Severity, number>;
function countSeverities(findings: readonly Finding[]): Counts {
  const counts: Counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) counts[severityOf(finding)] += 1;
  return counts;
}

function CountDots({ findings }: { findings: readonly Finding[] }) {
  const counts = countSeverities(findings.filter((f) => !isPraise(f)));
  const praise = findings.filter(isPraise).length;
  return (
    <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
      {SEVERITIES.filter((s) => counts[s] > 0).map((severity) => (
        <span key={severity} className="flex items-center gap-1">
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              SEVERITY_STYLE[severity].fill,
            )}
          />
          {counts[severity]}
          <span className="sr-only"> {severity}</span>
        </span>
      ))}
      {praise ? (
        <span className="flex items-center gap-1">
          <span aria-hidden className="size-1.5 rounded-full bg-success" />
          {praise}
          <span className="sr-only"> praise</span>
        </span>
      ) : null}
    </span>
  );
}

/** A thin bar of actionable findings by severity, with their counts in words. */
export function SeveritySummary({
  findings,
}: {
  findings: readonly Finding[];
}) {
  const actionable = findings.filter((f) => !isPraise(f));
  const praise = findings.length - actionable.length;
  const counts = countSeverities(actionable);
  const present = SEVERITIES.filter((s) => counts[s] > 0);
  const words = present.map((s) => `${counts[s]} ${s}`);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {present.length ? (
        <div
          role="img"
          aria-label={`Actionable findings by severity: ${words.join(", ")}`}
          className="flex h-1.5 w-full gap-[2px] overflow-hidden rounded-full bg-muted"
        >
          {present.map((severity) => (
            <div
              key={severity}
              className={cn(
                "h-full min-w-[3px]",
                SEVERITY_STYLE[severity].fill,
              )}
              style={{ flex: `${counts[severity]} 1 0` }}
            />
          ))}
        </div>
      ) : null}
      <p className="m-0 flex flex-wrap gap-x-4 gap-y-0.5 text-xs leading-5 text-muted-foreground">
        {present.map((severity) => (
          <span key={severity} className="flex items-center gap-1.5">
            <span className={cn("font-medium", SEVERITY_STYLE[severity].ink)}>
              {counts[severity]}
            </span>
            {severity}
          </span>
        ))}
        {praise ? (
          <span className="flex items-center gap-1.5">
            <span className="font-medium text-success">{praise}</span>
            praise
          </span>
        ) : null}
        {!present.length && !praise ? <span>No findings</span> : null}
      </p>
    </div>
  );
}

type Show = "actionable" | "praise" | "all";
type Group = "file" | "severity";

interface FindingGroup {
  key: string;
  title: string;
  severity: Severity | null;
  findings: Finding[];
}

function groupFindings(
  findings: readonly Finding[],
  by: Group,
): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  if (by === "severity") {
    for (const severity of SEVERITIES) {
      const list = findings.filter(
        (f) => !isPraise(f) && severityOf(f) === severity,
      );
      if (list.length)
        groups.set(severity, {
          key: severity,
          title: severity,
          severity,
          findings: list,
        });
    }
    const praise = findings.filter(isPraise);
    if (praise.length)
      groups.set("praise", {
        key: "praise",
        title: "praise",
        severity: null,
        findings: praise,
      });
    return [...groups.values()];
  }
  for (const finding of findings) {
    const key = finding.file || "(no file)";
    const group = groups.get(key) ?? {
      key,
      title: key,
      severity: null,
      findings: [],
    };
    group.findings.push(finding);
    groups.set(key, group);
  }
  // Within a file, the most severe first, then by line.
  const rank = (f: Finding) =>
    isPraise(f) ? SEVERITIES.length : SEVERITIES.indexOf(severityOf(f));
  for (const group of groups.values())
    group.findings.sort(
      (a, b) => rank(a) - rank(b) || (a.line ?? 0) - (b.line ?? 0),
    );
  return [...groups.values()];
}

const location = (finding: Finding) =>
  `${finding.file}${finding.line ? `:${finding.line}` : ""}`;

function FindingBody({
  finding,
  hostId,
}: {
  finding: Finding;
  hostId: string;
}) {
  return (
    <div className="mx-3 mb-3 ml-[34px] flex min-w-0 flex-col gap-3 border-t border-border/60 pt-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-5 text-muted-foreground">
        {isPraise(finding) ? (
          <span className="font-medium text-success">praise</span>
        ) : (
          <span
            className={cn(
              "font-medium",
              SEVERITY_STYLE[severityOf(finding)].ink,
            )}
          >
            {finding.severity ? label(finding.severity) : "unrated"}
          </span>
        )}
        {finding.kind && !isPraise(finding) ? (
          <span>{label(finding.kind)}</span>
        ) : null}
        {finding.sourcePath ? (
          <FileLink
            target={{ kind: "host", hostId, path: finding.sourcePath }}
            location={
              finding.line
                ? { kind: "line", line: finding.line, column: null }
                : undefined
            }
          >
            <span className="inline-flex items-center gap-1">
              <Icon name="FileText" aria-hidden className="size-3" />
              Open retained file
            </span>
          </FileLink>
        ) : null}
      </div>
      <section className="pr-finding-comment flex min-w-0 flex-col gap-1">
        <h4 className="m-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Comment
        </h4>
        <Markdown content={finding.body} />
      </section>
      {finding.suggestion ? (
        <section className="pr-finding-suggestion flex min-w-0 flex-col gap-1 rounded-lg bg-background px-3 py-2.5">
          <h4 className="m-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Suggestion
          </h4>
          <Markdown content={finding.suggestion} />
        </section>
      ) : null}
      {finding.reason ? (
        <p className="m-0 flex min-w-0 gap-2 text-xs leading-5 text-muted-foreground">
          <strong className="font-medium text-foreground">
            Resolution note
          </strong>
          <span className="min-w-0">{finding.reason}</span>
        </p>
      ) : null}
    </div>
  );
}

function FindingRow({
  finding,
  hostId,
  showFile,
  open,
  onToggle,
}: {
  finding: Finding;
  hostId: string;
  showFile: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li
      className={cn(
        "min-w-0 rounded-lg transition-colors duration-150",
        open
          ? "my-1 bg-surface-recessed first:mt-0 last:mb-0"
          : "hover:bg-state-hover",
      )}
      style={
        open ? { boxShadow: `inset 3px 0 0 ${accentOf(finding)}` } : undefined
      }
    >
      <Disclosure
        open={open}
        onToggle={onToggle}
        header={
          <span className="flex w-full min-w-0 items-start gap-2 px-3 py-2">
            <span className="mt-[3px] flex items-center gap-2">
              <Chevron open={open} />
              <SeverityMark finding={finding} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span
                className={cn(
                  "text-[13px] leading-5 text-foreground [overflow-wrap:anywhere]",
                  open ? "font-medium" : "line-clamp-2",
                )}
              >
                {finding.title}
              </span>
              {showFile ? (
                <span
                  className="truncate font-mono text-[11px] leading-4 text-muted-foreground"
                  title={location(finding)}
                >
                  {location(finding)}
                </span>
              ) : null}
            </span>
            {finding.disposition ? (
              <Pill className="mt-0.5">{label(finding.disposition)}</Pill>
            ) : null}
            {!showFile && finding.line ? (
              <span
                className="mt-px shrink-0 font-mono text-[11px] leading-5 tabular-nums text-muted-foreground"
                title={location(finding)}
              >
                :{finding.line}
              </span>
            ) : null}
          </span>
        }
      >
        {() => <FindingBody finding={finding} hostId={hostId} />}
      </Disclosure>
    </li>
  );
}

const TEXT_BUTTON = cn(
  "w-fit shrink-0 cursor-pointer rounded-sm text-xs leading-5 text-muted-foreground transition-colors duration-150 hover:text-foreground",
  FOCUS_RING,
);

/** Every retained finding of a review, filterable and grouped. */
export function FindingsReport({
  findings,
  hostId,
}: {
  findings: readonly Finding[];
  hostId: string;
}) {
  const praiseCount = findings.filter(isPraise).length;
  const actionableCount = findings.length - praiseCount;
  const [show, setShow] = useState<Show>(
    actionableCount ? "actionable" : "all",
  );
  const [group, setGroup] = useState<Group>("file");
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const listed = useMemo(
    () =>
      show === "all"
        ? findings
        : findings.filter((f) =>
            show === "praise" ? isPraise(f) : !isPraise(f),
          ),
    [findings, show],
  );
  const groups = useMemo(() => groupFindings(listed, group), [listed, group]);
  const files = new Set(findings.map((f) => f.file)).size;
  const toggle = (id: number) =>
    setOpened((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allOpen = listed.length > 0 && listed.every((f) => opened.has(f.id));
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col">
        <h2 className="m-0 text-[15px] font-semibold leading-6 tracking-[-0.01em] text-foreground">
          Findings
        </h2>
        <span className="text-xs leading-5 text-muted-foreground">
          Review observations from the exact captured changes ·{" "}
          {findings.length} {findings.length === 1 ? "finding" : "findings"} ·{" "}
          {files} {files === 1 ? "file" : "files"}
        </span>
      </div>
      <SeveritySummary findings={findings} />
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {praiseCount && actionableCount ? (
            <Segmented
              label="Show findings"
              value={show}
              onChange={setShow}
              options={[
                { value: "actionable", label: `Actionable ${actionableCount}` },
                { value: "praise", label: `Praise ${praiseCount}` },
                { value: "all", label: `All ${findings.length}` },
              ]}
            />
          ) : null}
          {findings.length > 1 ? (
            <Segmented
              label="Group findings"
              value={group}
              onChange={setGroup}
              options={[
                { value: "file", label: "By file" },
                { value: "severity", label: "By severity" },
              ]}
            />
          ) : null}
        </div>
        {listed.length ? (
          <button
            type="button"
            className={TEXT_BUTTON}
            onClick={() =>
              setOpened(allOpen ? new Set() : new Set(listed.map((f) => f.id)))
            }
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {groups.map((g) => (
          <section
            key={g.key}
            aria-label={g.title}
            className="flex min-w-0 flex-col border-t border-border/60 pt-1.5"
          >
            <h3 className="m-0 flex min-w-0 items-center gap-2 py-1 text-xs font-normal leading-5">
              {g.severity ? (
                <span
                  aria-hidden
                  className={cn(
                    "size-2 rounded-full",
                    TONE_DOT[severityTone(g.severity)],
                  )}
                />
              ) : g.key === "praise" ? (
                <Icon
                  name="Star"
                  aria-hidden
                  className="size-3.5 text-success"
                />
              ) : (
                <Icon
                  name="FileText"
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              )}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[12px] text-foreground",
                  group === "file" ? "font-mono" : "font-medium capitalize",
                )}
                title={g.title}
              >
                {g.title}
              </span>
              <CountDots findings={g.findings} />
            </h3>
            <ul className="pr-finding-list m-0 flex min-w-0 list-none flex-col p-0">
              {g.findings.map((finding) => (
                <FindingRow
                  key={finding.id}
                  finding={finding}
                  hostId={hostId}
                  showFile={group === "severity"}
                  open={opened.has(finding.id)}
                  onToggle={() => toggle(finding.id)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
