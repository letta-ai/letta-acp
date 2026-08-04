import { writeFileSync } from "node:fs";

const url = process.env.FAKE_APP_SERVER_URL;
const marker = process.env.APP_SERVER_SHUTDOWN_MARKER;
const pidFile = process.env.APP_SERVER_PID_FILE;

if (!url) throw new Error("FAKE_APP_SERVER_URL is required");
if (pidFile) writeFileSync(pidFile, String(process.pid));

process.stdout.write(`Listening on ${url}\n`);
setInterval(() => {}, 1_000);

process.on("SIGTERM", () => {
  if (marker) writeFileSync(marker, "terminated");
  process.exit(0);
});
