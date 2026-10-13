'use strict';
const Module = require('node:module');
const path = require('node:path');
// Redirect CommonJS production modules only; preserve the test and output tree.
const candidate = path.resolve(__dirname, '../../electron') + path.sep;
const baseline = '/workspace/scratch/d96e392874a5/folia-rebuild-r35/integrated/application/electron/';
const resolve = Module._resolveFilename;
Module._resolveFilename = function (...args) {
  const resolved = resolve.apply(this, args);
  return resolved.startsWith(candidate) ? baseline + resolved.slice(candidate.length) : resolved;
};
