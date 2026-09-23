# List processes with readable working directories. A failure to inspect a process
# leaves it out: archive must never infer ownership from its command line.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ProcessDirectory {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr read);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr buffer, int size, out int returned);

  static byte[] Read(IntPtr process, long address, int size) {
    if (address <= 0 || size <= 0 || size > 32768) return null;
    byte[] bytes = new byte[size];
    IntPtr count;
    if (!ReadProcessMemory(process, new IntPtr(address), bytes, size, out count) || count.ToInt64() != size) return null;
    return bytes;
  }

  static long Pointer(byte[] bytes, int offset, bool wow64) {
    return wow64 ? BitConverter.ToUInt32(bytes, offset) : unchecked((long)BitConverter.ToUInt64(bytes, offset));
  }

  public static string Get(int pid) {
    // PROCESS_QUERY_INFORMATION | PROCESS_VM_READ. Inaccessible processes are skipped.
    IntPtr process = OpenProcess(0x410, false, pid);
    if (process == IntPtr.Zero) return null;
    try {
      int returned;
      IntPtr basic = Marshal.AllocHGlobal(IntPtr.Size * 6);
      IntPtr wow = Marshal.AllocHGlobal(IntPtr.Size);
      long peb;
      bool wow64;
      try {
        if (NtQueryInformationProcess(process, 0, basic, IntPtr.Size * 6, out returned) != 0) return null;
        peb = Marshal.ReadIntPtr(basic, IntPtr.Size).ToInt64();
        Marshal.WriteIntPtr(wow, IntPtr.Zero);
        wow64 = NtQueryInformationProcess(process, 26, wow, IntPtr.Size, out returned) == 0 && Marshal.ReadIntPtr(wow) != IntPtr.Zero;
        if (wow64) peb = Marshal.ReadIntPtr(wow).ToInt64();
      } finally {
        Marshal.FreeHGlobal(basic);
        Marshal.FreeHGlobal(wow);
      }
      bool is32 = wow64 || IntPtr.Size == 4;
      // PEB.ProcessParameters: x64 +0x20, x86/WOW64 +0x10.
      byte[] p = Read(process, peb + (is32 ? 0x10 : 0x20), is32 ? 4 : 8);
      if (p == null) return null;
      long parameters = Pointer(p, 0, is32);
      // RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath:
      // x64 +0x38, x86 +0x24. UNICODE_STRING.Buffer is +8/+4.
      byte[] path = Read(process, parameters + (is32 ? 0x24 : 0x38), is32 ? 8 : 16);
      if (path == null) return null;
      int length = BitConverter.ToUInt16(path, 0);
      if (length < 2 || length > 32768 || length % 2 != 0) return null;
      long buffer = Pointer(path, is32 ? 4 : 8, is32);
      byte[] value = Read(process, buffer, length);
      return value == null ? null : Encoding.Unicode.GetString(value).TrimEnd('\0');
    } catch {
      return null;
    } finally {
      CloseHandle(process);
    }
  }
}
'@

$rows = foreach ($process in Get-CimInstance Win32_Process) {
  $cwd = [ProcessDirectory]::Get([int]$process.ProcessId)
  [pscustomobject]@{
    pid = [int]$process.ProcessId
    ppid = [int]$process.ParentProcessId
    name = [string]$process.Name
    command = if ($process.CommandLine) { [string]$process.CommandLine } else { [string]$process.Name }
    cwd = $cwd
  }
}
ConvertTo-Json -InputObject @($rows) -Compress -Depth 3
