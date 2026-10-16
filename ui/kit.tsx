// Display components for the Pair Review page.
//
// Adapted from bb-plugin-genui (https://github.com/ComicBit/bb-plugin-genui),
// Copyright ComicBit, licensed under the Apache License, Version 2.0; see
// licenses/bb-plugin-genui-LICENSE and THIRD_PARTY_NOTICES.md.
// Modifications: rewritten as typed React components with explicit props (no
// spec language, runtime or entrance animations), controlled Tabs, clickable
// metrics and legend entries, and Pair Review finding shapes.
import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type Tone = "neutral" | "good" | "warn" | "bad" | "info";

/** The accent BB gives timelines and charts, falling back to its primary. */
export const ACCENT = "var(--color-timeline-accent,var(--primary))";

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "",
  good: "text-success",
  warn: "text-warning-text",
  bad: "text-destructive",
  info: "text-[var(--color-timeline-accent,var(--primary))]",
};

export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-muted-foreground/45",
  good: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
  info: "bg-[var(--color-timeline-accent,var(--primary))]",
};

const TONE_PILL: Record<Tone, string> = {
  neutral: "bg-surface-recessed text-muted-foreground",
  good: "bg-success/12 text-success",
  warn: "bg-warning/14 text-warning-text",
  bad: "bg-destructive/10 text-destructive",
  info: "bg-[color-mix(in_oklch,var(--color-timeline-accent,var(--primary))_12%,transparent)] text-[var(--color-timeline-accent,var(--primary))]",
};

export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Whole-number shares of a total that always add up to 100. */
export function percentages(values: readonly number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0) || !Number.isFinite(total)) return values.map(() => 0);
  const exact = values.map((value) => (value / total) * 100);
  const whole = exact.map(Math.floor);
  const spare = 100 - whole.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((share, index) => ({ index, remainder: share - whole[index]! }))
    .sort(
      (a, b) =>
        b.remainder - a.remainder ||
        values[b.index]! - values[a.index]! ||
        a.index - b.index,
    );
  for (let k = 0; k < spare; k++) whole[order[k % order.length]!.index]! += 1;
  return whole;
}

/** A small tinted status pill. */
export function Pill({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex w-fit max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-4",
        TONE_PILL[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A status as a colored dot before plain text. */
export function DotLabel({
  tone,
  children,
}: {
  tone: Tone;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs leading-5 text-foreground">
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone])}
      />
      {children}
    </span>
  );
}

/** A key number with a label above and an optional note below. */
export function Metric({
  label,
  value,
  note,
  tone = "neutral",
  active = false,
  onClick,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: Tone;
  active?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "break-words text-xl font-semibold leading-7 tracking-[-0.02em] tabular-nums",
          TONE_TEXT[tone] || "text-foreground",
        )}
      >
        {value}
      </span>
      {note === undefined || note === null ? null : (
        <span className="text-xs leading-4 text-muted-foreground">{note}</span>
      )}
    </>
  );
  const frame =
    "flex min-w-0 flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left";
  return onClick ? (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        frame,
        "cursor-pointer transition-colors duration-150 hover:bg-surface-recessed",
        active && "bg-surface-recessed",
        FOCUS_RING,
      )}
    >
      {body}
    </button>
  ) : (
    <div className={frame}>{body}</div>
  );
}

/** Two to five metrics side by side, wrapping on narrow panes. */
export function MetricRow({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-1">
      {children}
    </div>
  );
}

export interface BarPart {
  id: string;
  label: string;
  value: number;
  /** A CSS color; defaults to a quiet ramp of the accent. */
  color?: string;
}

/** Calm colors for categories that carry no status meaning. */
export function rampColor(position: number): string {
  const steps = [
    ACCENT,
    `color-mix(in oklch, ${ACCENT} 55%, var(--background))`,
    "color-mix(in oklch, var(--muted-foreground) 70%, var(--background))",
    "color-mix(in oklch, var(--muted-foreground) 42%, var(--background))",
    `color-mix(in oklch, ${ACCENT} 28%, var(--background))`,
    "color-mix(in oklch, var(--muted-foreground) 22%, var(--background))",
  ];
  return steps[position % steps.length]!;
}

