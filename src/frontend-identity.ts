import type { FrontendIdentity, FrontendSource } from "./types";

function normalizeIdPart(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "frontend";
}

export function buildFrontendIdentity(
  source: FrontendSource,
  name: string,
  explicitId = process.env.AGENTBRIDGE_FRONTEND_ID,
): FrontendIdentity {
  return {
    id: explicitId && explicitId.trim().length > 0
      ? explicitId
      : `${source}_${normalizeIdPart(name)}`,
    source,
    name,
  };
}
