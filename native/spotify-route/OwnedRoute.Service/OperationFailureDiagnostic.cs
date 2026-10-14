using System.ComponentModel;
using System.Text.Json;

namespace Folia.ProductRoute;

// Fixed failure metadata only. These enums do not grant route authority and may
// never contain exception text, paths, endpoint identities or policy values.
public sealed record OperationFailureDiagnostic(string Stage,string Cause);
public static class OperationFailureDiagnosticProjection
{
    public static OperationFailureDiagnostic? FromException(string stage,Exception error)
    {
        // Prefixes are considered only through a closed code mapping below.
        // Unknown messages, including private suffixes, never cross the pipe.
        var text=error.Message;
        var end=text.IndexOf(':');
        var code=end<0?text:text[..end];
        var cause=code switch
        {
            "PRODUCT_WORKER_START_FAILED"=>"worker-start-failed",
            "PRODUCT_IMAGE_REQUIRED" or "PRODUCT_SINGLE_FILE_HOST_REQUIRED"=>"worker-image-invalid",
            "PRODUCT_CHILD_IMAGE_MISMATCH" or "JOURNAL_PROCESS_IDENTITY_CHANGED" or "PROCESS_SID_UNAVAILABLE"=>"worker-identity-unconfirmed",
            "PRODUCT_WORKER_UNAVAILABLE"=>"worker-unavailable",
            "PRODUCT_WORKER_EOF"=>"worker-eof",
            "PRODUCT_REQUEST_LIMIT" or "PRODUCT_FRAME_REQUIRED" or "PRODUCT_WORKER_FRAME_BINDING_MISMATCH" or
            "PRODUCT_UNEXPECTED_FRAME" or "PRODUCT_REPLY_REQUIRED" or "PRODUCT_UNEXPECTED_REPLY" or
            "CONTROL_LINE_LIMIT" or "CONTROL_LINE_TRUNCATED" or "PREPARED_REQUIRED" or "RECOVERY_BASELINE_REQUIRED" or
            "RECOVERY_BASELINE_BINDING_MISMATCH" or "UNEXPECTED_PREPARED_BEFORE_ACQUIRE" or "TERMINAL_REQUIRED" or
            "UNEXPECTED_TERMINAL_BEFORE_ACQUIRE" or "SOURCE_REQUEST_REQUIRED" or "SOURCE_REQUEST_SCOPE_MISMATCH"=>"worker-protocol-invalid",
            "PRODUCT_STDERR_LIMIT"=>"worker-stderr-limit",
            "JOURNAL_KNOWN_FOLDER_LOCAL_PATH_REQUIRED" or "JOURNAL_CURRENT_USER_IDENTITY_REQUIRED" or
            "JOURNAL_PACKAGE_IDENTITY_INVALID" or "JOURNAL_KNOWN_FOLDER_TARGET_OUTSIDE_CURRENT_USER_PACKAGE_CACHE" or
            "JOURNAL_KNOWN_FOLDER_TARGET_NOT_CURRENT_PACKAGE" or "JOURNAL_PROCESS_STORAGE_CONTEXT_CHANGED" or
            "JOURNAL_KNOWN_FOLDER_UNAVAILABLE" or "JOURNAL_KNOWN_FOLDER_EMPTY" or "JOURNAL_PACKAGE_IDENTITY_UNAVAILABLE" or
            "JOURNAL_IDENTITY_CHANGED_DURING_RESOLUTION" or "JOURNAL_IMPERSONATION_UNSUPPORTED"=>"journal-context-unavailable",
            "PRODUCT_JOURNAL_EXISTING_ROOT_UNREACHABLE" or "PRODUCT_JOURNAL_PARENT_REQUIRED" or
            "PRODUCT_JOURNAL_PARENT_OPEN_FAILED" or "PRODUCT_JOURNAL_ROOT_CREATE_FAILED" or "PRODUCT_JOURNAL_CREATED_HANDLE_REQUIRED" or
            "JOURNAL_DIRECTORY_MISSING_READONLY_PREFLIGHT" or "JOURNAL_DIRECTORY_OPEN_UNAVAILABLE" or
            "JOURNAL_HANDLE_INFORMATION_UNAVAILABLE" or "JOURNAL_HANDLE_PATH_UNAVAILABLE" or
            "JOURNAL_FILESYSTEM_INFORMATION_UNAVAILABLE" or "JOURNAL_ANCHOR_REQUIRED" or
            "JOURNAL_ROOT_FINAL_PATH_REQUIRED" or "JOURNAL_PHYSICAL_CHAIN_MISSING_ANCHOR"=>"journal-root-unavailable",
            "PRODUCT_JOURNAL_PARENT_VOLUME_CHANGED" or "PRODUCT_JOURNAL_FIXED_LOCAL_ROOT_REQUIRED" or
            "JOURNAL_STORAGE_IDENTITY_UNSAFE" or "JOURNAL_LIVE_ROOT_OBJECT_PROOF_REQUIRED" or "JOURNAL_DIRECTORY_IDENTITY_UNSAFE" or
            "JOURNAL_DIRECTORY_CHANGED" or "JOURNAL_LOGICAL_PHYSICAL_IDENTITY_MISMATCH" or "JOURNAL_PHYSICAL_CHAIN_VOLUME_CHANGED" or
            "JOURNAL_ROOT_CANDIDATE_SHAPE_UNSAFE" or "JOURNAL_FILESYSTEM_VOLUME_MISMATCH" or "JOURNAL_LOCAL_DOS_PATH_REQUIRED" or
            "JOURNAL_AMBIGUOUS_PATH_UNSUPPORTED" or "JOURNAL_REPARSE_PATH_FORBIDDEN" or
            "JOURNAL_FILESYSTEM_UNSUPPORTED_LOCAL_NTFS_PERSISTENT_ACLS_REQUIRED" or "JOURNAL_CASE_SENSITIVE_DIRECTORY_UNSUPPORTED" or
            "JOURNAL_CASE_SENSITIVITY_UNSUPPORTED" or "JOURNAL_CASE_SENSITIVITY_UNSUPPORTED_FLAGS"=>"journal-root-unsafe",
            "JOURNAL_SECURITY_CHANGED" or "JOURNAL_SECURITY_UNSUPPORTED_DESCRIPTOR_CONTROL" or "JOURNAL_SECURITY_UNSAFE_OWNER" or
            "JOURNAL_SECURITY_UNSAFE_NULL_DACL" or "JOURNAL_SECURITY_UNSUPPORTED_ACE" or "JOURNAL_SECURITY_UNSUPPORTED_ACCESS_MASK" or
            "JOURNAL_SECURITY_UNSUPPORTED_DENY_INTERACTION" or "JOURNAL_SECURITY_UNSAFE_GRANT" or "JOURNAL_SECURITY_SID_UNAVAILABLE" or
            "JOURNAL_SECURITY_SID_EMPTY" or "JOURNAL_SECURITY_READ_UNAVAILABLE" or "JOURNAL_SECURITY_DESCRIPTOR_UNSUPPORTED" or
            "JOURNAL_SECURITY_ACL_INVALID" or "JOURNAL_SECURITY_ACL_UNSUPPORTED" or "JOURNAL_SECURITY_SID_LENGTH_UNSUPPORTED"=>"journal-security-rejected",
            _=>error switch
            {
                OperationCanceledException=>"request-cancelled",
                UnauthorizedAccessException=>"access-denied",
                JsonException=>"json-invalid",
                InvalidDataException=>"invalid-data",
                ObjectDisposedException=>"object-disposed",
                PlatformNotSupportedException=>"platform-unsupported",
                Win32Exception=>"win32-failed",
                IOException=>"io-failed",
                _=>"unknown"
            }
        };
        return Project(new(stage,cause));
    }
    public static OperationFailureDiagnostic? Project(OperationFailureDiagnostic? value)
    {
        if(value is null||value.Stage is not ("worker-start" or "inspect-request")||value.Cause is not (
            "unknown" or "request-cancelled" or "worker-start-failed" or "worker-image-invalid" or "worker-identity-unconfirmed" or
            "worker-unavailable" or "worker-eof" or "worker-protocol-invalid" or "worker-stderr-limit" or
            "journal-context-unavailable" or "journal-root-unavailable" or "journal-root-unsafe" or "journal-security-rejected" or
            "access-denied" or "io-failed" or "invalid-data" or "json-invalid" or "object-disposed" or "platform-unsupported" or "win32-failed"))return null;
        return new(value.Stage,value.Cause);
    }
}
