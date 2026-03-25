import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DaemonLaunchCoordinator } from "./daemon-launch";

describe("DaemonLaunchCoordinator", () => {
  let tempDir: string;
  let pidFile: string;
  let lockFile: string;
  let logs: string[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-launch-test-"));
    pidFile = join(tempDir, "daemon.pid");
    lockFile = join(tempDir, "daemon.lock");
    logs = [];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("launches when the pid file points at a live process that is not the daemon", async () => {
    let healthy = false;
    let launches = 0;
    writeFileSync(pidFile, "1234\n", "utf-8");

    const lifecycle = new DaemonLaunchCoordinator({
      controlPort: 4502,
      daemonPath: "/tmp/daemon.ts",
      stateDir: tempDir,
      pidFile,
      lockFile,
      log: (msg) => logs.push(msg),
      fetchHealth: async () => healthy,
      launchDetached: async () => {
        launches++;
        healthy = true;
      },
      processAlive: (pid) => pid === 1234,
      readProcessCommand: () => "python some-other-process.py",
      sleep: async () => {},
    });

    await lifecycle.ensureRunning();

    expect(launches).toBe(1);
    expect(logs.some((line) => line.includes("not an AgentBridge daemon"))).toBe(true);
  });

  test("waits for another launcher when a live lock holder already exists", async () => {
    let healthChecks = 0;
    writeFileSync(lockFile, "777\n", "utf-8");

    const lifecycle = new DaemonLaunchCoordinator({
      controlPort: 4502,
      daemonPath: "/tmp/daemon.ts",
      stateDir: tempDir,
      pidFile,
      lockFile,
      log: (msg) => logs.push(msg),
      fetchHealth: async () => {
        healthChecks++;
        return healthChecks >= 2;
      },
      launchDetached: async () => {
        throw new Error("should not launch");
      },
      processAlive: (pid) => pid === 777,
      readProcessCommand: () => "bun run daemon.ts agentbridge",
      sleep: async () => {},
    });

    await lifecycle.ensureRunning();

    expect(healthChecks).toBeGreaterThanOrEqual(2);
    expect(logs.some((line) => line.includes("Another process is starting the daemon"))).toBe(true);
  });

  test("recovers a stale lock file and launches", async () => {
    let healthy = false;
    let launches = 0;
    writeFileSync(lockFile, "999\n", "utf-8");

    const lifecycle = new DaemonLaunchCoordinator({
      controlPort: 4502,
      daemonPath: "/tmp/daemon.ts",
      stateDir: tempDir,
      pidFile,
      lockFile,
      log: (msg) => logs.push(msg),
      fetchHealth: async () => healthy,
      launchDetached: async () => {
        launches++;
        healthy = true;
      },
      processAlive: () => false,
      readProcessCommand: () => "",
      sleep: async () => {},
    });

    await lifecycle.ensureRunning();

    expect(launches).toBe(1);
    expect(existsSync(lockFile)).toBe(false);
    expect(logs.some((line) => line.includes("Stale lock file"))).toBe(true);
  });
});
