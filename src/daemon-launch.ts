import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface DaemonLaunchCoordinatorOptions {
  controlPort: number;
  daemonPath: string;
  stateDir: string;
  pidFile: string;
  lockFile: string;
  log: (msg: string) => void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetchHealth?: () => Promise<boolean>;
  launchDetached?: () => Promise<void> | void;
  processAlive?: (pid: number) => boolean;
  readProcessCommand?: (pid: number) => string;
  sleep?: (ms: number) => Promise<void>;
}

export class DaemonLaunchCoordinator {
  private readonly controlPort: number;
  private readonly daemonPath: string;
  private readonly stateDir: string;
  private readonly pidFile: string;
  private readonly lockFile: string;
  private readonly log: (msg: string) => void;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchHealthFn: () => Promise<boolean>;
  private readonly launchDetachedFn: () => Promise<void> | void;
  private readonly processAliveFn: (pid: number) => boolean;
  private readonly readProcessCommandFn: (pid: number) => string;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(opts: DaemonLaunchCoordinatorOptions) {
    this.controlPort = opts.controlPort;
    this.daemonPath = opts.daemonPath;
    this.stateDir = opts.stateDir;
    this.pidFile = opts.pidFile;
    this.lockFile = opts.lockFile;
    this.log = opts.log;
    this.cwd = opts.cwd ?? process.cwd();
    this.env = opts.env ?? process.env;
    this.fetchHealthFn = opts.fetchHealth ?? (async () => {
      try {
        const response = await fetch(this.healthUrl);
        return response.ok;
      } catch {
        return false;
      }
    });
    this.launchDetachedFn = opts.launchDetached ?? (() => {
      const child = spawn(process.execPath, ["run", this.daemonPath], {
        cwd: this.cwd,
        env: {
          ...this.env,
          AGENTBRIDGE_CONTROL_PORT: String(this.controlPort),
          AGENTBRIDGE_STATE_DIR: this.stateDir,
        },
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    });
    this.processAliveFn = opts.processAlive ?? isProcessAlive;
    this.readProcessCommandFn = opts.readProcessCommand ?? ((pid: number) =>
      execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" }).trim());
    this.sleepFn = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get healthUrl() {
    return `http://127.0.0.1:${this.controlPort}/healthz`;
  }

  get controlWsUrl() {
    return `ws://127.0.0.1:${this.controlPort}/ws`;
  }

  readPid() {
    try {
      const raw = readFileSync(this.pidFile, "utf-8").trim();
      if (!raw) return null;
      const pid = Number.parseInt(raw, 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  removePidFile() {
    try {
      unlinkSync(this.pidFile);
    } catch {}
  }

  async ensureRunning() {
    if (await this.fetchHealthFn()) {
      return;
    }

    const existingPid = this.readPid();
    if (existingPid) {
      if (this.processAliveFn(existingPid)) {
        if (this.isDaemonProcess(existingPid)) {
          try {
            await this.waitForHealthy(12, 250);
            return;
          } catch {
            throw new Error(
              `Found existing daemon process ${existingPid}, but control port ${this.controlPort} never became healthy.`,
            );
          }
        }
        this.log(`Pid ${existingPid} is alive but not an AgentBridge daemon, removing stale pid file`);
      }
      this.removePidFile();
    }

    const lockAcquired = this.acquireLock();
    if (!lockAcquired) {
      this.log("Another process is starting the daemon, waiting for health...");
      await this.waitForHealthy();
      return;
    }

    try {
      this.log(`Launching detached daemon on control port ${this.controlPort}`);
      await this.launchDetachedFn();
      await this.waitForHealthy();
    } finally {
      this.releaseLock();
    }
  }

  async waitForHealthy(maxRetries = 40, delayMs = 250) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (await this.fetchHealthFn()) return;
      await this.sleepFn(delayMs);
    }
    throw new Error(`Timed out waiting for AgentBridge daemon health on ${this.healthUrl}`);
  }

  private isDaemonProcess(pid: number) {
    try {
      const command = this.readProcessCommandFn(pid);
      return command.includes("daemon") && (command.includes("agentbridge") || command.includes("agent_bridge"));
    } catch {
      return false;
    }
  }

  private acquireLock(depth = 0): boolean {
    if (depth > 1) {
      this.log("Lock acquisition failed after retry, proceeding without lock");
      return true;
    }

    try {
      const fd = openSync(this.lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return true;
    } catch (err: any) {
      if (err.code !== "EEXIST") {
        this.log(`Warning: could not acquire startup lock: ${err.message}`);
        return true;
      }

      try {
        const holderPid = Number.parseInt(readFileSync(this.lockFile, "utf-8").trim(), 10);
        if (Number.isFinite(holderPid) && !this.processAliveFn(holderPid)) {
          this.log(`Stale lock file from dead process ${holderPid}, removing`);
          this.releaseLock();
          return this.acquireLock(depth + 1);
        }
      } catch {
        this.log("Cannot read lock file, removing stale lock");
        this.releaseLock();
        return this.acquireLock(depth + 1);
      }

      return false;
    }
  }

  private releaseLock() {
    try {
      unlinkSync(this.lockFile);
    } catch {}
  }
}
