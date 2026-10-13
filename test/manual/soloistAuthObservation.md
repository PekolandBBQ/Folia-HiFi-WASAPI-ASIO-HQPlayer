# Passive Soloist auth observation

The restored `electron/spotify/soloistAuthReadObserver.cjs` observes a caller's existing `readFresh` calls. It does not initiate a read, retry, pairing, playback command, guest start or device selection. No real account or guest execution was performed during this recovery.

For an already-authorized manual runner, create one observer and wrap its existing reader before the normal application uses it:

```js
const { createSoloistAuthReadObserver } = require('../../electron/spotify/soloistAuthReadObserver.cjs');
const observer = createSoloistAuthReadObserver({ onObservation: event => safeRows.push(event) });
const readFresh = observer.wrap(function (...args) {
  return Reflect.apply(owned.readFresh, owned, args);
});
const observedOwned = Object.freeze({ ...owned, readFresh });
```

`readFresh` returns the original Promise and preserves its original result or error. The default records only the first 160 existing calls. `observer.snapshot()` retains at most 160 immutable summaries. The private preview journal explicitly opts into `continuous: true` to stream subsequent observations while the in-memory history stays bounded. The ordinary application path remains unobserved when the private journal is disabled.

Result summaries contain only authentication booleans, a bounded observation number and elapsed time. Rejections contain a fixed error enum and, for `AUTH_SCHEMA_INVALID`, a validated diagnostic with stage, rejection reason, frame enum, top-level/event/field type categories and an optional bounded close code. Payloads, arbitrary event names, close reasons, account identifiers and credentials are never copied. Sink, clock and malformed diagnostic failures cannot replace the original result or error.

The guest still requires its first frame to be TEXT containing `auth_state`, with actual boolean `logged_in` and `is_active` fields. Malformed JSON retains `PROTOCOL_INVALID`. This instrumentation adds no retries; the existing pre-ready polling policy is unchanged, and post-ready auth-schema failures remain visible.

The historical `formal-auth-restore-v8-1791068611802.json` report remains a failure. It records a logged-out initial read followed by two logged-in discovery reads before stale `pairing-required` progress, and later a ready → failed (`AUTH_SCHEMA_INVALID`) → ready → ready sequence. It does not record the actual first bad frame, so no cause has been inferred or schema rule relaxed.
