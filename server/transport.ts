import type { StringFramedDroidClientTransport } from "@factory/droid-sdk/node";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const START_TIMEOUT_MS = 10_000;
const CLOSE_GRACE_MS = 1_000;
const CLOSE_FORCE_MS = 2_000;

export interface DroidTransportOptions {
  cwd?: string;
  /** Session environment overrides the daemon-resolved provider environment. */
  env?: Readonly<Record<string, string>>;
  startTimeoutMs?: number;
}

/**
 * Only frames SDK messages. The Factory SDK owns the JSON-RPC protocol, session
 * state, event conversion, and permissions. In particular, do not print either
 * child stream: both can contain private prompts, tool output, or credentials.
 */
class DroidProcessTransport implements StringFramedDroidClientTransport {
  private connected = false;
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private messageHandler?: (message: string) => void;
  private errorHandler?: (error: Error) => void;
  private errorNotified = false;
  private failure?: Error;
  private pendingFrames: string[] = [];
  private pendingBytes = 0;
  private partialFrame = "";
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", this.receive);
    child.stdout.on("error", this.streamError);
    // Consume stderr without retaining or logging potentially sensitive output.
    child.stderr.on("data", this.discardStderr);
    child.stderr.on("error", this.streamError);
    child.stdin.on("error", this.streamError);
    child.on("error", this.processError);
    child.on("exit", () => { this.connected = false; });
    child.once("close", (code, signal) => {
      this.connected = false;
      this.closed = true;
      this.resolveClosed();
      if (!this.closing) {
        this.fail(new Error(`Droid process closed (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}). Check the Droid CLI installation and login.`));
      }
    });
  }

  get isConnected(): boolean {
    return this.connected && !this.closing && !this.failure;
  }

  async waitForSpawn(timeoutMs: number): Promise<void> {
    // spawnProcess returns before Node emits spawn/error. The listeners below
    // are installed in the same synchronous call stack as process creation.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.child.off("spawn", spawned);
        this.child.off("error", failed);
      };
      const spawned = () => { cleanup(); this.connected = true; resolve(); };
      const failed = () => { cleanup(); reject(this.failure ?? new Error("Could not start Droid.")); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out starting the Droid process."));
      }, timeoutMs);
      this.child.once("spawn", spawned);
      this.child.once("error", failed);
    });
  }

  async send(message: string): Promise<void> {
    if (!this.isConnected) throw this.failure ?? new Error("Droid transport is closed.");
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(message.endsWith("\n") ? message : `${message}\n`, (error) => {
        if (error) reject(new Error("Could not write to the Droid process."));
        else resolve();
      });
    });
  }

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler;
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    this.pendingBytes = 0;
    for (const frame of frames) this.deliver(frame);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
    this.notifyError();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.connected = false;
    this.failure ??= new Error("Droid transport was closed.");
    // Store the promise before notifying the SDK: an error callback can itself
    // close its client, which calls back into this method.
    this.closePromise = Promise.resolve().then(() => this.closeProcess());
    this.notifyError();
    return this.closePromise;
  }

  private readonly discardStderr = () => {};
  private readonly streamError = () => {
    if (!this.closing) this.fail(new Error("Droid process stream failed."));
  };
  private readonly processError = (error: NodeJS.ErrnoException) => {
    if (!this.closing) {
      const code = error.code && /^[A-Z0-9_]+$/.test(error.code) ? ` (${error.code})` : "";
      this.fail(new Error(`Could not launch the Droid process${code}. Check the configured executable.`));
    }
  };
  private readonly receive = (chunk: string) => {
    if (this.closing || this.failure) return;
    this.partialFrame += chunk;
    let newline: number;
    while ((newline = this.partialFrame.indexOf("\n")) !== -1) {
      const frame = this.partialFrame.slice(0, newline).replace(/\r$/, "");
      this.partialFrame = this.partialFrame.slice(newline + 1);
      if (!frame.trim()) continue;
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
        this.fail(new Error("Droid sent an oversized protocol frame."));
        return;
      }
      if (this.messageHandler) this.deliver(frame);
      else {
        this.pendingBytes += Buffer.byteLength(frame);
        if (this.pendingBytes > MAX_FRAME_BYTES) {
          this.fail(new Error("Droid protocol startup buffer exceeded its limit."));
          return;
        }
        this.pendingFrames.push(frame);
      }
    }
    if (Buffer.byteLength(this.partialFrame) > MAX_FRAME_BYTES) {
      this.fail(new Error("Droid sent an oversized protocol frame."));
    }
  };

  private deliver(frame: string): void {
    if (this.failure) return;
    try {
      this.messageHandler?.(frame);
    } catch {
      this.fail(new Error("Droid SDK could not process a protocol frame."));
    }
  }

  private fail(error: Error): void {
    if (this.failure || this.closing) return;
    this.failure = error;
    this.connected = false;
    void this.close();
  }

  private notifyError(): void {
    if (!this.failure || !this.errorHandler || this.errorNotified) return;
    this.errorNotified = true;
    try {
      this.errorHandler(this.failure);
    } catch {
      // A consumer callback must never prevent process cleanup.
    }
  }

  private async waitClosed(timeoutMs: number): Promise<boolean> {
    if (this.closed) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.closedPromise.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async closeProcess(): Promise<void> {
    this.child.stdin.end();
    if (!(await this.waitClosed(CLOSE_GRACE_MS))) {
      // The helper also terminates the process tree behind Windows launchers.
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          terminateProcess(this.child).catch(() => {}),
          new Promise<void>((resolve) => { killTimer = setTimeout(resolve, CLOSE_FORCE_MS); }),
        ]);
      } finally {
        if (killTimer) clearTimeout(killTimer);
      }
      await this.waitClosed(CLOSE_FORCE_MS);
    }
    this.child.stdout.off("data", this.receive);
    this.child.stderr.off("data", this.discardStderr);
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.messageHandler = undefined;
    this.errorHandler = undefined;
    this.pendingFrames = [];
    this.pendingBytes = 0;
    this.partialFrame = "";
  }
}

/** Launch using Paseo's resolved command/args/environment, including CLI login. */
export async function createDroidTransport(
  launch: ProviderLaunch,
  options: DroidTransportOptions = {},
): Promise<StringFramedDroidClientTransport> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnProcess(launch.command, [
      ...launch.args,
      "exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc",
    ], {
      cwd: options.cwd,
      env: { ...launch.env, ...options.env },
      stdio: "pipe",
    });
  } catch {
    throw new Error("Could not launch Droid. Check the configured executable.");
  }
  const transport = new DroidProcessTransport(child);
  try {
    await transport.waitForSpawn(options.startTimeoutMs ?? START_TIMEOUT_MS);
    return transport;
  } catch (error) {
    await transport.close();
    throw error;
  }
}

/** Bound initialization/catalog work and release the process on failure. */
export async function withDroidDeadline<T>(
  transport: StringFramedDroidClientTransport,
  operation: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Droid initialization timed out. Check the CLI login and connection.")), timeoutMs);
      }),
    ]);
  } catch (error) {
    await transport.close();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
