import { describe, expect, test } from "bun:test";
import type { BridgeMessage } from "./types";
import { FrontendRegistry, formatPeerMessageForCodex } from "./frontend-registry";

function makeFrontendMessage(source: "claude" | "gemini", content: string): BridgeMessage {
  return {
    id: `msg_${source}_${Date.now()}`,
    source,
    content,
    timestamp: Date.now(),
  };
}

describe("FrontendRegistry", () => {
  test("keeps multiple attached frontends instead of replacing the older one", () => {
    const registry = new FrontendRegistry<{ id: string }>();

    registry.attach({ id: "claude-1", source: "claude", name: "Claude" }, { id: "socket-1" });
    registry.attach({ id: "gemini-1", source: "gemini", name: "Gemini" }, { id: "socket-2" });

    const attachedIds = registry.list().map((entry) => entry.identity.id);
    expect(attachedIds).toEqual(["claude-1", "gemini-1"]);
  });

  test("broadcastExcept skips the sending frontend and reaches the others", () => {
    const registry = new FrontendRegistry<{ id: string }>();
    const deliveries: Array<{ socketId: string; message: BridgeMessage }> = [];

    registry.attach({ id: "claude-1", source: "claude", name: "Claude" }, { id: "socket-1" });
    registry.attach({ id: "gemini-1", source: "gemini", name: "Gemini" }, { id: "socket-2" });

    registry.broadcastExcept("claude-1", makeFrontendMessage("claude", "hello from claude"), (socket, message) => {
      deliveries.push({ socketId: socket.id, message });
      return true;
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].socketId).toBe("socket-2");
    expect(deliveries[0].message.content).toBe("hello from claude");
  });

  test("caps disconnected frontend backlog to the configured size", () => {
    const registry = new FrontendRegistry<{ id: string }>(2);

    registry.attach({ id: "gemini-1", source: "gemini", name: "Gemini" }, { id: "socket-2" });
    registry.detach("gemini-1");

    registry.broadcast(makeFrontendMessage("claude", "first"), () => true);
    registry.broadcast(makeFrontendMessage("claude", "second"), () => true);
    registry.broadcast(makeFrontendMessage("claude", "third"), () => true);

    expect(registry.getPending("gemini-1").map((message) => message.content)).toEqual(["second", "third"]);
  });
});

describe("formatPeerMessageForCodex", () => {
  test("prefixes sender name so Codex can distinguish Claude and Gemini turns", () => {
    expect(formatPeerMessageForCodex(makeFrontendMessage("gemini", "check this patch"), "Gemini"))
      .toContain("From Gemini:");
  });
});
