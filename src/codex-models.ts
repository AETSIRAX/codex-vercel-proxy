import { stringValue } from "./utils.js";

export interface CodexModelInfo {
  slug: string;
  useResponsesLite: boolean;
  supportedReasoningEfforts: readonly string[];
  defaultReasoningEffort: string;
  // Effort Codex substitutes for the client-side "ultra" level when the model
  // defines one (codex-rs: ModelInfo.multi_agent_reasoning_effort).
  multiAgentReasoningEffort?: string;
  serviceTiers: readonly string[];
}

// Snapshot of codex-rs/models-manager/models.json (openai/codex main, 2026-09-05).
// Only the fields the proxy needs for request shaping are kept here; the order
// follows the catalog priority so the first entry is Codex's default model.
const EFFORTS_UP_TO_ULTRA = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
const EFFORTS_UP_TO_MAX = ["low", "medium", "high", "xhigh", "max"] as const;
const EFFORTS_UP_TO_XHIGH = ["low", "medium", "high", "xhigh"] as const;

export const CODEX_MODEL_CATALOG: readonly CodexModelInfo[] = [
  {
    slug: "gpt-6-astra",
    useResponsesLite: true,
    supportedReasoningEfforts: EFFORTS_UP_TO_ULTRA,
    defaultReasoningEffort: "low",
    multiAgentReasoningEffort: "xhigh",
    serviceTiers: ["priority"],
  },
  {
    slug: "gpt-5.6-sol",
    useResponsesLite: true,
    supportedReasoningEfforts: EFFORTS_UP_TO_ULTRA,
    defaultReasoningEffort: "low",
    serviceTiers: ["priority", "ultrafast"],
  },
  {
    slug: "gpt-5.6-terra",
    useResponsesLite: true,
    supportedReasoningEfforts: EFFORTS_UP_TO_ULTRA,
    defaultReasoningEffort: "medium",
    serviceTiers: ["priority"],
  },
  {
    slug: "gpt-5.6-luna",
    useResponsesLite: true,
    supportedReasoningEfforts: EFFORTS_UP_TO_MAX,
    defaultReasoningEffort: "medium",
    serviceTiers: ["priority"],
  },
  {
    slug: "gpt-daybreak-blue-latest",
    useResponsesLite: true,
    supportedReasoningEfforts: EFFORTS_UP_TO_ULTRA,
    defaultReasoningEffort: "low",
    serviceTiers: [],
  },
  {
    slug: "gpt-daybreak-red-latest",
    useResponsesLite: true,
    supportedReasoningEfforts: EFFORTS_UP_TO_ULTRA,
    defaultReasoningEffort: "medium",
    serviceTiers: [],
  },
  {
    slug: "gpt-5.5",
    useResponsesLite: false,
    supportedReasoningEfforts: EFFORTS_UP_TO_XHIGH,
    defaultReasoningEffort: "medium",
    serviceTiers: ["priority"],
  },
  {
    slug: "gpt-5.4",
    useResponsesLite: false,
    supportedReasoningEfforts: EFFORTS_UP_TO_XHIGH,
    defaultReasoningEffort: "medium",
    serviceTiers: ["priority"],
  },
  {
    slug: "gpt-5.4-mini",
    useResponsesLite: false,
    supportedReasoningEfforts: EFFORTS_UP_TO_XHIGH,
    defaultReasoningEffort: "medium",
    serviceTiers: [],
  },
  {
    slug: "gpt-5.2",
    useResponsesLite: false,
    supportedReasoningEfforts: EFFORTS_UP_TO_XHIGH,
    defaultReasoningEffort: "medium",
    serviceTiers: [],
  },
  {
    slug: "codex-auto-review",
    useResponsesLite: true,
    supportedReasoningEfforts: EFFORTS_UP_TO_MAX,
    defaultReasoningEffort: "medium",
    serviceTiers: ["priority"],
  },
];

// Slugs missing from the snapshot fall back to their model family so a newly
// shipped variant (for example another gpt-6-* model) still gets the lite
// protocol before the catalog above is refreshed.
const RESPONSES_LITE_MODEL_PREFIXES = ["gpt-6", "gpt-5.6", "gpt-daybreak", "codex-auto-review"];

const catalogBySlug = new Map(CODEX_MODEL_CATALOG.map((info) => [info.slug, info]));

export function lookupCodexModel(model: string | undefined): CodexModelInfo | undefined {
  const slug = stringValue(model);
  return slug === undefined ? undefined : catalogBySlug.get(slug);
}

export function isResponsesLiteModel(model: string | undefined): boolean {
  const slug = stringValue(model);
  if (slug === undefined) {
    return false;
  }
  const known = catalogBySlug.get(slug);
  if (known !== undefined) {
    return known.useResponsesLite;
  }
  return RESPONSES_LITE_MODEL_PREFIXES.some((prefix) => slug === prefix || slug.startsWith(`${prefix}-`));
}

// Mirrors codex-rs/core/src/client.rs reasoning_effort_for_request: "ultra" is a
// client-side level that becomes the model's multi-agent effort (or "max"), and
// "persistent" is spelled "disabled" on the wire.
export function reasoningEffortForRequest(model: string | undefined, effort: string): string {
  if (effort === "persistent") {
    return "disabled";
  }
  if (effort !== "ultra") {
    return effort;
  }
  const info = lookupCodexModel(model);
  if (info === undefined) {
    return "max";
  }
  const supported = info.supportedReasoningEfforts;
  const multiAgent = info.multiAgentReasoningEffort;
  if (multiAgent !== undefined && multiAgent !== "ultra" && supported.includes(multiAgent)) {
    return multiAgent;
  }
  if (supported.includes("max")) {
    return "max";
  }
  return [...supported].reverse().find((level) => level !== "ultra") ?? "medium";
}

export function supportedServiceTiers(model: string | undefined): readonly string[] | undefined {
  return lookupCodexModel(model)?.serviceTiers;
}
