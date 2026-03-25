import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateDirResolver } from "./state-dir";

describe("StateDirResolver", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-state-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("uses the explicit override when provided", () => {
    const resolver = new StateDirResolver(tempDir);
    expect(resolver.dir).toBe(tempDir);
  });

  test("returns runtime file paths inside the state directory", () => {
    const resolver = new StateDirResolver(tempDir);

    expect(resolver.pidFile).toBe(join(tempDir, "daemon.pid"));
    expect(resolver.lockFile).toBe(join(tempDir, "daemon.lock"));
    expect(resolver.statusFile).toBe(join(tempDir, "status.json"));
    expect(resolver.logFile).toBe(join(tempDir, "agentbridge.log"));
    expect(resolver.killedFile).toBe(join(tempDir, "killed"));
  });

  test("ensure creates the directory and is idempotent", () => {
    const nested = join(tempDir, "nested", "state");
    const resolver = new StateDirResolver(nested);

    resolver.ensure();
    resolver.ensure();

    writeFileSync(join(nested, "ok.txt"), "ok");
    expect(existsSync(join(nested, "ok.txt"))).toBe(true);
  });
});
