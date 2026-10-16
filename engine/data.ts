import { z } from "zod";
import {
  Host,
  Coordinate,
  Actor,
  Branch,
  PR,
  Local,
  Sha,
  keyFor,
  type PullRequest,
  type Target,
  type Feedback,
} from "./types.ts";
import { run, type Run } from "./process.ts";
import { recent, reviewComplete } from "./status.ts";
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, limit), items.length) },
      async () => {
        for (;;) {
          const i = next++;
          if (i >= items.length) return;
          results[i] = await work(items[i]);
        }
      },
    ),
  );
  return results;
}
export function parseURL(raw: string, hostname = "github.com") {
  Host.parse(hostname);
  const u = new URL(raw);
  if (
    !raw.startsWith(`https://${hostname}/`) ||
    u.protocol !== "https:" ||
    u.hostname !== hostname ||
    u.port ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw Error("Expected an HTTPS PR URL on the configured GitHub hostname");
  const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/);
  if (!m || raw.includes("%")) throw Error("Invalid GitHub PR URL path");
  const owner = Coordinate.parse(m[1]),
    repo = Coordinate.parse(m[2]),
    number = +m[3];
  if (!Number.isSafeInteger(number)) throw Error("Invalid PR number");
  return { host: hostname, owner, repo, number };
}
export function normalizePR(
  raw: unknown,
  url: string,
  host = "github.com",
): PullRequest {
  const c = parseURL(url, host);
  const r = z
    .object({
      number: z.number(),
      html_url: z.string(),
      title: z.string(),
      updated_at: z.string().datetime().optional(),
      state: z.literal("open"),
      draft: z.boolean().optional(),
      changed_files: z.number().int().nonnegative().optional(),
      additions: z.number().int().nonnegative().optional(),
      deletions: z.number().int().nonnegative().optional(),
      user: z.object({ login: Actor }),
      base: z.object({
        sha: Sha,
        ref: Branch,
        repo: z.object({ full_name: z.string(), html_url: z.string() }),
      }),
      head: z.object({
        sha: Sha,
        ref: Branch,
        repo: z.object({ full_name: z.string(), html_url: z.string() }),
      }),
    })
    .parse(raw);
  const canonical = parseURL(r.html_url, host);
  if (
    r.number !== c.number ||
    JSON.stringify({
      ...canonical,
      owner: canonical.owner.toLowerCase(),
      repo: canonical.repo.toLowerCase(),
    }) !==
      JSON.stringify({
        ...c,
        owner: c.owner.toLowerCase(),
        repo: c.repo.toLowerCase(),
      })
  )
    throw Error("PR coordinate mismatch");
  const name = `${canonical.owner}/${canonical.repo}`;
  if (
    r.base.repo.full_name.toLowerCase() !== name.toLowerCase() ||
    r.base.repo.html_url.toLowerCase() !==
      `https://${host}/${name}`.toLowerCase()
  )
    throw Error("Base repository mismatch");
  if (
    r.head.repo.full_name.toLowerCase() !== name.toLowerCase() ||
    r.head.repo.html_url.toLowerCase() !== r.base.repo.html_url.toLowerCase()
  )
    throw Error("Unsupported cross-repository head");
  return PR.parse({
    kind: "pr",
    ...canonical,
    url: r.html_url,
    title: r.title,
    author: r.user.login,
    baseBranch: r.base.ref,
    baseSha: r.base.sha,
    headBranch: r.head.ref,
    headSha: r.head.sha,
    headRepo: r.head.repo.full_name,
    ...(r.updated_at ? { updatedAt: r.updated_at } : {}),
    ...(typeof r.draft === "boolean" ? { draft: r.draft } : {}),
    ...(typeof r.changed_files === "number"
      ? { changedFiles: r.changed_files }
      : {}),
    ...(typeof r.additions === "number" ? { additions: r.additions } : {}),
    ...(typeof r.deletions === "number" ? { deletions: r.deletions } : {}),
  });
}
export function owned(t: Target, login: string) {
  return t.kind === "branch" || t.author.toLowerCase() === login.toLowerCase();
}
/**
 * Pull requests looked up before, keyed by URL and the "updated" time GitHub
 * listed them with. A listing whose time is unchanged reuses the earlier
 * lookup instead of spending an API call on it.
 */
