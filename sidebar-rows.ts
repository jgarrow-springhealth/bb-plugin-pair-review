import type { Snapshot } from "./contract";

export interface PairReviewProjectRow {
  id: string;
  projectId: string;
  title: string;
  subtitle: string;
  href: string;
  status: "running" | "attention" | "done" | "neutral";
  statusLabel: string;
  count?: number;
  updatedAt: number;
}

interface ProjectLike {
  id: string;
  name: string;
  sources: { type: string; path?: string }[];
}

/** Build the thread-shaped rows contributed to Projects & Sections. */
export function pairReviewProjectRows(
  snapshot: Snapshot,
  projects: readonly ProjectLike[],
): PairReviewProjectRow[] {
  const normalizedFork = snapshot.health.forkPath.replace(/\/+$/, "");
  const project =
    projects.find((candidate) =>
      candidate.sources.some(
        (source) =>
          source.type === "local_path" &&
          source.path?.replace(/\/+$/, "") === normalizedFork,
      ),
    ) ?? projects.find((candidate) => candidate.name === "Pair Review");
  if (!project) return [];

  const seen = new Set<string>();
  return (
    [...snapshot.rows]
      .filter((row) => !row.dismissed && !row.superseded)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .filter((row) => {
        if (seen.has(row.key)) return false;
        seen.add(row.key);
        return true;
      })
      // Submission retires the PR from the project; an older attempt for the
      // same PR must not reappear after its latest review was published.
      .filter((row) => !row.submitted)
      .sort(
        (a, b) =>
          Number(b.running) - Number(a.running) ||
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      )
      .map((row) => {
        const complete = ["findings", "zero_findings"].includes(
          row.reviewState,
        );
        const status = row.running
          ? ("running" as const)
          : row.attention
            ? ("attention" as const)
            : complete
              ? ("done" as const)
              : ("neutral" as const);
        const statusLabel =
          status === "running"
            ? "In progress"
            : status === "attention"
              ? "Needs attention"
              : status === "done"
                ? `${row.count} ${row.count === 1 ? "finding" : "findings"}`
                : row.reviewState.replaceAll("_", " ");
        return {
          id: row.id,
          projectId: project.id,
          title: row.title,
          subtitle: row.subject,
          href: `/plugins/pair-review/reviews/${row.batchId}/${row.index}`,
          status,
          statusLabel,
          ...(status === "done" ? { count: row.count } : {}),
          updatedAt: Date.parse(row.updatedAt) || 0,
        };
      })
  );
}
