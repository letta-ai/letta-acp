import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { ListModelsResult } from "@letta-ai/letta-agent-sdk";

/** Config option id for the model selector, per the ACP model-category convention. */
export const MODEL_CONFIG_ID = "model";

/**
 * Letta's model catalog as an ACP session config option.
 *
 * Clients with a model picker — Zed's dropdown, Buzz's agent form — read the
 * `model`-category entry of `configOptions` from `session/new`. Without one
 * they either hide the picker or report the agent has no models, so the
 * catalog is published at session setup and kept current through
 * `session/set_config_option`.
 *
 * Entries are keyed by handle (`provider/model`), the same identifier
 * `LETTA_ACP_MODEL` and `/model` take, so a value chosen here can be pinned in
 * config later. Handles the user cannot actually reach are dropped; when the
 * availability lookup itself failed (`availableHandles` is null) the full
 * catalog is offered rather than an empty picker.
 */
export function buildModelOption(
  models: ListModelsResult,
  preferred?: string,
): SessionConfigOption | null {
  const available =
    models.availableHandles == null ? null : new Set(models.availableHandles);
  const entries = dedupeByHandle(
    models.entries.filter(
      (entry) => available == null || available.has(entry.handle),
    ),
  );
  if (entries.length === 0) return null;

  const options = entries.map((entry) => ({
    value: entry.handle,
    name: entry.label || entry.handle,
    // `displayName` is the pre-rename spelling of `name`; clients that have
    // not caught up to the rename (buzz-acp among them) read only that one.
    displayName: entry.label || entry.handle,
    ...(entry.description ? { description: entry.description } : {}),
  }));

  return {
    id: MODEL_CONFIG_ID,
    // Same story as `displayName` above: `configId` is the older spelling of
    // `id`, and a client reading only that must still find the selector.
    configId: MODEL_CONFIG_ID,
    name: "Model",
    displayName: "Model",
    category: "model",
    type: "select",
    currentValue: currentHandle(entries, preferred),
    options,
  } as SessionConfigOption;
}

/**
 * One option per handle.
 *
 * Letta lists a separate entry per reasoning tier of the same model, and they
 * share a handle — as ACP options those would be indistinguishable duplicates,
 * and picking one would be ambiguous. The default tier wins where present.
 */
function dedupeByHandle(
  entries: ListModelsResult["entries"],
): ListModelsResult["entries"] {
  const byHandle = new Map<string, ListModelsResult["entries"][number]>();
  for (const entry of entries) {
    const existing = byHandle.get(entry.handle);
    if (!existing || (entry.isDefault && !existing.isDefault)) {
      byHandle.set(entry.handle, entry);
    }
  }
  return [...byHandle.values()];
}

/** Replaces the current selection, keeping the option list as published. */
export function withCurrentValue(
  option: SessionConfigOption,
  value: string,
): SessionConfigOption {
  return { ...option, currentValue: value } as SessionConfigOption;
}

/**
 * The handle to show as selected: an explicitly configured model when it is
 * one of the offered handles, else the catalog default, else the first entry.
 */
function currentHandle(
  entries: ListModelsResult["entries"],
  preferred?: string,
): string {
  const first = entries[0];
  if (!first) throw new Error("currentHandle requires a non-empty catalog");
  if (preferred) {
    const match = entries.find(
      (entry) => entry.handle === preferred || entry.id === preferred,
    );
    if (match) return match.handle;
  }
  return (entries.find((entry) => entry.isDefault) ?? first).handle;
}
