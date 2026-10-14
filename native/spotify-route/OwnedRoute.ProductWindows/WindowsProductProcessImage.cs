using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Folia.RouteRunner;

// Reconstructed from the statically extracted dev11 OwnedRoute.ProductWindows
// assembly, Folia.RouteRunner.WindowsProductProcessImage. No Windows native API
// was executed to recover this source-equivalent implementation.
internal static class WindowsProductProcessImage
{
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,EntryPoint="QueryFullProcessImageNameW",ExactSpelling=true,SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(SafeProcessHandle process,uint flags,StringBuilder image,ref uint size);

    internal static void Require(SafeProcessHandle process,string expectedImage)=>Require(process,expectedImage,ReadImage);

    internal static void Require(SafeProcessHandle process,string expectedImage,Func<SafeProcessHandle,string> readImage)
    {
        if(process.IsClosed)throw new ObjectDisposedException("process");
        if(process.IsInvalid)throw new Win32Exception(6);
        var image=readImage(process);
        if(string.IsNullOrEmpty(image)||!string.Equals(image,expectedImage,StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("PRODUCT_CHILD_IMAGE_MISMATCH");
    }

    private static string ReadImage(SafeProcessHandle process)
    {
        if(!OperatingSystem.IsWindows())throw new PlatformNotSupportedException("WINDOWS_PRODUCT_IMAGE_REQUIRED");
        var image=new StringBuilder(32768);
        var size=(uint)image.Capacity;
        if(!QueryFullProcessImageName(process,0,image,ref size))throw new Win32Exception(Marshal.GetLastWin32Error());
        if(size==0||size>=image.Capacity||image.Length!=size)throw new InvalidOperationException("PRODUCT_CHILD_IMAGE_MISMATCH");
        return image.ToString();
    }
}
