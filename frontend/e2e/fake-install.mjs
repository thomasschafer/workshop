// A stand-in for pip, so tests install packages without the network. Each package becomes a
// module of the same name, in the directory the fixture's profile puts on PYTHONPATH.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [env, ...packages] = process.argv.slice(2);
if (!env) throw new Error("usage: fake-install.mjs ENV PACKAGE...");
const site = join(env, "site");
mkdirSync(site, { recursive: true });
for (const name of packages) {
  writeFileSync(join(site, `${name}.py`), "def count(data):\n    return len(data.splitlines())\n");
}
