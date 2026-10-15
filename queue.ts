import { z } from "zod";
const coordinate = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
const login = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/);
function list(value: string, max: number, parse: (s: string) => string) {
  const result = [
    ...new Set(
      value
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((s) => parse(s).toLowerCase()),
    ),
  ];
  if (result.length > max) throw Error(`At most ${max} entries are supported`);
  return result;
}
export const parseTeammates = (value: string) =>
  list(value, 100, (s) => login.parse(s));
export const parseTeams = (value: string) =>
  list(value, 20, (s) => {
    const parts = s.split("/");
    if (parts.length !== 2) throw Error("Review teams must be OWNER/TEAM");
    return `${coordinate.parse(parts[0])}/${coordinate.parse(parts[1])}`;
  });
export function requestTag(
  author: string,
  teammates: string[],
  requestedViaTeam = false,
) {
  if (requestedViaTeam) return "Team request";
  return teammates.some(
    (handle) => handle.toLowerCase() === author.toLowerCase(),
  )
    ? "Teammate request"
    : "Other direct request";
}
export const queueFilters = [
  ["All", "All"],
  ["Teammate request", "Teammate requests"],
  ["Other direct request", "Other direct requests"],
  ["Team request", "Team requests"],
  ["Assigned", "Assigned"],
  ["Authored", "Authored"],
  ["Draft", "Drafts"],
] as const;
export const repositoryFor = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname.split("/").slice(1, 3).join("/");
  } catch {
    return "";
  }
};
