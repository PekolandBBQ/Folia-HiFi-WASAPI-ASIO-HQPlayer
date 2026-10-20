// electron/hqplayer/wavHttpAddress.cjs — accept equivalent local request forms without exposing or bypassing the session credential.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', 'localhost.', '[::1]', '[0:0:0:0:0:0:0:1]']);

function authority(value, port) {
    if (value === undefined) return { accepted: false, reason: 'missing', display: null };
    if (typeof value !== 'string' || value.length > 128) return { accepted: false, reason: 'invalid', display: '[invalid]' };
    const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]+))?$/i.exec(value.trim());
    if (!match) return { accepted: false, reason: 'invalid', display: '[invalid]' };
    const host = match[1].toLowerCase(), declaredPort = match[2] === undefined ? null : Number(match[2]);
    const local = LOOPBACK.has(host);
    const facts = { display: local ? `${host}${match[2] === undefined ? '' : `:${declaredPort}`}` : '[non-loopback]', declaredPort };
    if (!local) return { ...facts, accepted: false, reason: 'not-loopback' };
    if (declaredPort !== null && declaredPort !== port) return { ...facts, accepted: false, reason: 'port-mismatch' };
    return { ...facts, accepted: true, reason: declaredPort === null ? 'implicit-local-port' : 'local-port' };
}

// Log structure and match results, never the opaque path credential or query values.
function pathPattern(value, token) {
    return value.split('/').slice(0, 8).map(segment => {
        if (!segment) return '';
        if (segment === token) return '[session]';
        if (segment.slice(0, -4) === token && segment.slice(-4).toLowerCase() === '.wav') return '[session].wav';
        return /\.wav$/i.test(segment) ? '[other].wav' : '[other]';
    }).join('/').slice(0, 128);
}

function wavHttpAddress(request, { token, port }) {
    const raw = request.url, host = authority(request.headers.host, port);
    const facts = { requestTargetForm: 'invalid', requestHost: host.display, hostPort: host.declaredPort ?? null,
        expectedPort: port, hostCheck: host.reason, pathMatches: false, pathCredentialMatches: false };
    const reject = (reason) => ({ accepted: false, reason, facts });
    if (typeof raw !== 'string' || raw.length > 4096 || /[\x00-\x20\x7f\\#]/.test(raw)) return reject('invalid-request-target');
    let target = raw, absolute;
    if (/^http:\/\//i.test(raw)) {
        const match = /^http:\/\/([^/?#]+)(.*)$/i.exec(raw);
        if (!match) return reject('invalid-request-target');
        absolute = authority(match[1], port); target = match[2] || '/';
        Object.assign(facts, { requestTargetForm: 'absolute', targetAuthority: absolute.display, targetAuthorityCheck: absolute.reason });
    } else if (raw.startsWith('/') && !raw.startsWith('//')) facts.requestTargetForm = 'origin';
    else return reject('unsupported-request-target');
    const query = target.indexOf('?'), encodedPath = query < 0 ? target : target.slice(0, query);
    facts.hasQuery = query >= 0; facts.requestPathPattern = pathPattern(encodedPath, token);
    let pathname;
    try { pathname = decodeURIComponent(encodedPath); }
    catch { return reject('invalid-path-encoding'); }
    facts.decodedPathPattern = pathPattern(pathname, token); facts.pathWasEncoded = pathname !== encodedPath;
    const match = /^\/([^/]+?)(?:\.wav)?$/i.exec(pathname);
    facts.pathCredentialMatches = match?.[1] === token;
    facts.pathMatches = pathname === `/${token}` || (pathname.slice(0, -4) === `/${token}` && pathname.slice(-4).toLowerCase() === '.wav');
    facts.pathForm = facts.pathMatches ? (pathname === `/${token}` ? 'session-bare' : 'session-wav') : 'other';
    // HTTP/1.0 may omit Host. The socket is already bound only to 127.0.0.1; the exact secret path is still required.
    if (host.reason === 'missing' && request.httpVersion === '1.0') facts.hostCheck = 'http-1.0-host-omitted';
    const hosts = (request.rawHeaders || []).filter((_, index) => index % 2 === 0)
        .filter(name => name.toLowerCase() === 'host').length;
    if (hosts > 1) { facts.hostCheck = 'ambiguous'; return reject('host-ambiguous'); }
    if (!host.accepted && facts.hostCheck !== 'http-1.0-host-omitted') return reject(`host-${host.reason}`);
    if (absolute && !absolute.accepted) return reject(`absolute-host-${absolute.reason}`);
    if (!facts.pathMatches) return reject('path-mismatch');
    return { accepted: true, facts };
}

module.exports = { wavHttpAddress };
