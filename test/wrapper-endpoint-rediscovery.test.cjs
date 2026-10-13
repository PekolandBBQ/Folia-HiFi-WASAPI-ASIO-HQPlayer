'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectCableEndpoints } = require('../electron/spotify/cableEndpointSelection.cjs');
// Driver-reinstallation fixtures: these are discovery regressions, not Windows playback evidence.
const endpoint = (id, flow, owner = 'new-driver') => ({ id, flow, name: 'VB-Audio Virtual Cable',
  supportedBaseCable: true, formFactor: flow === 'render' ? 1 : 2,
  baseIdentity: { state: 'verified', ownerInstanceId: owner } });
test('foreign or pre-reinstall IDs resolve to the current verified cable pair', () => {
  assert.deepEqual(selectCableEndpoints([endpoint('new-in', 'capture'), endpoint('new-out', 'render')],
    { captureDeviceId: 'old-in', renderDeviceId: 'old-out' }),
  { captureDeviceId: 'new-in', renderDeviceId: 'new-out' });
});
test('localized or renamed endpoints still use verified driver identity', () => {
  assert.deepEqual(selectCableEndpoints([{ ...endpoint('in', 'capture'), name: '我的虚拟输入' },
    { ...endpoint('out', 'render'), name: '扬声器' }]), { captureDeviceId: 'in', renderDeviceId: 'out' });
});
test('VB keywords alone cannot pair another driver or an unverified endpoint', () => {
  assert.equal(selectCableEndpoints([endpoint('in', 'capture'), endpoint('out', 'render', 'other')]), null);
  assert.equal(selectCableEndpoints([endpoint('in', 'capture'), { ...endpoint('out', 'render'), supportedBaseCable: false }]), null);
  assert.equal(selectCableEndpoints([],{captureDeviceId:'old-in',renderDeviceId:'old-out'}),null);
});
test('multiple verified cables require an existing valid selection', () => {
  const devices=[endpoint('a-in','capture','a'),endpoint('a-out','render','a'),endpoint('b-in','capture','b'),endpoint('b-out','render','b')];
  assert.equal(selectCableEndpoints(devices),null);
  assert.deepEqual(selectCableEndpoints(devices,{captureDeviceId:'b-in',renderDeviceId:'b-out'}),
    {captureDeviceId:'b-in',renderDeviceId:'b-out'});
});
