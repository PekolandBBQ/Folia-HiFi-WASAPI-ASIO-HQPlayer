'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Verify the route worker's fixed diagnostic contract independently from operation or platform execution.
const application = path.resolve(process.env.FOLIA_CANDIDATE_ROOT || path.join(__dirname, '../../..'));
const { projectEvent } = require(path.join(application, 'electron/debug/privatePreviewDiagnosticSchema.cjs'));
const causes = 'unknown request-cancelled worker-start-failed worker-image-invalid worker-identity-unconfirmed worker-unavailable worker-eof worker-protocol-invalid worker-stderr-limit journal-context-unavailable journal-root-unavailable journal-root-unsafe journal-security-rejected access-denied io-failed invalid-data json-invalid object-disposed platform-unsupported win32-failed'.split(' ');

test('route inspect failure preserves only approved fixed stages and causes', () => {
  for (const stage of ['worker-start', 'inspect-request']) for (const cause of causes) {
    const fields = { operation: 'inspect', errorCode: 'PRODUCT_OPERATION_FAILED', stage, cause };
    assert.deepEqual(projectEvent('spotify.route-operation-failure', { ...fields,
      message: 'PRIVATE_EXCEPTION', path: 'PRIVATE_PATH', hresult: -1, stdout: 'PRIVATE_STDOUT', processId: 1234 }).fields, fields);
  }
});

test('route operation failure requires every allowlisted field and rejects arbitrary values', () => {
  const fields = { operation: 'inspect', errorCode: 'PRODUCT_OPERATION_FAILED', stage: 'inspect-request', cause: 'worker-eof' };
  for (const key of Object.keys(fields)) {
    const missing = { ...fields }; delete missing[key];
    assert.equal(projectEvent('spotify.route-operation-failure', missing), null);
    assert.equal(projectEvent('spotify.route-operation-failure', { ...fields, [key]: 'PRIVATE_VALUE' }), null);
  }
  assert.equal(projectEvent('spotify.route-operation-failure', { ...fields, operation: 'acquire' }), null);
});