/** One full-width bar split into parts, with a legend of each part's value and share. */
export function SegmentedBar({
  parts,
  unit,
  selected,
  onSelect,
}: {
  parts: readonly BarPart[];
  unit?: string;
  selected?: string | null;
  onSelect?: (id: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (!parts.length) return null;
  const shares = percentages(parts.map((part) => part.value));
  const share = (index: number) =>
    shares[index] === 0 && parts[index]!.value > 0
      ? "<1%"
      : `${shares[index]}%`;
  const color = (index: number) => parts[index]!.color ?? rampColor(index);
  const dimmed = (index: number) =>
    hover !== null
      ? hover !== index
      : !!selected && parts[index]!.id !== selected;
  const summary = parts
    .map(
      (part, index) =>
        `${part.label} ${part.value}${unit ? ` ${unit}` : ""} (${share(index)})`,
    )
    .join(", ");
  return (
    <div
      className="flex min-w-0 flex-col gap-2.5"
      onPointerLeave={() => setHover(null)}
    >
      <div
        role="img"
        aria-label={summary}
        className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-muted"
      >
        {parts.map((part, index) =>
          part.value > 0 ? (
            <div
              key={part.id}
              className={cn(
                "h-full min-w-[3px] transition-opacity duration-150",
                dimmed(index) && "opacity-35",
              )}
              style={{ flex: `${part.value} 1 0`, background: color(index) }}
              onPointerEnter={() => setHover(index)}
            />
          ) : null,
        )}
      </div>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-x-5 p-0 text-xs">
        {parts.map((part, index) => {
          const content = (
            <>
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-[2px]"
                style={{ background: color(index) }}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {part.label}
              </span>
              <span className="font-medium tabular-nums text-foreground">
                {part.value}
              </span>
              <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">
                {share(index)}
              </span>
            </>
          );
          return (
            <li
              key={part.id}
              className={cn(
                "min-w-0 transition-opacity duration-150",
                dimmed(index) && "opacity-50",
              )}
              onPointerEnter={() => setHover(index)}
            >
              {onSelect ? (
                <button
                  type="button"
                  aria-pressed={selected === part.id}
                  aria-label={`Show ${part.label} (${part.value})`}
                  onClick={() => onSelect(part.id)}
                  className={cn(
                    "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm text-left leading-6",
                    FOCUS_RING,
                  )}
                >
                  {content}
                </button>
              ) : (
                <span className="flex min-w-0 items-center gap-2 leading-6">
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export interface TabSpec<T extends string> {
  id: T;
  label: string;
  count?: number;
  /** Drawn before the label, e.g. a spinner while work runs. */
  adornment?: ReactNode;
}

/**
 * Underlined tabs over one panel. Controlled: the page owns the selection so
 * metrics and legends can switch tabs too. Only the active panel renders.
 */
export function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  children,
}: {
  label: string;
  tabs: readonly TabSpec<T>[];
  value: T;
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === value),
  );
  const onKeyDown = (event: KeyboardEvent) => {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (active + step + tabs.length) % tabs.length;
    onChange(tabs[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="flex min-w-0 gap-5 overflow-x-auto border-b border-border [scrollbar-width:none]"
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${tab.id}`}
            aria-selected={index === active}
            aria-controls={`${id}-panel`}
            tabIndex={index === active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={cn(
              "-mb-px inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 pb-2 text-[13px] transition-colors duration-150 focus-visible:text-foreground focus-visible:outline-none",
              index === active
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.adornment}
            {tab.label}
            {tab.count === undefined ? null : (
              <span className="rounded-full bg-surface-recessed px-1.5 text-[11px] font-normal leading-4 tabular-nums text-muted-foreground">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${tabs[active]?.id}`}
        className="flex min-w-0 flex-col gap-3"
      >
        {children}
      </div>
    </div>
  );
}

/** A compact radio group drawn as a pill switch. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex w-fit max-w-full shrink-0 gap-0.5 rounded-lg bg-surface-recessed p-0.5"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-6 cursor-pointer whitespace-nowrap rounded-md px-2.5 text-xs transition-[color,background-color,box-shadow] duration-150",
              FOCUS_RING,
              selected
                ? "bg-background font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_0.5px_var(--border)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export type StepStatus = "done" | "current" | "blocked" | "todo";

const STEP_MARKER: Record<StepStatus, string> = {
  done: "bg-success/12 text-success",
  current: TONE_PILL.info,
  todo: "bg-surface-recessed text-muted-foreground",
  blocked: "bg-destructive/10 text-destructive",
};

/** A horizontal progress of numbered markers, colored by status. */
export function Steps({
  label,
  items,
}: {
  label: string;
  items: readonly { title: string; detail?: string; status: StepStatus }[];
}) {
  return (
    <ol
      aria-label={label}
      className="m-0 grid min-w-0 list-none grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-3 gap-y-2 p-0"
    >
      {items.map((item, index) => (
        <li
          key={item.title}
          aria-current={item.status === "current" ? "step" : undefined}
          className="flex min-w-0 items-start gap-2"
        >
          <span
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums",
              STEP_MARKER[item.status],
            )}
          >
            {item.status === "done" ? (
              <Icon name="Check" className="size-3" />
            ) : item.status === "blocked" ? (
              "!"
            ) : (
              index + 1
            )}
          </span>
          <span className="flex min-w-0 flex-col">
            <span
              className={cn(
                "text-sm leading-5",
                item.status === "current" && "font-medium",
                item.status === "todo"
                  ? "text-muted-foreground"
                  : "text-foreground",
              )}
            >
              {item.title}
              {item.status === "blocked" ? (
                <span className="ml-1.5 text-xs text-destructive">Blocked</span>
              ) : null}
            </span>
            {item.detail ? (
              <span className="text-xs leading-4 text-muted-foreground">
                {item.detail}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

export interface TimelineEntry {
  key: string;
  time: string;
  title: string;
  detail?: ReactNode;
  tone: Tone;
  current?: boolean;
  onOpen?: () => void;
}

/** Events down a line: time, a tone-colored dot, title and a muted detail. */
export function Timeline({
  label,
  items,
}: {
  label: string;
  items: readonly TimelineEntry[];
}) {
  return (
    <ol
      aria-label={label}
      className="m-0 grid min-w-0 list-none grid-cols-[fit-content(30%)_0.5rem_minmax(0,1fr)] gap-x-3 p-0"
    >
      {items.map((entry, index) => {
        const last = index === items.length - 1;
        return (
          <li key={entry.key} className="col-span-full grid grid-cols-subgrid">
            <span className="text-xs leading-5 tabular-nums text-muted-foreground">
              {entry.time}
            </span>
            <div aria-hidden className="flex flex-col items-center">
              <span
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  TONE_DOT[entry.tone],
                )}
              />
              {last ? null : <span className="mt-1.5 w-px flex-1 bg-border" />}
            </div>
            <div
              className={cn("flex min-w-0 flex-col gap-0.5", !last && "pb-4")}
            >
              {entry.onOpen && !entry.current ? (
                <button
                  type="button"
                  onClick={entry.onOpen}
                  className={cn(
                    "w-fit cursor-pointer rounded-sm text-left text-sm font-medium leading-5 text-foreground underline-offset-2 hover:underline",
                    FOCUS_RING,
                  )}
                >
                  {entry.title}
                </button>
              ) : (
                <span className="text-sm font-medium leading-5 text-foreground">
                  {entry.title}
                  {entry.current ? (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      Viewing
                    </span>
                  ) : null}
                </span>
              )}
              {entry.detail ? (
                <span className="text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">
                  {entry.detail}
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** A definition list: labels and values in two aligned columns. */
export function KeyValue({
  pairs,
}: {
  pairs: readonly (readonly [string, ReactNode])[];
}) {
  return (
    <dl className="m-0 grid min-w-0 grid-cols-[fit-content(40%)_minmax(0,1fr)] gap-x-6 text-sm leading-5">
      {pairs.map(([label, value]) => (
        <div
          key={label}
          className="col-span-full grid grid-cols-subgrid border-b border-border/60 py-2 first:pt-0 last:border-b-0 last:pb-0"
        >
          <dt className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
            {label}
          </dt>
          <dd className="m-0 min-w-0 text-foreground [overflow-wrap:anywhere]">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const CALLOUT: Record<Tone, { surface: string; icon: string }> = {
  neutral: { surface: "bg-surface-recessed", icon: "Info" },
  info: { surface: "bg-surface-recessed", icon: "Info" },
  good: { surface: "bg-success/8", icon: "CircleCheck" },
  warn: { surface: "bg-warning/10", icon: "AlertTriangle" },
  bad: { surface: "bg-destructive/8", icon: "CircleX" },
};

/** A tinted note with an icon, an optional title and a body. */
export function Callout({
  tone = "neutral",
  title,
  role = "note",
  children,
  className,
}: {
  tone?: Tone;
  title?: ReactNode;
  role?: "note" | "alert" | "status";
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={role}
      className={cn(
        "grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2.5 rounded-lg px-3.5 py-3 text-sm leading-5 text-foreground",
        CALLOUT[tone].surface,
        className,
      )}
    >
      <Icon
        name={CALLOUT[tone].icon}
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0",
          TONE_TEXT[tone] || "text-muted-foreground",
        )}
      />
      <div className="flex min-w-0 flex-col gap-1">
        {title ? (
          <div className="font-medium text-foreground">{title}</div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <Icon
      name="ChevronRight"
      aria-hidden
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-foreground motion-reduce:transition-none",
        open && "rotate-90",
      )}
    />
  );
}

/** A row that opens to a body; the body mounts on first open. */
export function Disclosure({
  open,
  onToggle,
  header,
  label,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  header: ReactNode;
  label?: string;
  children: () => ReactNode;
}) {
  const id = useId();
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        id={`${id}-header`}
        aria-expanded={open}
        aria-controls={`${id}-body`}
        aria-label={label}
        onClick={onToggle}
        className={cn(
          "group flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-md text-left",
          FOCUS_RING,
        )}
      >
        {header}
      </button>
      <div
        id={`${id}-body`}
        role="region"
        aria-labelledby={`${id}-header`}
        hidden={!open}
        className={cn("min-w-0 flex-col", open ? "flex" : "hidden")}
      >
        {mounted ? children() : null}
      </div>
    </div>
  );
}
