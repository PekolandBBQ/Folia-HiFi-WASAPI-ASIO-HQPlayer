'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseBoundedResponse } = require('./soloistOwnedAppliance.cjs');

// Protect only a new, empty main-owned runtime directory before writing keys.
// Native handles hold the whole ancestry without ShareDelete; ACL changes use
// the held directory handle, never a second path lookup. Nothing prints a SID.
const fail = code => Object.assign(new Error(`Spotify private directory: ${code}`), { code });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys;
const safePath = value => typeof value === 'string' && value.length <= 4096 && /^[A-Za-z]:[\\/]/.test(value)
  && !/[\x00-\x1f\x7f"<>|?*]/.test(value) && value.split(/[\\/]/).slice(1).every(part => part && !part.includes(':') && part !== '.' && part !== '..' && !/[. ]$/.test(part));
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$handles = New-Object System.Collections.Generic.List[System.IDisposable]
try {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class FoliaPrivateDirectoryGate {
 [StructLayout(LayoutKind.Sequential)] public struct FileTime { public uint Low, High; }
 [StructLayout(LayoutKind.Sequential)] public struct Info { public uint Attributes; public FileTime Creation, Access, Write; public uint Device, SizeHigh, SizeLow, Links, InodeHigh, InodeLow; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info information);
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string value,uint revision,out IntPtr descriptor,out uint size);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorOwner(IntPtr descriptor,out IntPtr owner,out bool defaulted);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,out bool present,out IntPtr dacl,out bool defaulted);
 [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(SafeFileHandle handle,int objectType,uint information,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
 [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle handle,int objectType,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
 public static SafeFileHandle Open(string value,bool mutate) {
   // BACKUP_SEMANTICS + OPEN_REPARSE_POINT; ShareRead/Write excludes ShareDelete.
   var handle=CreateFileW(value,mutate ? 0x000E0080u : 0x80u,3u,IntPtr.Zero,3u,0x02200000u,IntPtr.Zero);
   if(handle.IsInvalid) { handle.Dispose(); throw new InvalidOperationException("PRIVATE_DIRECTORY_PERMISSION_FAILED"); }
   return handle;
 }
 public static void Verify(SafeFileHandle handle,string device,string inode) {
   Info value;
   if(!GetFileInformationByHandle(handle,out value)) throw new InvalidOperationException("PRIVATE_DIRECTORY_CHANGED");
   if((value.Attributes & 0x10u)==0 || (value.Attributes & 0x400u)!=0) throw new InvalidOperationException("PRIVATE_DIRECTORY_UNSAFE");
   ulong actual=((ulong)value.InodeHigh<<32)|value.InodeLow;
   if(value.Device.ToString(System.Globalization.CultureInfo.InvariantCulture)!=device || actual.ToString(System.Globalization.CultureInfo.InvariantCulture)!=inode)
     throw new InvalidOperationException("PRIVATE_DIRECTORY_CHANGED");
 }
 public static void Protect(SafeFileHandle handle) {
   string sid=WindowsIdentity.GetCurrent().User.Value;
   IntPtr previousOwner,previousGroup,previousDacl,previousSacl,previous=IntPtr.Zero;
   try {
     if(GetSecurityInfo(handle,1,1u,out previousOwner,out previousGroup,out previousDacl,out previousSacl,out previous)!=0
       || previousOwner==IntPtr.Zero || new SecurityIdentifier(previousOwner).Value!=sid)
       throw new InvalidOperationException("PRIVATE_DIRECTORY_PERMISSION_FAILED");
   } finally { if(previous!=IntPtr.Zero) LocalFree(previous); }
   IntPtr descriptor=IntPtr.Zero;
   try {
     uint size; IntPtr owner,dacl; bool present,defaulted;
     if(!ConvertStringSecurityDescriptorToSecurityDescriptorW("O:"+sid+"D:P(A;OICI;FA;;;"+sid+")",1u,out descriptor,out size)
       || !GetSecurityDescriptorOwner(descriptor,out owner,out defaulted)
       || !GetSecurityDescriptorDacl(descriptor,out present,out dacl,out defaulted) || !present
       || SetSecurityInfo(handle,1,0x80000005u,owner,IntPtr.Zero,dacl,IntPtr.Zero)!=0)
       throw new InvalidOperationException("PRIVATE_DIRECTORY_PERMISSION_FAILED");
   } finally { if(descriptor!=IntPtr.Zero) LocalFree(descriptor); }
   IntPtr actualOwner,group,actualDacl,sacl,actual=IntPtr.Zero;
   try {
     if(GetSecurityInfo(handle,1,5u,out actualOwner,out group,out actualDacl,out sacl,out actual)!=0)
       throw new InvalidOperationException("PRIVATE_DIRECTORY_PERMISSION_FAILED");
     uint size=GetSecurityDescriptorLength(actual); if(size==0 || size>65536) throw new InvalidOperationException("PRIVATE_DIRECTORY_PERMISSION_FAILED");
     byte[] bytes=new byte[size]; Marshal.Copy(actual,bytes,0,(int)size);
     var value=new RawSecurityDescriptor(bytes,0);
     var ace=value.DiscretionaryAcl!=null && value.DiscretionaryAcl.Count==1 ? value.DiscretionaryAcl[0] as CommonAce : null;
     if(value.Owner==null || value.Owner.Value!=sid || (value.ControlFlags & ControlFlags.DiscretionaryAclProtected)==0
       || ace==null || ace.SecurityIdentifier.Value!=sid || ace.AceQualifier!=AceQualifier.AccessAllowed
       || ace.AccessMask!=0x1F01FF || ace.AceFlags!=(AceFlags.ObjectInherit|AceFlags.ContainerInherit))
       throw new InvalidOperationException("PRIVATE_DIRECTORY_PERMISSION_FAILED");
   } finally { if(actual!=IntPtr.Zero) LocalFree(actual); }
 }
}
'@ | Out-Null
$raw=[Console]::In.ReadToEnd()
if([Text.Encoding]::UTF8.GetByteCount($raw) -gt 65536) { throw 'PRIVATE_DIRECTORY_UNSAFE' }
$value=$raw | ConvertFrom-Json
if((@($value.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'device,directory,inode,parents' -or
  $value.directory -isnot [string] -or $value.device -isnot [string] -or $value.inode -isnot [string] -or
  $value.device -notmatch '^\d{1,20}$' -or $value.inode -notmatch '^\d{1,20}$' -or
  $value.directory -notmatch '^[A-Za-z]:\\' -or $value.directory -match '[\x00-\x1f\x7f"<>|?*]' -or
  [IO.Path]::GetFileName($value.directory) -notmatch '^\.appliance-runtime-[A-Za-z0-9_-]{6,64}$' -or
  $value.parents -isnot [array] -or $value.parents.Count -lt 1 -or $value.parents.Count -gt 64) { throw 'PRIVATE_DIRECTORY_UNSAFE' }
$current=[IO.Path]::GetPathRoot($value.directory)
foreach($parent in $value.parents) {
  if((@($parent.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'device,inode,path' -or
    $parent.path -isnot [string] -or $parent.device -isnot [string] -or $parent.inode -isnot [string] -or
    $parent.device -notmatch '^\d{1,20}$' -or $parent.inode -notmatch '^\d{1,20}$' -or $parent.path -cne $current) { throw 'PRIVATE_DIRECTORY_UNSAFE' }
  $handle=[FoliaPrivateDirectoryGate]::Open($parent.path,$false); $handles.Add($handle)
  [FoliaPrivateDirectoryGate]::Verify($handle,$parent.device,$parent.inode)
  if($current -ne [IO.Path]::GetDirectoryName($value.directory)) {
    $next=$value.directory.Substring($current.Length).TrimStart('\').Split('\')[0]
    $current=[IO.Path]::Combine($current,$next)
  }
}
if($current -cne [IO.Path]::GetDirectoryName($value.directory)) { throw 'PRIVATE_DIRECTORY_UNSAFE' }
$leaf=[FoliaPrivateDirectoryGate]::Open($value.directory,$true); $handles.Add($leaf)
[FoliaPrivateDirectoryGate]::Verify($leaf,$value.device,$value.inode)
if(@([IO.Directory]::EnumerateFileSystemEntries($value.directory)).Count -ne 0) { throw 'PRIVATE_DIRECTORY_UNSAFE' }
[FoliaPrivateDirectoryGate]::Protect($leaf)
[FoliaPrivateDirectoryGate]::Verify($leaf,$value.device,$value.inode)
for($index=0;$index -lt $value.parents.Count;$index++) {
  [FoliaPrivateDirectoryGate]::Verify($handles[$index],$value.parents[$index].device,$value.parents[$index].inode)
}
[Console]::Out.Write('{"ok":true,"secured":true,"identityVerified":true}')
} catch {
  $code='PRIVATE_DIRECTORY_PERMISSION_FAILED'
  $errorValue=$_.Exception
  while($errorValue.InnerException) { $errorValue=$errorValue.InnerException }
  if($errorValue.Message -in @('PRIVATE_DIRECTORY_UNSAFE','PRIVATE_DIRECTORY_CHANGED','PRIVATE_DIRECTORY_PERMISSION_FAILED')) { $code=$errorValue.Message }
  [Console]::Out.Write('{"ok":false,"code":"'+$code+'"}')
  exit 1
} finally { for($index=$handles.Count-1;$index -ge 0;$index--) { $handles[$index].Dispose() } }
`;

function createWindowsPrivateDirectoryGate({ io = fs, spawnProcess = spawn, platform = process.platform,
  systemRoot = process.env.SystemRoot || 'C:\\Windows', timeoutMs = 15000 } = {}) {
  if (process.type === 'renderer' || platform !== 'win32' || typeof spawnProcess !== 'function'
    || !safePath(systemRoot) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw fail('INVALID_REQUEST');
  const executable = path.win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  const cancelled = signal => { if (signal?.aborted) throw fail('CANCELLED'); };
  async function witness(directory, signal) {
    cancelled(signal);
    if (!safePath(directory) || !/^\.appliance-runtime-[A-Za-z0-9_-]{6,64}$/.test(path.win32.basename(directory))) throw fail('PRIVATE_DIRECTORY_UNSAFE');
    const absolute = path.win32.resolve(directory), root = path.win32.parse(absolute).root, parents = [];
    let current = root;
    const read = async filename => {
      cancelled(signal); const info = await io.lstat(filename, { bigint: true }); cancelled(signal);
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev < 0n || info.ino <= 0n
        || path.win32.resolve(await io.realpath(filename)).toLowerCase() !== filename.toLowerCase()) throw fail('PRIVATE_DIRECTORY_UNSAFE');
      return { device: String(info.dev), inode: String(info.ino) };
    };
    parents.push({ path: current, ...await read(current) });
    const parts = absolute.slice(root.length).split('\\');
    for (const part of parts.slice(0, -1)) { current = path.win32.join(current, part); parents.push({ path: current, ...await read(current) }); }
    if (parents.length > 64) throw fail('PRIVATE_DIRECTORY_UNSAFE');
    const identity = await read(absolute); if ((await io.readdir(absolute)).length) throw fail('PRIVATE_DIRECTORY_UNSAFE');
    cancelled(signal); return { directory: absolute, ...identity, parents };
  }
  return async function secure(directory, { signal } = {}) {
    let expected;
    try { expected = await witness(directory, signal); }
    catch (error) { throw error.code === 'CANCELLED' || error.code === 'PRIVATE_DIRECTORY_UNSAFE' ? error : fail('PRIVATE_DIRECTORY_UNSAFE'); }
    const body = Buffer.from(JSON.stringify(expected)); if (body.length > 65536) throw fail('PRIVATE_DIRECTORY_UNSAFE');
    let output;
    try {
      output = await new Promise((resolve, reject) => {
        let child, timer, settled = false, length = 0; const chunks = [];
        const finish = (error, value) => {
          if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); body.fill(0);
          chunks.forEach(bytes => bytes.fill(0));
          if (error) { try { child?.kill(); } catch { /* Only this owned ACL child may be reaped already. */ } reject(error); } else resolve(value);
        };
        const abort = () => finish(fail('CANCELLED'));
        cancelled(signal);
        try { child = spawnProcess(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
          { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] }); }
        catch { finish(fail('PRIVATE_DIRECTORY_CONTROL_UNAVAILABLE')); return; }
        child.on('error', () => finish(fail('PRIVATE_DIRECTORY_CONTROL_UNAVAILABLE')));
        child.stdin.on('error', () => finish(fail('PRIVATE_DIRECTORY_CONTROL_UNAVAILABLE')));
        child.stdout.on('error', () => finish(fail('PRIVATE_DIRECTORY_CONTROL_UNAVAILABLE')));
        child.stdout.on('data', bytes => { if (settled) return; length += bytes.length;
          if (length > 1024) finish(fail('PRIVATE_DIRECTORY_PROTOCOL_INVALID')); else chunks.push(Buffer.from(bytes)); });
        child.on('close', exitCode => { if (settled) return;
          const bytes = Buffer.concat(chunks, length); let value;
          try { value = parseBoundedResponse(bytes); } catch { bytes.fill(0); finish(fail('PRIVATE_DIRECTORY_PROTOCOL_INVALID')); return; }
          bytes.fill(0);
          if (exitCode === 0 && exact(value, 'identityVerified,ok,secured') && value.ok === true && value.secured === true && value.identityVerified === true) finish(null, value);
          else if (exitCode !== 0 && exact(value, 'code,ok') && value.ok === false
            && ['PRIVATE_DIRECTORY_UNSAFE', 'PRIVATE_DIRECTORY_CHANGED', 'PRIVATE_DIRECTORY_PERMISSION_FAILED'].includes(value.code)) finish(fail(value.code));
          else finish(fail('PRIVATE_DIRECTORY_PROTOCOL_INVALID'));
        });
        timer = setTimeout(() => finish(fail('PRIVATE_DIRECTORY_CONTROL_TIMEOUT')), timeoutMs);
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) { abort(); return; }
        try { child.stdin.end(body); } catch { finish(fail('PRIVATE_DIRECTORY_CONTROL_UNAVAILABLE')); }
      });
      const actual = await witness(directory, signal);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw fail('PRIVATE_DIRECTORY_CHANGED');
      return Object.freeze({ ...output });
    } finally { body.fill(0); }
  };
}
async function secureWindowsPrivateDirectory(directory, options) { return createWindowsPrivateDirectoryGate()(directory, options); }
module.exports = { createWindowsPrivateDirectoryGate, secureWindowsPrivateDirectory };
