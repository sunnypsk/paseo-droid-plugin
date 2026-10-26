import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
type Execute = (file: string, args: string[], options: { timeout: number; maxBuffer: number; windowsHide: boolean }) => Promise<{ stdout: string }>;

/** Read only keytar's exact Factory encryption-key entry, never enumerate or write credentials. */
export async function readWindowsKeyringKey(development: boolean, run: Execute = execute): Promise<string> {
  // keytar stores UTF-8 bytes in CRED_TYPE_GENERIC under service/account.
  // https://github.com/atom/node-keytar/blob/master/src/keytar_win.cc
  const target = `Factory CLI/auth-encryption-key${development ? "-dev" : ""}`;
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FactoryQuotaCredential {
  [StructLayout(LayoutKind.Sequential)]
  struct Credential {
    public uint Flags, Type;
    public IntPtr TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes, TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr credential);
  public static string Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) throw new Exception("Factory keyring entry unavailable");
    try {
      var value = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      if (value.CredentialBlobSize == 0 || value.CredentialBlobSize > 4096) throw new Exception("Invalid Factory keyring entry");
      var bytes = new byte[(int)value.CredentialBlobSize];
      Marshal.Copy(value.CredentialBlob, bytes, 0, bytes.Length);
      return Encoding.UTF8.GetString(bytes);
    } finally { CredFree(pointer); }
  }
}
'@
[Console]::Write([FactoryQuotaCredential]::Read('${target}'))
`;
  const result = await run(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { timeout: 5000, maxBuffer: 4096, windowsHide: true });
  const key = result.stdout.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32)
    throw new Error("Invalid Factory keyring encryption key.");
  return key;
}
