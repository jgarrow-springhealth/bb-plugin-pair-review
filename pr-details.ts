import { keyFor, type Status } from "./engine/types.ts";
import { isSuperseded } from "./engine/status.ts";
/** Read-only lookup; does not create batches, checkouts or model sessions. */
export function latestReviewSelection(
  statuses: Status[],
  key: string,
  dismissed = new Set<string>(),
) {
  const ordered = [...statuses].sort((a, b) => {
    const active = (s: Status) =>
      ["queued", "running"].includes(s.state) ? 1 : 0;
    return (
      active(b) - active(a) || Date.parse(b.createdAt) - Date.parse(a.createdAt)
    );
  });
  for (const s of ordered)
    for (let index = s.entries.length - 1; index >= 0; index--) {
      const e = s.entries[index];
      if (
        e.target.kind === "pr" &&
        keyFor(e.target) === key &&
        !dismissed.has(`${s.batchId}/${index}`) &&
        !isSuperseded(e, s)
      )
        return { batchId: s.batchId, index };
    }
  return null;
}
