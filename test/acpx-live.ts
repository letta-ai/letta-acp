import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apiKey = process.env.LETTA_API_KEY;
const agentId = process.env.LETTA_ACP_TEST_AGENT_ID;
if (!apiKey || !agentId) {
  throw new Error(
    "Live ACP smoke test requires LETTA_API_KEY and LETTA_ACP_TEST_AGENT_ID.",
  );
}

const root = join(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "letta-acp-live-"));
const acpxPath = join(root, "node_modules", ".bin", "acpx");
const agentPath = join(root, "src", "index.ts");

try {
  const child = Bun.spawn(
    [
      acpxPath,
      "--agent",
      `${process.execPath} ${agentPath}`,
      "--format",
      "json",
      "--timeout",
      "60",
      "sessions",
      "new",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        LETTA_ACP_BACKEND: "cloud",
        LETTA_AGENT_ID: agentId,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`acpx exited ${exitCode}:\n${stderr}\n${stdout}`);
  }

  const result = JSON.parse(stdout.trim()) as Record<string, unknown>;
  if (
    result.action !== "session_ensured" ||
    result.created !== true ||
    typeof result.acpxSessionId !== "string" ||
    !result.acpxSessionId.startsWith("conv-")
  ) {
    throw new Error(`Unexpected live ACP session result: ${stdout.trim()}`);
  }
  console.log("Live acpx → letta-acp → Letta Cloud session smoke test passed.");
} finally {
  rmSync(home, { recursive: true, force: true });
}
