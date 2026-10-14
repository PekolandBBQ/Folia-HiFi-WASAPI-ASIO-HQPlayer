using Folia.ProductRoute;
namespace Folia.RouteRunner;

// The production factory always creates ProductProcessSupervisor. This seam lets
// device-free tests exercise parent receipt/lifetime handling without a native
// process, image override, executable-path flag, or fabricated Windows admission.
internal interface IProductSupervisorProcess:IAsyncDisposable
{
    Task<ServiceReply> Request(string body,CancellationToken cancellationToken);
    Task<ProductChildOutcome> Stop();
    Task<ProductChildOutcome> RecoverOnce();
    ProductDefaultStatus? TerminalDefaults {get;}
    object? RetainedLeaseReceipt {get;}
}
