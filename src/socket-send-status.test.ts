import { describe, expect, test } from "bun:test";
import { classifySocketSendStatus } from "./socket-send-status";

describe("classifySocketSendStatus", () => {
  test("treats Bun backpressure as accepted delivery, not a dropped send", () => {
    expect(classifySocketSendStatus(-1)).toBe("backpressure");
    expect(classifySocketSendStatus(12)).toBe("sent");
    expect(classifySocketSendStatus(0)).toBe("dropped");
  });
});
