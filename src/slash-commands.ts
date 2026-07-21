import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AvailableCommand } from "@agentclientprotocol/sdk";

/**
 * Slash-command surface exposed to ACP clients.
 *
 * Three kinds:
 * - native: implemented in the adapter itself (/model)
 * - execute: dispatched to the Letta harness via the app-server protocol's
 *   `execute_command` (results stream back as slash_command_start/end)
 * - text: forwarded to the model as prompt text; the harness instructs the
 *   model that `/name` means "invoke that skill/behavior", which also covers
 *   every skill discovered on disk
 */

export interface ExecuteCommandSpec {
  name: string;
  description: string;
  hint?: string;
}

/** Commands the harness executes via the execute_command protocol path. */
export const EXECUTE_COMMANDS: ExecuteCommandSpec[] = [
  { name: "clear", description: "Clear in-context messages (moved to conversation history)" },
  {
    name: "compact",
    description: "Summarize conversation history immediately",
    hint: "all | sliding_window (empty for default)",
  },
  { name: "init", description: "Initialize or re-initialize agent memory" },
  { name: "doctor", description: "Audit and refine the agent's memory structure" },
  {
    name: "remember",
    description: "Ask the agent to remember conversation content",
    hint: "what to remember (empty to infer from context)",
  },
  {
    name: "context-limit",
    description: "Set or reset the max context window",
    hint: "tokens (empty to show current)",
  },
  { name: "reload", description: "Reload harness settings" },
  {
    name: "toolset",
    description: "Switch toolset",
    hint: "default | codex | gemini",
  },
];

/** TUI commands with no protocol path that the model handles well as text. */
const TEXT_COMMANDS: ExecuteCommandSpec[] = [
  { name: "memory", description: "Show the agent's memory blocks" },
  { name: "search", description: "Search past conversation history", hint: "query" },
  { name: "skills", description: "List available skills by source" },
  {
    name: "skill-creator",
    description: "Create a new skill interactively",
    hint: "what the skill should do",
  },
];

const EXECUTE_COMMAND_NAMES = new Set(EXECUTE_COMMANDS.map((c) => c.name));

export function isExecuteCommand(name: string): boolean {
  return EXECUTE_COMMAND_NAMES.has(name);
}

/** Full command list to advertise for a session rooted at `cwd`. */
export function buildAvailableCommands(cwd: string): AvailableCommand[] {
  const commands: AvailableCommand[] = [
    {
      name: "model",
      description: "Show available models or switch the session's model",
      input: { hint: "model handle (leave empty to list)" },
    },
  ];
  for (const spec of [...EXECUTE_COMMANDS, ...TEXT_COMMANDS]) {
    commands.push({
      name: spec.name,
      description: spec.description,
      ...(spec.hint ? { input: { hint: spec.hint } } : {}),
    });
  }
  const seen = new Set(commands.map((c) => c.name));
  for (const skill of discoverSkills(cwd)) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    commands.push({
      name: skill.name,
      description: skill.description,
      input: { hint: "optional instructions" },
    });
  }
  return commands;
}

interface SkillEntry {
  name: string;
  description: string;
}

/** Skills from the bundled letta-code package, global dir, and project dir. */
function discoverSkills(cwd: string): SkillEntry[] {
  const roots: string[] = [];
  const bundled = bundledSkillsDir();
  if (bundled) roots.push(bundled);
  roots.push(join(homedir(), ".letta", "skills"));
  roots.push(join(cwd, ".claude", "skills"));

  const skills = new Map<string, SkillEntry>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillFile = join(root, entry, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      const parsed = parseSkillFrontmatter(skillFile);
      if (!parsed) continue;
      // Slash names must be typable; fall back to the directory name when the
      // frontmatter name isn't a clean slug (e.g. "Context Doctor").
      const name = /^[a-z0-9][a-z0-9-]*$/i.test(parsed.name)
        ? parsed.name
        : entry;
      skills.set(name, { ...parsed, name });
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function bundledSkillsDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const cliPath = require.resolve("@letta-ai/letta-code");
    return join(dirname(cliPath), "skills");
  } catch {
    return null;
  }
}

function parseSkillFrontmatter(skillFile: string): SkillEntry | null {
  let text: string;
  try {
    text = readFileSync(skillFile, "utf8");
  } catch {
    return null;
  }
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const frontmatter = match[1] ?? "";
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter
    .match(/^description:\s*(.+)$/m)?.[1]
    ?.trim();
  if (!name) return null;
  const shortDescription =
    description && description.length > 160
      ? `${description.slice(0, 157)}...`
      : (description ?? `Invoke the ${name} skill`);
  return { name, description: shortDescription };
}
