using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using Folia.RouteResearch;
using Microsoft.Win32.SafeHandles;

namespace Folia.RouteRunner;

// Exact live process + current logon user + held executable + verified Spotify
// Authenticode publisher. A process name or a caller-provided path is never proof.
internal sealed class SpotifyIdentity : IDisposable
{
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process,uint access,out SafeAccessTokenHandle token);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] private static extern int GetPackageFullName(IntPtr process,ref uint length,StringBuilder? name);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] private static extern int GetApplicationUserModelId(IntPtr process,ref uint length,StringBuilder? name);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle,out FileIdentityNative info);
    [StructLayout(LayoutKind.Sequential)] private struct FileIdentityNative
    {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;
        public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
    }
    [DllImport("wintrust.dll",ExactSpelling=true)] private static extern int WinVerifyTrust(IntPtr hwnd,in Guid action,ref TrustData data);
    [DllImport("wintrust.dll",ExactSpelling=true)] private static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);
    [DllImport("wintrust.dll",ExactSpelling=true)] private static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr data,uint signer,bool counterSigner,uint counterSignerIndex);
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] private struct FileInfoNative
    { public uint Size; public IntPtr Path; public IntPtr Handle; public IntPtr KnownSubject; }
    [StructLayout(LayoutKind.Sequential)] private struct TrustData
    { public uint Size; public IntPtr PolicyData,SipData; public uint Ui,Revocation,Choice; public IntPtr File; public uint StateAction; public IntPtr StateData,Url; public uint Flags,Context; public IntPtr SignatureSettings; }
    [StructLayout(LayoutKind.Sequential)] private struct Signer
    { public uint Size; public System.Runtime.InteropServices.ComTypes.FILETIME VerifyTime; public uint CertificateCount; public IntPtr Certificates; }
    [StructLayout(LayoutKind.Sequential)] private struct ProviderCert
    { public uint Size; public IntPtr Certificate; }
    private readonly Process process;
    private readonly FileStream executable;
    private readonly string path, userSid, policy, distribution, image;
    private readonly long started;
    private readonly string fileIdentity;
    internal string Publisher { get; }
    internal SpotifyProcess Identity { get; }
    internal SpotifyIdentity(int pid)
    {
        process=Process.GetProcessById(pid);
        try
        {
            _=process.Handle; started=process.StartTime.ToUniversalTime().Ticks;
            path=process.MainModule?.FileName ?? throw new RouteBlockedException("SPOTIFY_IMAGE_UNAVAILABLE");
            if(!string.Equals(Path.GetFileName(path),"Spotify.exe",StringComparison.OrdinalIgnoreCase)) throw new RouteBlockedException("EXACT_SPOTIFY_EXECUTABLE_REQUIRED");
            userSid=ReadSid(process.Handle);
            if(userSid!=WindowsIdentity.GetCurrent().User?.Value) throw new RouteBlockedException("SPOTIFY_CURRENT_USER_REQUIRED");
            // Hold read access without write/delete sharing for the entire worker lifetime.
            executable=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);
            fileIdentity=ReadFileIdentity(executable.SafeFileHandle);
            Publisher=VerifyPublisher(path);
            var package=ReadPackage(process.Handle);
            distribution=package is null?"desktop-authenticode":"packaged-authenticode";
            // Conservative namespace evidence. Package full-name/AUMID or exact image
            // path comes from Windows; route API uses this verified live PID directly.
            policy=package is null?"win32-image:"+Path.GetFullPath(path).ToUpperInvariant():"package:"+package+"|aumid:"+ReadAppId(process.Handle);
            image=Path.GetFullPath(path).ToUpperInvariant()+"|file:"+fileIdentity+"|publisher:"+Publisher;
            Identity=new(pid,started,userSid,policy,image,distribution);
            Check(pid);
        }
        catch { executable?.Dispose(); process.Dispose(); throw; }
    }
    private static string ReadSid(IntPtr handle)
    {
        if(!OpenProcessToken(handle,8,out var token)) throw new Win32Exception(Marshal.GetLastWin32Error());
        using(token) using(var identity=new WindowsIdentity(token.DangerousGetHandle())) return identity.User?.Value ?? throw new RouteBlockedException("SPOTIFY_SID_UNAVAILABLE");
    }
    private static string? ReadPackage(IntPtr handle)
    {
        uint n=0; var hr=GetPackageFullName(handle,ref n,null);
        if(hr==15700) return null;
        if(hr!=122 || n is <2 or >32768) throw new RouteBlockedException("SPOTIFY_PACKAGE_IDENTITY_UNAVAILABLE");
        var b=new StringBuilder((int)n); if(GetPackageFullName(handle,ref n,b)!=0) throw new RouteBlockedException("SPOTIFY_PACKAGE_IDENTITY_CHANGED"); return b.ToString();
    }
    private static string ReadAppId(IntPtr handle)
    {
        uint n=0; if(GetApplicationUserModelId(handle,ref n,null)!=122 || n is <2 or >32768) throw new RouteBlockedException("SPOTIFY_AUMID_UNAVAILABLE");
        var b=new StringBuilder((int)n); if(GetApplicationUserModelId(handle,ref n,b)!=0) throw new RouteBlockedException("SPOTIFY_AUMID_UNAVAILABLE"); return b.ToString();
    }
    internal SpotifyProcess Check(int pid)
    {
        if(pid!=process.Id || process.HasExited || process.StartTime.ToUniversalTime().Ticks!=started ||
            !string.Equals(process.MainModule?.FileName,path,StringComparison.OrdinalIgnoreCase) || ReadSid(process.Handle)!=userSid ||
            ReadFileIdentity(executable.SafeFileHandle)!=fileIdentity)
            throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");
        var package=ReadPackage(process.Handle);
        var current=package is null?"win32-image:"+Path.GetFullPath(path).ToUpperInvariant():"package:"+package+"|aumid:"+ReadAppId(process.Handle);
        if(current!=policy) throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");
        return Identity;
    }
    private static string ReadFileIdentity(SafeFileHandle handle)
    {
        if(!GetFileInformationByHandle(handle,out var file)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if((file.Attributes&(0x10u|0x400u))!=0 || (file.IndexHigh==0 && file.IndexLow==0))
            throw new RouteBlockedException("SPOTIFY_IMAGE_FILE_IDENTITY_UNAVAILABLE");
        var length=((ulong)file.SizeHigh<<32)|file.SizeLow;
        var write=((ulong)(uint)file.Write.dwHighDateTime<<32)|(uint)file.Write.dwLowDateTime;
        return $"volume:{file.Volume:X8}|id:{file.IndexHigh:X8}{file.IndexLow:X8}|bytes:{length}|lastwrite:{write}";
    }
    private static string VerifyPublisher(string path)
    {
        var action=new Guid("00aac56b-cd44-11d0-8cc2-00c04fc295ee");
        var filename=Marshal.StringToCoTaskMemUni(path); var filePtr=IntPtr.Zero;
        var data=new TrustData{Size=(uint)Marshal.SizeOf<TrustData>(),Ui=2,Revocation=0,Choice=1,StateAction=1,Flags=0x1000};
        try
        {
            var file=new FileInfoNative{Size=(uint)Marshal.SizeOf<FileInfoNative>(),Path=filename};
            filePtr=Marshal.AllocHGlobal(Marshal.SizeOf<FileInfoNative>()); Marshal.StructureToPtr(file,filePtr,false); data.File=filePtr;
            var hr=WinVerifyTrust(new IntPtr(-1),in action,ref data);
            if(hr!=0) throw new RouteBlockedException("SPOTIFY_SIGNATURE_UNTRUSTED_"+unchecked((uint)hr).ToString("X8"));
            var provider=WTHelperProvDataFromStateData(data.StateData);
            var signerPtr=WTHelperGetProvSignerFromChain(provider,0,false,0);
            if(signerPtr==IntPtr.Zero) throw new RouteBlockedException("SPOTIFY_SIGNER_UNAVAILABLE");
            var signer=Marshal.PtrToStructure<Signer>(signerPtr);
            if(signer.CertificateCount<1 || signer.Certificates==IntPtr.Zero) throw new RouteBlockedException("SPOTIFY_SIGNER_UNAVAILABLE");
            var certPointer=Marshal.PtrToStructure<ProviderCert>(signer.Certificates).Certificate;
            using var cert=new X509Certificate2(certPointer);
            var name=cert.GetNameInfo(X509NameType.SimpleName,false);
            if(name is not ("Spotify AB" or "Spotify Sweden AB")) throw new RouteBlockedException("SPOTIFY_PUBLISHER_MISMATCH:"+name);
            return name+"|certificate:"+cert.Thumbprint;
        }
        finally
        {
            if(data.StateData!=IntPtr.Zero) { data.StateAction=2; WinVerifyTrust(new IntPtr(-1),in action,ref data); }
            if(filePtr!=IntPtr.Zero) Marshal.FreeHGlobal(filePtr); Marshal.FreeCoTaskMem(filename);
        }
    }
    public void Dispose() { executable.Dispose(); process.Dispose(); }
}
