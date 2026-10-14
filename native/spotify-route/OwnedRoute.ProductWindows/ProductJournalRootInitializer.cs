using System.Runtime.InteropServices;
using Folia.RouteResearch;
using Microsoft.Win32.SafeHandles;

namespace Folia.RouteRunner;

internal interface IProductRootCreation : IDisposable
{
    void Validate();
    void CreateFixedRoot();
}

// Product first-run initialization only. The frozen diagnostic probe remains
// read-only. The only create is a fixed leaf relative to a validated parent
// handle; no caller path, recursive mkdir, ACL repair, deletion or elevation.
internal static class ProductJournalRootInitializer
{
    internal static JournalRootLease Acquire()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("WINDOWS_PRODUCT_JOURNAL_REQUIRED");
        var probe = new WindowsJournalRootProbe();
        return Acquire(probe, (parent, expected) => new WindowsCreation(probe, parent, expected));
    }
    internal static JournalRootLease Acquire(IJournalRootProbe probe, Func<string, JournalObjectInfo, IProductRootCreation> openCreation)
    {
        var api = probe.Resolve();
        var logicalParent = Parent(api.LogicalRoot); var physicalParent = Parent(api.PhysicalRoot);
        var reconstructed = JournalStorageBinding.FromApiResults(logicalParent, physicalParent, api.PackageFamily, api.UserSid);
        JournalStorageBinding.RequireSameContext(api, reconstructed);
        var pins = new List<(string Path, IJournalDirectoryPin Pin, JournalObjectInfo Info)>();
        try
        {
            foreach (var path in Ancestors(logicalParent).Concat(Ancestors(physicalParent)).Distinct(StringComparer.OrdinalIgnoreCase))
            {
                var pin = probe.OpenDirectory(path);
                try { var info = pin.Read(); Check(info, path, api.UserSid); pins.Add((path, pin, info)); }
                catch { pin.Dispose(); throw; }
            }
            var parent = pins.Single(value => JournalPath.SamePath(value.Path, physicalParent)).Info;
            var anchor = pins.Single(value => JournalPath.SamePath(value.Path, logicalParent)).Info;
            if (parent.Identity.Volume != anchor.Identity.Volume) throw new JournalUnavailableException("PRODUCT_JOURNAL_PARENT_VOLUME_CHANGED");
            void Validate()
            {
                JournalStorageBinding.RequireSameContext(probe.Resolve(), api);
                foreach (var item in pins) Check(item.Pin.Read(), item.Path, api.UserSid, item.Info);
            }
            Validate();
            using var existing = TryOpen(probe, api.LogicalRoot);
            if (existing is not null) return JournalRootLease.Acquire(probe);
            if (!JournalPath.SamePath(api.LogicalRoot, api.PhysicalRoot))
            {
                using var physicalExisting = TryOpen(probe, api.PhysicalRoot);
                if (physicalExisting is not null) throw new JournalUnavailableException("PRODUCT_JOURNAL_EXISTING_ROOT_UNREACHABLE");
            }
            // The new parent handle must resolve to the already pinned object.
            // Creation itself uses only that handle and literal FoliaRouteTrial.
            using var creation = openCreation(physicalParent, parent);
            Validate(); creation.Validate(); creation.CreateFixedRoot(); Validate(); creation.Validate();
            // Inherited security, reparse state, case sensitivity, exact volume,
            // owner and every logical/physical pin are checked before any journal.
            return JournalRootLease.Acquire(probe);
        }
        finally { for (var i = pins.Count - 1; i >= 0; i--) pins[i].Pin.Dispose(); }
    }
    private static string Parent(string root)
    {
        if (!Path.IsPathFullyQualified(root) || root.StartsWith(@"\\", StringComparison.Ordinal) || root.StartsWith("//", StringComparison.Ordinal) ||
            Path.GetFileName(root) != "FoliaRouteTrial" || !string.Equals(Path.GetFullPath(root), root, StringComparison.OrdinalIgnoreCase) ||
            root.Split([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar]).Any(part=>part is "." or ".." || part.EndsWith('.') || part.EndsWith(' ')))
            throw new JournalUnavailableException("PRODUCT_JOURNAL_FIXED_LOCAL_ROOT_REQUIRED");
        return Path.GetDirectoryName(root) ?? throw new JournalUnavailableException("PRODUCT_JOURNAL_PARENT_REQUIRED");
    }
    private static IEnumerable<string> Ancestors(string path)
    {
        var paths = new List<string>(); for (var item = new DirectoryInfo(path); item is not null; item = item.Parent) paths.Add(item.FullName);
        paths.Reverse(); return paths;
    }
    private static IJournalDirectoryPin? TryOpen(IJournalRootProbe probe, string path)
    {
        try { return probe.OpenDirectory(path); }
        catch (JournalUnavailableException error) when (error.Message == "JOURNAL_DIRECTORY_MISSING_READONLY_PREFLIGHT") { return null; }
    }
    private static void Check(JournalObjectInfo info, string path, string sid, JournalObjectInfo? previous = null)
    {
        info.RequireSupported(); JournalGuard.CheckDirectory(info.Identity, path, previous?.Identity);
        JournalSecurity.Require(info.Security, sid, true, false);
        if (previous is not null && info.Security.Digest != previous.Security.Digest) throw new JournalUnavailableException("JOURNAL_SECURITY_CHANGED");
    }

    private sealed class WindowsCreation : IProductRootCreation
    {
        private readonly WindowsJournalRootProbe probe;
        private readonly string parentPath;
        private readonly JournalObjectInfo expected;
        private readonly string userSid;
        private readonly SafeFileHandle parent;
        private SafeFileHandle? created;
        internal WindowsCreation(WindowsJournalRootProbe probe, string parentPath, JournalObjectInfo expected)
        {
            this.probe = probe; this.parentPath = WindowsJournalRootProbe.RequireDosPath(parentPath); this.expected = expected;
            userSid = probe.Resolve().UserSid;
            // Hold only the access needed to add the one child, plus identity and
            // security reads. Deny competing write/delete opens during creation.
            parent = CreateFileW(this.parentPath, 0x00020084, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if (parent.IsInvalid) { var error = Marshal.GetLastWin32Error(); parent.Dispose(); throw new JournalUnavailableException("PRODUCT_JOURNAL_PARENT_OPEN_FAILED:" + error); }
            try { Validate(); } catch { parent.Dispose(); throw; }
        }
        public void Validate()
        {
            var current = probe.ReadLeaf(parent); current.RequireSupported();
            JournalGuard.CheckDirectory(current.Identity, parentPath, expected.Identity);
            if (current.Security.Digest != expected.Security.Digest) throw new JournalUnavailableException("JOURNAL_SECURITY_CHANGED");
        }
        public void CreateFixedRoot()
        {
            Validate();
            var text = Marshal.StringToHGlobalUni("FoliaRouteTrial"); var namePointer = IntPtr.Zero; var held = false;
            try
            {
                var name = new UnicodeString { Length = 30, MaximumLength = 32, Buffer = text };
                namePointer = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>()); Marshal.StructureToPtr(name, namePointer, false);
                parent.DangerousAddRef(ref held);
                var attributes = new ObjectAttributes { Length = Marshal.SizeOf<ObjectAttributes>(), RootDirectory = parent.DangerousGetHandle(),
                    ObjectName = namePointer, Attributes = 0x1040 }; // CASE_INSENSITIVE | DONT_REPARSE
                // FILE_CREATE refuses existing directories/files/reparse links.
                // SecurityDescriptor is null: inherit, never write an ACL.
                var status = NtCreateFile(out var child, 0x00120080, ref attributes, out _, IntPtr.Zero, 0x10, 3, 2,
                    0x00200021, IntPtr.Zero, 0); // DIRECTORY | SYNCHRONOUS_NONALERT | OPEN_REPARSE_POINT
                if (status == unchecked((int)0xC0000035)) { child?.Dispose(); return; } // Concurrent existing root; fully validate it next.
                if (status != 0) { child?.Dispose(); throw new JournalUnavailableException("PRODUCT_JOURNAL_ROOT_CREATE_FAILED:0x" + unchecked((uint)status).ToString("X8")); }
                if (child is null || child.IsInvalid) { child?.Dispose(); throw new JournalUnavailableException("PRODUCT_JOURNAL_CREATED_HANDLE_REQUIRED"); }
                created = child; // Pin the created leaf until the full lease has its own pins.
                var info = probe.ReadLeaf(created); info.RequireSupported();
                JournalGuard.CheckDirectory(info.Identity, Path.Combine(parentPath, "FoliaRouteTrial"));
                JournalSecurity.Require(info.Security, userSid, true, true);
            }
            finally { if (held) parent.DangerousRelease(); if (namePointer != IntPtr.Zero) Marshal.FreeHGlobal(namePointer); Marshal.FreeHGlobal(text); }
        }
        public void Dispose() { created?.Dispose(); parent.Dispose(); }
    }
    [StructLayout(LayoutKind.Sequential)] private struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] private struct ObjectAttributes { public int Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
    [StructLayout(LayoutKind.Sequential)] private struct IoStatus { public IntPtr Status; public UIntPtr Information; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("ntdll.dll", ExactSpelling = true)] private static extern int NtCreateFile(out SafeFileHandle file, uint access, ref ObjectAttributes attributes,
        out IoStatus status, IntPtr allocationSize, uint fileAttributes, uint share, uint disposition, uint options, IntPtr extendedAttributes, uint extendedAttributeLength);
}
