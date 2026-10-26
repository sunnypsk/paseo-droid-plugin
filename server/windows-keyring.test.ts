import assert from "node:assert/strict";
import { test } from "node:test";
import { readWindowsKeyringKey } from "./windows-keyring";

test("Windows keyring reads only the exact Factory keytar target in a bounded hidden process", async () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  for (const development of [false, true]) {
    const result = await readWindowsKeyringKey(development, async (file, args, options) => {
      assert.ok(file.endsWith("powershell.exe"));
      assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
      const script = Buffer.from(args[4], "base64").toString("utf16le");
      assert.ok(script.includes(`Read('Factory CLI/auth-encryption-key${development ? "-dev" : ""}')`));
      assert.match(script, /CredRead\(target, 1, 0/);
      assert.match(script, /finally \{ CredFree\(pointer\); \}/);
      assert.doesNotMatch(script, /CredWrite|CredDelete|CredEnumerate/);
      assert.deepEqual(options, { timeout: 5000, maxBuffer: 4096, windowsHide: true });
      return { stdout: `${key}\r\n` };
    });
    assert.equal(result, key);
  }
});

test("invalid credential output stays out of surfaced errors", async () => {
  await assert.rejects(readWindowsKeyringKey(false, async () => ({ stdout: "private-invalid-key" })),
    (error: Error) => /Invalid Factory/.test(error.message) && !error.message.includes("private-invalid-key"));
});
