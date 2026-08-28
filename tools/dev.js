// Sobe backend + frontend juntos com um comando só: npm run dev
// (o frontend em dev aponta para localhost:8080 via frontend/config.js)

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const procs = [
  spawn(process.execPath, ["--watch", path.join(ROOT, "server", "server.js")], { stdio: "inherit" }),
  spawn(process.execPath, [path.join(ROOT, "tools", "serve-static.js")], { stdio: "inherit" })
];

const stopAll = () => { for (const p of procs) { try { p.kill(); } catch (e) {} } };
process.on("SIGINT", () => { stopAll(); process.exit(0); });
process.on("SIGTERM", () => { stopAll(); process.exit(0); });
for (const p of procs) p.on("exit", (code) => { stopAll(); process.exit(code ?? 0); });
