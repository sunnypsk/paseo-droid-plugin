import assert from "node:assert/strict";
import { test } from "node:test";
import { DroidClient } from "@factory/droid-sdk/node";
import { createDroidTransport, withDroidDeadline } from "./transport";

function launch(script: string) {
  return {
    command: process.execPath,
    args: ["-e", script],
    env: { TRANSPORT_TEST_VALUE: "from-launch" },
  };
}

test("frames fragmented output and honors argument prefix and resolved environment", async () => {
  const transport = await createDroidTransport(launch(`
    process.stdout.write('{"value":"' + process.env.TRANSPORT_TEST_VALUE);
    process.stdout.write('","argv":' + JSON.stringify(process.argv.slice(1)) + '}\\n\\r\\n');
    process.stdin.on('data', (chunk) => process.stdout.write(chunk));
    process.stdin.on('end', () => process.exit(0));
  `), { env: { TRANSPORT_TEST_VALUE: "session-override" } });
  try {
    const frames: string[] = [];
    let received!: () => void;
    const done = new Promise<void>((resolve) => { received = resolve; });
    transport.onMessage((frame) => { frames.push(frame); if (frames.length === 2) received(); });
    transport.onError((error) => { throw error; });
    await transport.send('{"hello":"廣東話"}');
    await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("No frames")), 1_000))]);
    assert.deepEqual(JSON.parse(frames[0]), {
      value: "session-override",
      argv: ["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc"],
    });
    assert.deepEqual(JSON.parse(frames[1]), { hello: "廣東話" });
  } finally {
    await transport.close();
  }
});

test("initialization deadline stops a process that ignores stdin closure", async () => {
  const transport = await createDroidTransport(launch(`
    process.stdin.resume();
    process.stdin.on('end', () => {});
    setInterval(() => {}, 1_000);
  `));
  const started = Date.now();
  await assert.rejects(
    withDroidDeadline(transport, () => new Promise<never>(() => {}), 20),
    /initialization timed out/,
  );
  assert.equal(transport.isConnected, false);
  assert.ok(Date.now() - started < 5_500);
  await transport.close();
  await assert.rejects(transport.send("{}"), /closed/);
});

test("unexpected process exit reports a bounded diagnostic without stderr", async () => {
  const transport = await createDroidTransport(launch(`
    process.stderr.write('private-token-test-sentinel');
    setTimeout(() => process.exit(3), 30);
  `));
  const failed = new Promise<Error>((resolve) => transport.onError(resolve));
  const error = await failed;
  assert.match(error.message, /exit 3/);
  assert.doesNotMatch(error.message, /private-token-test-sentinel/);
  assert.equal(transport.isConnected, false);
  await transport.close();
});

test("missing executable rejects without exposing supplied arguments", async () => {
  await assert.rejects(createDroidTransport({
    command: "/this/droid/executable/does-not-exist",
    args: ["private-argument-sentinel"],
    env: {},
  }), (error: Error) => /ENOENT/.test(error.message) && !error.message.includes("private-argument-sentinel"));
});

test("external transport close rejects an in-flight SDK request immediately", async () => {
  const transport = await createDroidTransport(launch(`
    process.stdin.resume();
    process.stdin.on('end', () => {});
    setInterval(() => {}, 1_000);
  `));
  const client = new DroidClient({ transport, requestTimeout: 10_000 });
  // The fake CLI never answers, so only a transport error can settle this.
  const pending = client.listModels().then(
    () => { throw new Error("Unexpected SDK response"); },
    (error: unknown) => error,
  );
  const closing = transport.close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const error = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("SDK request remained pending after close")), 250);
      }),
    ]);
    assert.ok(error instanceof Error);
    assert.match(error.message, /transport was closed/);
  } finally {
    if (timer) clearTimeout(timer);
    await closing;
    await client.close();
  }
});

test("close notification is once, reentrant, and tolerates a throwing handler", async () => {
  const transport = await createDroidTransport(launch(`process.stdin.resume();`));
  let notifications = 0;
  let reentrant: Promise<void> | undefined;
  transport.onError(() => {
    notifications += 1;
    reentrant = transport.close();
    throw new Error("Consumer callback error");
  });
  const closing = transport.close();
  assert.equal(reentrant, closing);
  assert.equal(transport.close(), closing);
  await closing;
  assert.equal(notifications, 1);
  assert.equal(transport.isConnected, false);
});
