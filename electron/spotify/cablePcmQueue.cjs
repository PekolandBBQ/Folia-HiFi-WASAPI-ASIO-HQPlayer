'use strict';
const { FRAME_BYTES, QUEUE_BYTES, BOOTSTRAP_QUEUE_BYTES, BOOTSTRAP_HOST_BYTES, failure } = require('./cableCaptureProtocol.cjs');

// electron/spotify/cablePcmQueue.cjs: normal two-second ring with one private, finite startup allowance.
function createCablePcmQueue({ onFailure = () => {}, onDrain = () => {}, bufferedBootstrap = false } = {}) {
  const ring = Buffer.alloc(bufferedBootstrap ? BOOTSTRAP_HOST_BYTES : QUEUE_BYTES), partial = Buffer.alloc(FRAME_BYTES);
  let start = 0, length = 0, partialLength = 0, receivedFrames = 0, pending, error, used = false;
  let published = !bufferedBootstrap, activeLimit = ring.length, nativePrefixBytes = 0;
  function fail(code, notify = true) {
    if (error) return;
    error = failure(code); ring.fill(0); partial.fill(0); length = 0; partialLength = 0;
    const waiting = pending; pending = null; waiting?.reject(error);
    if (notify) { try { onFailure(error); } catch {} }
  }
  // Only actual low water after the entire native prefix arrives can retire startup space.
  // Reading an old prefix byte is not net drainage when the live source produces at the same rate.
  function shrink() {
    if (!bufferedBootstrap || !published || receivedFrames * FRAME_BYTES + partialLength < nativePrefixBytes) return;
    const resident = length + partialLength;
    activeLimit = Math.min(activeLimit, resident <= QUEUE_BYTES ? QUEUE_BYTES
      : Math.ceil((resident + QUEUE_BYTES) / FRAME_BYTES) * FRAME_BYTES);
  }
  function read() {
    const count = Math.min(length, 32768), bytes = Buffer.allocUnsafe(count);
    const first = Math.min(count, ring.length - start);
    ring.copy(bytes, 0, start, start + first); ring.fill(0, start, start + first);
    if (first < count) { ring.copy(bytes, first, 0, count - first); ring.fill(0, 0, count - first); }
    start = (start + count) % ring.length; length -= count; shrink();
    onDrain();
    return { value: bytes, done: false };
  }
  function append(bytes) {
    if (!bytes.length) return;
    const offset = (start + length) % ring.length, first = Math.min(bytes.length, ring.length - offset);
    bytes.copy(ring, offset, 0, first);
    if (first < bytes.length) bytes.copy(ring, 0, first);
    length += bytes.length; receivedFrames += bytes.length / FRAME_BYTES;
  }
  return {
    // Main calls this only after both independent route proofs. It does not discard or reorder PCM.
    beginPublication(prefixFrames) {
      if (error) throw error;
      if (!bufferedBootstrap || published || used || !Number.isSafeInteger(prefixFrames) || prefixFrames < 0
        || prefixFrames * FRAME_BYTES > BOOTSTRAP_QUEUE_BYTES) throw failure('CAPTURE_PROTOCOL_INVALID');
      nativePrefixBytes = prefixFrames * FRAME_BYTES;
      const receivedBytes = receivedFrames * FRAME_BYTES + partialLength;
      const debt = length + partialLength + Math.max(0, nativePrefixBytes - receivedBytes);
      if (debt > BOOTSTRAP_QUEUE_BYTES) throw failure('CAPTURE_PROTOCOL_INVALID');
      activeLimit = Math.min(BOOTSTRAP_HOST_BYTES, Math.ceil((debt + QUEUE_BYTES) / FRAME_BYTES) * FRAME_BYTES);
      published = true; shrink();
      return Math.ceil(Math.max(nativePrefixBytes, receivedBytes) / FRAME_BYTES);
    },
    push(input) {
      if (error) return;
      if (!(input instanceof Uint8Array)) { fail('CAPTURE_FRAME_INVALID'); return; }
      const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
      if (length + partialLength + bytes.length > activeLimit) { fail('CAPTURE_OVERFLOW'); return; }
      let offset = 0;
      if (partialLength) {
        const count = Math.min(FRAME_BYTES - partialLength, bytes.length);
        bytes.copy(partial, partialLength, 0, count); partialLength += count; offset += count;
        if (partialLength === FRAME_BYTES) { append(partial); partial.fill(0); partialLength = 0; }
      }
      const aligned = Math.floor((bytes.length - offset) / FRAME_BYTES) * FRAME_BYTES;
      append(bytes.subarray(offset, offset + aligned)); offset += aligned;
      if (offset < bytes.length) { bytes.copy(partial, 0, offset); partialLength = bytes.length - offset; }
      if (pending && length) { const waiting = pending; pending = null; waiting.resolve(read()); }
    },
    end() { fail(partialLength ? 'CAPTURE_FRAME_INVALID' : 'CAPTURE_PIPE_CLOSED'); },
    cancel(code = 'CANCELLED') { fail(code, false); },
    get queuedBytes() { return length + partialLength; },
    get capacityBytes() { return activeLimit; },
    get receivedFrames() { return receivedFrames; },
    stream: {
      [Symbol.asyncIterator]() {
        if (used) throw failure('CAPTURE_READER_USED');
        if (!published) throw failure('CAPTURE_PROTOCOL_INVALID');
        used = true;
        return {
          next() {
            if (error) return Promise.reject(error);
            if (pending) return Promise.reject(failure('CAPTURE_READ_PENDING'));
            if (length) return Promise.resolve(read());
            return new Promise((resolve, reject) => { pending = { resolve, reject }; });
          },
          return() { fail('CANCELLED'); return Promise.resolve({ done: true }); },
          [Symbol.asyncIterator]() { return this; },
        };
      },
    },
  };
}
module.exports = { createCablePcmQueue };
