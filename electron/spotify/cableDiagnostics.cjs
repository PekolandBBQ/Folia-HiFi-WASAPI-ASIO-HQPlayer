'use strict';
const { own, sourceErrorCode } = require('../debug/privatePreviewDiagnosticSchema.cjs');
const { isPreviewDiagnosticsEnabled, publishPreviewDiagnostic, previewSessionRef } = require('../debug/privatePreviewDiagnosticBus.cjs');

// Only bounded facts enter the journal. Identity, device paths, exception text and PCM never do.
const FIELDS = Object.freeze(['phase', 'generation', 'snapshotSource', 'captureState', 'cleanupConfirmed', 'bootstrapMode', 'bootstrapDelivery', 'deliveryState',
  'captureSampleRate', 'captureChannels', 'captureBits', 'renderSampleRate',
  'renderChannels', 'renderBits', 'capturedFrames', 'deliveredFrames', 'queuedBytes', 'queueCapacityBytes',
  'initialDiscontinuity', 'routeSpotifyOnly', 'formatLeaseApplied', 'formatLeaseReleased']);
function reportCableCapture(value) {
  if (!isPreviewDiagnosticsEnabled()) return;
  try {
    const fields = Object.fromEntries(FIELDS.map(key => [key, own(value, key)]));
    if (fields.phase === 'native-terminal' && fields.snapshotSource === 'native-terminal' && fields.captureState === 'failed') {
      fields.hresult = own(value, 'hresult'); fields.failureStage = own(value, 'failureStage');
      if (own(value, 'errorCode') === 'FORMAT_LEASE_READBACK_MISMATCH') fields.formatLeaseReadback = own(value, 'formatLeaseReadback');
    }
    fields.sessionRef = previewSessionRef(own(value, 'session'));
    if (own(value, 'errorCode') != null) fields.errorCode = sourceErrorCode({ code: own(value, 'errorCode') });
    publishPreviewDiagnostic('spotify.capture', fields);
  } catch { /* A diagnostic sink never changes capture or control results. */ }
}
const HELPER_FIELDS = Object.freeze(['phase', 'operation', 'ok', 'processPlatform', 'processArchitecture',
  'protocolMajor', 'helperPlatform', 'helloCompatible', 'baseCableCapability', 'pcmPipeCapability',
  'routeObservationCapability', 'temporaryFormatLeaseCapability', 'captureEndpointCount', 'renderEndpointCount',
  'singleCaptureMixSampleRate', 'singleCaptureChannels', 'singleCaptureBits',
  'singleRenderMixSampleRate', 'singleRenderChannels', 'singleRenderBits', 'hresult', 'configurationIssueCodes',
  'endpointInventoryState', 'endpointActiveCount', 'endpointDisabledCount', 'endpointNotPresentCount',
  'endpointUnpluggedCount', 'endpointUnreadableCount', 'endpointHresult', 'controlInterfaceState',
  'controlInterfaceCount', 'controlInterfaceActiveCount', 'controlInterfaceWin32Error', 'controlInterfaceFailureStage']);
function reportCableHelper(value) {
  if (!isPreviewDiagnosticsEnabled()) return;
  try {
    const fields = Object.fromEntries(HELPER_FIELDS.map(key => [key, own(value, key)]));
    if (own(value, 'errorCode') != null) fields.errorCode = sourceErrorCode({ code: own(value, 'errorCode') });
    publishPreviewDiagnostic('spotify.capture-helper', fields);
  } catch { /* A diagnostic sink never changes helper results. */ }
}
const length = value => Array.isArray(value) && Number.isSafeInteger(own(value, 'length'))
  && own(value, 'length') <= 256 ? own(value, 'length') : undefined;
const selected = value => typeof value === 'string' && value.length > 0;
function reportOwnedRoute(value) {
  if (!isPreviewDiagnosticsEnabled()) return;
  try {
    publishPreviewDiagnostic('spotify.route-lease', {
      phase: own(value, 'phase'), sessionRef: previewSessionRef(own(value, 'session')), generation: own(value, 'generation'),
      ready: own(value, 'ready'), exactOriginalRolesRestored: own(value, 'exactOriginalRolesRestored'),
      observedDefaultsChanged: own(value, 'observedDefaultsChanged'), globalDefaultsWritten: own(value, 'globalDefaultsWritten'),
      ...(own(value, 'errorCode') ? { errorCode: sourceErrorCode({ code: own(value, 'errorCode') }) } : {}),
    });
  } catch { /* Private preview observations never control routing. */ }
}
// This observes the returned setup value only. Endpoint presence never proves installation or panel health.
function reportCableSetup(value, context) {
  if (!isPreviewDiagnosticsEnabled()) return;
  try {
    const devices = own(value, 'devices'), selection = own(value, 'selection'), probe = own(value, 'probe');
    const captureEndpointCount = length(own(devices, 'capture')), renderEndpointCount = length(own(devices, 'render'));
    const spotify = own(devices, 'spotify'), spotifyCount = length(spotify), connectId = own(selection, 'connectDeviceId');
    let listed, active;
    if (spotifyCount !== undefined && selected(connectId)) {
      listed = false; active = false;
      for (let index = 0; index < spotifyCount; index++) {
        const device = own(spotify, String(index));
        if (own(device, 'id') === connectId) { listed = true; active ||= own(device, 'isActive') === true; }
      }
    }
    const operation = own(context, 'operation');
    publishPreviewDiagnostic('spotify.cable-setup', {
      operation, operationRef: own(context, 'operationRef'), state: own(value, 'state'),
      ...(own(value, 'code') !== undefined ? { errorCode: sourceErrorCode(value) } : {}),
      captureEndpointCount, renderEndpointCount,
      ...(captureEndpointCount !== undefined && renderEndpointCount !== undefined
        ? { endpointPairDetected: captureEndpointCount > 0 && renderEndpointCount > 0 } : {}),
      spotifyRunning: own(value, 'spotifyRunning'), driverInstallerAvailable: own(value, 'driverInstallerAvailable'),
      connectSelected: selected(connectId), captureSelected: selected(own(selection, 'captureDeviceId')),
      renderSelected: selected(own(selection, 'renderDeviceId')), selectedSpotifyListed: listed, selectedSpotifyActive: active,
      internal44100Confirmed: own(selection, 'internal44100Confirmed'), spotifyOnlyConfirmed: own(selection, 'spotifyOnlyConfirmed'),
      defaultsConfirmed: own(selection, 'defaultsConfirmed'),
      captureMixSampleRate: own(probe, 'captureMixSampleRate'), renderMixSampleRate: own(probe, 'renderMixSampleRate'),
      channels: own(probe, 'channels'), temporaryFormatLeaseEligible: own(probe, 'temporaryFormatLeaseEligible'),
      formatLeaseApplied: own(probe, 'formatLeaseApplied'), routeVerified: own(probe, 'routeVerified'),
      ...(['openDriver', 'openCablePanel'].includes(operation) ? { vendorLaunchAcknowledged: true } : {}),
      installationVerification: 'unknown',
    });
  } catch { /* A diagnostic sink never changes setup results. */ }
}
module.exports = { reportCableCapture, reportCableHelper, reportCableSetup, reportOwnedRoute };
