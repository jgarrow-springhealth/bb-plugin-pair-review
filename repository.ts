import { Coordinate } from "./engine/types.ts";
/** Display-only origin parsing. Never execute or follow an origin URL. */
export function repositoryLink(remote: string) {
  const ssh = remote.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  const https = remote.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  const match = ssh ?? https;
  if (!match || /[?#%\x00-\x20]/.test(remote)) return null;
  const owner = Coordinate.safeParse(match[1]),
    repo = Coordinate.safeParse(match[2]);
  if (!owner.success || !repo.success) return null;
  return {
    name: `${owner.data}/${repo.data}`,
    url: `https://github.com/${owner.data}/${repo.data}`,
  };
}
