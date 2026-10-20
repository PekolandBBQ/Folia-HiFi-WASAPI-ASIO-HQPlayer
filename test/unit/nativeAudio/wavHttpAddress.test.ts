import { expect, it } from 'vitest';
import { createRequire } from 'node:module';

// test/unit/nativeAudio/wavHttpAddress.test.ts — local address variants, credential isolation and redacted refusal evidence.
const { wavHttpAddress } = createRequire(import.meta.url)('../../../electron/hqplayer/wavHttpAddress.cjs');
const token = '1234567890abcdef'.repeat(3), port = 32123, pathname = `/${token}.wav`;
const check = (url: string, host: unknown = `127.0.0.1:${port}`, extra = {}) =>
    wavHttpAddress({ url, headers: { host }, httpVersion: '1.1', ...extra }, { token, port });

it.each([
    [pathname, `127.0.0.1:${port}`], [pathname, '127.0.0.1'], [pathname, `LOCALHOST:${port}`],
    [pathname, 'localhost.'], [pathname, `[::1]:${port}`], [pathname, '[::1]'],
    [`http://127.0.0.1:${port}${pathname}`, `localhost:${port}`],
    [`HTTP://LOCALHOST:${port}${pathname}`, '127.0.0.1'],
    [`/${token}`, 'localhost'], [`/${token}.WAV`, '127.0.0.1'],
    [`/${token.replace('1', '%31')}.wav`, '127.0.0.1'],
    [`${pathname}?probe=value&secret=private`, 'localhost'],
])('accepts equivalent local target %s with Host %s', (url, host) => {
    const result = check(url, host);
    expect(result).toMatchObject({ accepted: true, facts: { pathMatches: true, pathCredentialMatches: true } });
    const log = JSON.stringify(result);
    expect(log).not.toContain(token); expect(log).not.toContain('secret=private');
});
it('allows HTTP/1.0 without Host while still checking the exact secret path', () => {
    expect(check(pathname, undefined, { headers: {}, httpVersion: '1.0' }))
        .toMatchObject({ accepted: true, facts: { hostCheck: 'http-1.0-host-omitted' } });
    expect(check('/wrong.wav', undefined, { headers: {}, httpVersion: '1.0' }))
        .toMatchObject({ accepted: false, reason: 'path-mismatch' });
    expect(check(pathname, undefined, { headers: {} })).toMatchObject({ accepted: false, reason: 'host-missing' });
});
it.each([
    ['/other.wav', `127.0.0.1:${port}`, 'path-mismatch'],
    [`/${token.toUpperCase()}.wav`, 'localhost', 'path-mismatch'],
    [`/${token.slice(0, -1)}0.wav`, 'localhost', 'path-mismatch'],
    [`/${token}extra.wav`, 'localhost', 'path-mismatch'],
    [`/other/${token}.wav`, 'localhost', 'path-mismatch'],
    [`/../${token}.wav`, 'localhost', 'path-mismatch'],
    [`/%2e%2e/${token}.wav`, 'localhost', 'path-mismatch'],
    [`/%2531${token.slice(1)}.wav`, 'localhost', 'path-mismatch'],
    [`/?token=${token}`, 'localhost', 'path-mismatch'],
    [pathname, 'example.com', 'host-not-loopback'], [pathname, '127.0.0.1.example.com', 'host-not-loopback'],
    [pathname, `localhost:${port + 1}`, 'host-port-mismatch'], [pathname, 'localhost:0', 'host-port-mismatch'],
    [pathname, 'user:password@localhost', 'host-invalid'],
    [`http://example.com:${port}${pathname}`, `127.0.0.1:${port}`, 'absolute-host-not-loopback'],
    [`http://127.0.0.1:${port + 1}${pathname}`, `127.0.0.1:${port}`, 'absolute-host-port-mismatch'],
    [`http://user:password@localhost:${port}${pathname}`, 'localhost', 'absolute-host-invalid'],
    [`https://localhost:${port}${pathname}`, 'localhost', 'unsupported-request-target'],
    [`//localhost:${port}${pathname}`, 'localhost', 'unsupported-request-target'],
    [`${pathname}#fragment`, 'localhost', 'invalid-request-target'],
    [`/\\${token}.wav`, 'localhost', 'invalid-request-target'],
    ['/%ZZ.wav', 'localhost', 'invalid-path-encoding'],
])('rejects target %s / Host %s with distinct reason %s', (url, host, reason) => {
    const result = check(url, host);
    expect(result).toMatchObject({ accepted: false, reason });
    const log = JSON.stringify(result);
    expect(log).not.toContain(token); expect(log).not.toContain('password'); expect(log).not.toContain('example.com');
});
it('reports both path and Host differences without echoing credentials', () => {
    expect(check('/wrong.wav', `localhost:${port + 1}`)).toMatchObject({ accepted: false,
        reason: 'host-port-mismatch', facts: { requestPathPattern: '/[other].wav', pathMatches: false,
            pathCredentialMatches: false, requestHost: `localhost:${port + 1}`, expectedPort: port } });
    expect(check(pathname, 'localhost', { rawHeaders: ['Host', 'localhost', 'Host', '127.0.0.1'] }))
        .toMatchObject({ accepted: false, reason: 'host-ambiguous' });
});
