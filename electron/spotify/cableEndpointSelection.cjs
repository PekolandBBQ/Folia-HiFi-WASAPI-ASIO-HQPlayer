'use strict';
// Pack45 exposes a line-level input and a speakers input on the same base cable.
function selectCableEndpoints(endpoints, saved = {}) {
  // Native classification resolves VB-Audio identity independently of localized endpoint labels.
  // Saved IDs are preferences within the current inventory, never portable device identities.
  const verified = endpoints.filter(e => e.supportedBaseCable === true && e.baseIdentity?.state === 'verified'
    && typeof e.baseIdentity.ownerInstanceId === 'string' && e.baseIdentity.ownerInstanceId.length > 0);
  const captures = verified.filter(e => e.flow === 'capture');
  const capture = captures.find(e => e.id === saved.captureDeviceId) || (captures.length === 1 ? captures[0] : null);
  if (!capture) return null;
  const renders = verified.filter(e => e.flow === 'render' && e.baseIdentity.ownerInstanceId === capture.baseIdentity.ownerInstanceId);
  const savedRender = renders.find(e => e.id === saved.renderDeviceId);
  const speakerInputs = renders.filter(e => e.formFactor === 1);
  const render = savedRender || (speakerInputs.length === 1 ? speakerInputs[0] : renders.length === 1 ? renders[0] : null);
  return render ? { captureDeviceId: capture.id, renderDeviceId: render.id } : null;
}
module.exports = { selectCableEndpoints };
