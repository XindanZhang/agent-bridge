import { describe, expect, test } from "bun:test";
import { buildFrontendIdentity } from "./frontend-identity";

describe("buildFrontendIdentity", () => {
  test("defaults to a stable id derived from source and frontend name", () => {
    expect(buildFrontendIdentity("gemini", "Gemini Main")).toEqual({
      id: "gemini_gemini-main",
      source: "gemini",
      name: "Gemini Main",
    });
  });

  test("prefers an explicit id override when provided", () => {
    expect(buildFrontendIdentity("claude", "Claude", "claude_primary")).toEqual({
      id: "claude_primary",
      source: "claude",
      name: "Claude",
    });
  });
});
