import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
const root =
  process.env.PI_HOST_ROOT ??
  join(
    execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "@earendil-works",
    "pi-coding-agent",
  );
if (!existsSync(join(root, "package.json")))
  throw Error(
    "Installed Pi package unavailable. Set PI_HOST_ROOT to its package directory.",
  );
mkdirSync("node_modules/@earendil-works", { recursive: true });
for (const name of ["pi-coding-agent", "pi-tui", "pi-ai"]) {
  const target =
    name === "pi-coding-agent"
      ? root
      : join(root, "node_modules", "@earendil-works", name);
  const link = join("node_modules", "@earendil-works", name);
  if (!existsSync(link)) symlinkSync(target, link, "dir");
}
console.log(
  "Linked installed host packages for local tests and detached SDK workers.",
);