export interface KnownPullRequests {
  get(url: string, listedUpdatedAt: string): PullRequest | undefined;
  remember(url: string, listedUpdatedAt: string, target: PullRequest): void;
}
export class GitHub {
  host: string;
  exec: Run;
  /** Queue discovery only. Reviews always hydrate the live pull request. */
  known?: KnownPullRequests;
  private listed = new Map<string, Promise<PullRequest>>();
  constructor(host = "github.com", exec: Run = run) {
    this.host = Host.parse(host);
    this.exec = exec;
  }
  async api(path: string, extra: string[] = []) {
    if (!/^(user|search\/issues\?|repos\/)/.test(path) || extra.length !== 0)
      throw Error("Read-only API restriction");
    return JSON.parse(
      await this.exec("gh", [
        "api",
        "--hostname",
        this.host,
        "--method",
        "GET",
        path,
        ...extra,
      ]),
    );
  }
  async login() {
    return Coordinate.parse((await this.api("user")).login);
  }
  /** A pull request's current head and whether it is still open. One API call. */
  async pullState(url: string) {
    const c = parseURL(url, this.host);
    const raw = await this.api(`repos/${c.owner}/${c.repo}/pulls/${c.number}`);
    return {
      head: Sha.parse(raw?.head?.sha),
      state: raw?.merged_at
        ? ("merged" as const)
        : raw?.state === "closed"
          ? ("closed" as const)
          : ("open" as const),
    };
  }
  /** Remaining API budgets. GitHub does not count this call against them. */
  async rateLimit() {
    return JSON.parse(
      await this.exec("gh", [
        "api",
        "--hostname",
        this.host,
        "--method",
        "GET",
        "rate_limit",
      ]),
    );
  }
  async hydrate(url: string) {
    const c = parseURL(url, this.host);
    return normalizePR(
      await this.api(`repos/${c.owner}/${c.repo}/pulls/${c.number}`),
      url,
      this.host,
    );
  }
  /**
   * Hydrate a pull request found by a search. Reuses a known lookup when
   * GitHub lists it with the same updated time, and looks each pull request
   * up at most once per client even when several searches return it.
   */
  hydrateListed(url: string, listedUpdatedAt?: string | null) {
    const known = listedUpdatedAt
      ? this.known?.get(url, listedUpdatedAt)
      : undefined;
    if (known) return Promise.resolve(known);
    let pending = this.listed.get(url);
    if (!pending) {
      pending = this.hydrate(url).then((target) => {
        if (listedUpdatedAt) this.known?.remember(url, listedUpdatedAt, target);
        return target;
      });
      pending.catch(() => this.listed.delete(url));
      this.listed.set(url, pending);
    }
    return pending;
  }
  async diff(target: PullRequest) {
    const t = PR.parse(target);
    return this.exec("gh", [
      "api",
      "--hostname",
      this.host,
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github.v3.diff",
      `repos/${t.owner}/${t.repo}/compare/${t.baseSha}...${t.headSha}`,
    ]);
  }
  async discover(tab: number, login: string, root?: string) {
    if (tab === 1) {
      const prior = new Map<string, PullRequest>();
      for (const s of recent(root))
        for (const e of s.entries)
          if (
            e.target.kind === "pr" &&
            reviewComplete(e) &&
            e.target.host === this.host &&
            !prior.has(e.key)
          )
            prior.set(e.key, e.target);
      const open = await mapConcurrent([...prior.values()], 4, async (t) => {
        const c = parseURL(t.url, this.host);
        const raw = await this.api(
          `repos/${c.owner}/${c.repo}/pulls/${c.number}`,
        );
        if (raw.state === "closed") return undefined;
        return normalizePR(raw, t.url, this.host);
      });
      return open.filter((t): t is PullRequest => !!t);
    }
    const query = `is:pr is:open ${tab === 0 ? "review-requested" : "author"}:${login}`;
    return this.search(query, root);
  }
  async discoverTeam(team: string, root?: string) {
    const [owner, slug, ...extra] = team.split("/");
    if (extra.length) throw Error("Review team must be OWNER/TEAM");
    Coordinate.parse(owner);
    Coordinate.parse(slug);
    return this.search(`is:pr is:open team-review-requested:${team}`, root);
  }
  private async search(query: string, root?: string) {
    const found: PullRequest[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = z
        .object({
          total_count: z.number().int(),
          incomplete_results: z.literal(false),
          items: z.array(
            z.object({
              html_url: z.string(),
              updated_at: z.string().nullable().optional(),
            }),
          ),
        })
        .parse(
          await this.api(
            `search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}`,
          ),
        );
      found.push(
        ...(await mapConcurrent(r.items, 4, (x) =>
          this.hydrateListed(x.html_url, x.updated_at),
        )),
      );
      if (found.length >= r.total_count) return this.history(found, root);
      if (!r.items.length) throw Error("Incomplete GitHub discovery");
    }
    throw Error("GitHub discovery exceeds 1000 results");
  }
  history(prs: PullRequest[], root?: string) {
    const hist = new Map<string, PullRequest["previous"]>();
    for (const s of recent(root))
      for (const e of [...s.entries].reverse())
        if (e.target.kind === "pr" && reviewComplete(e) && !hist.has(e.key))
          hist.set(e.key, {
            headSha: e.target.headSha,
            at:
              typeof e.review.completedAt === "string"
                ? e.review.completedAt
                : s.updatedAt,
            model: String(e.review.model ?? "unknown"),
          });
    return prs.map((t) => ({ ...t, previous: hist.get(keyFor(t)) }));
  }
  async feedback(t: PullRequest): Promise<Feedback> {
    // GraphQL pagination is checked at every connection; do not mislabel a partial snapshot complete.
    const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved comments(first:100){pageInfo{hasNextPage} nodes{body path line url author{login __typename}}}}} reviews(first:100){pageInfo{hasNextPage} nodes{body url author{login __typename}}} comments(first:100){pageInfo{hasNextPage} nodes{body url author{login __typename}}}}}}`;
    // GraphQL is read-only but gh needs POST transport. Query-only documents are generated internally.
    const data = JSON.parse(
      await this.exec("gh", [
        "api",
        "--hostname",
        this.host,
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${t.owner}`,
        "-f",
        `repo=${t.repo}`,
        "-F",
        `number=${t.number}`,
      ]),
    );
    if (data.errors) throw Error("Feedback retrieval incomplete");
    const p = data.data?.repository?.pullRequest;
    if (!p) throw Error("Feedback retrieval incomplete");
    const comments: Feedback["comments"] = [];
    const collect = (c: any, location: string) => {
      if (
        !c ||
        typeof c.body !== "string" ||
        typeof c.url !== "string" ||
        !c.author
      )
        throw Error("Invalid feedback");
      if (
        c.author.__typename !== "User" ||
        /(?:\[bot\]|(?:^|[-_])(?:bot|robot))$/i.test(c.author.login) ||
        c.author.login.toLowerCase() === t.author.toLowerCase() ||
        !c.body.trim()
      )
        return;
      if (
        /^(?:deployment|deploy preview|coverage report|ci status|dependency update)/i.test(
          c.body.trim(),
        )
      )
        return;
      comments.push({
        author: c.author.login,
        body: c.body,
        location,
        url: c.url,
      });
    };
    const connection = (c: any) => {
      if (!c || c.pageInfo?.hasNextPage !== false || !Array.isArray(c.nodes))
        throw Error("Feedback snapshot partial; pagination required");
      return c.nodes;
    };
    for (const th of connection(p.reviewThreads)) {
      if (typeof th.isResolved !== "boolean")
        throw Error("Invalid feedback thread");
      const nodes = connection(th.comments);
      if (!th.isResolved)
        for (const c of nodes) collect(c, `${c.path}:${c.line ?? "?"}`);
    }
    for (const c of connection(p.reviews)) collect(c, "Review summary");
    for (const c of connection(p.comments)) collect(c, "PR conversation");
    return (await import("./types.ts")).Feedback.parse({
      complete: true,
      comments,
    });
  }
}
export function unchanged(before: Target, after: Target) {
  if (
    keyFor(before) !== keyFor(after) ||
    before.baseSha !== after.baseSha ||
    before.headSha !== after.headSha ||
    before.kind !== after.kind ||
    (before.kind === "pr" &&
      after.kind === "pr" &&
      (before.headBranch !== after.headBranch ||
        before.baseBranch !== after.baseBranch ||
        before.author.toLowerCase() !== after.author.toLowerCase() ||
        before.headRepo.toLowerCase() !== after.headRepo.toLowerCase()))
  )
    throw Error("PR head, base, branch, or ownership changed");
}
export async function localTarget(
  cwd: string,
  branch: string,
  base?: string,
  exec: Run = run,
) {
  Branch.parse(branch);
  const root = (
    await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"])
  ).trim();
  const remotes = (await exec("git", ["-C", root, "remote"]))
    .trim()
    .split("\n")
    .filter(Boolean);
  if (remotes.length > 1 && !base)
    throw Error("Ambiguous remotes: specify --base");
  if (!base) {
    try {
      base = (
        await exec("git", [
          "-C",
          root,
          "symbolic-ref",
          "--short",
          "refs/remotes/origin/HEAD",
        ])
      ).trim();
    } catch {
      throw Error("No safe default base; provide --base explicitly");
    }
  }
  Branch.parse(base);
  const sha = async (ref: string) =>
    (
      await exec("git", [
        "-C",
        root,
        "rev-parse",
        "--verify",
        `${ref}^{commit}`,
      ])
    ).trim();
  return Local.parse({
    kind: "branch",
    repoRoot: root,
    branch,
    base,
    baseSha: await sha(base),
    headSha: await sha(`refs/heads/${branch}`),
    title: `local branch ${branch} (base ${base})`,
  });
}
export function parseArgs(args: string) {
  const words = args.trim() ? args.trim().split(/\s+/) : [];
  let branch: string | undefined, base: string | undefined;
  const urls: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "--branch" || w === "--base") {
      const v = words[++i];
      if (!v || v.startsWith("-")) throw Error(`Missing ${w} value`);
      if (w === "--branch") {
        if (branch) throw Error("Duplicate branch");
        branch = v;
      } else {
        if (base) throw Error("Duplicate base");
        base = v;
      }
    } else if (w.startsWith("-")) throw Error(`Unknown option ${w}`);
    else urls.push(w);
  }
  if ((base && !branch) || (branch && urls.length))
    throw Error("Use URLs or --branch [--base], not both");
  return { branch, base, urls };
}
