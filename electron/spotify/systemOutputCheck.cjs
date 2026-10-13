'use strict';
// Reuse the native inventory; never write system defaults or inspect Spotify volume.
function systemOutputCheck(devices = {}) {
  const defaults = [devices.defaults?.renderConsole, devices.defaults?.renderMultimedia];
  if (defaults.some(e => e?.available !== true || !e.id)) return { state: 'unknown', names: [] };
  const cableIds = new Set((devices.endpoints || []).filter(e => e.flow === 'render' && e.supportedBaseCable === true).map(e => e.id.toLowerCase()));
  const cable = defaults.some(e => cableIds.has(e.id.toLowerCase()) || /VB-Audio.*Cable|CABLE (?:Input|In 16ch)/i.test(e.deviceName || e.name || ''));
  return { state: cable ? 'cable' : 'ready', names: [...new Set(defaults.map(e => e.name).filter(Boolean))] };
}
module.exports = { systemOutputCheck };
