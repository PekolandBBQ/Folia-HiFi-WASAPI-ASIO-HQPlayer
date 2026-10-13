import { describe, expect, it } from 'vitest';
import { qqSearchResponseEvidence } from '../../manual/qqSearchResponseEvidence.mjs';

describe('QQ public search response diagnostics', () => {
    it('distinguishes a top-level rejection from a nested service failure without retaining the raw response', () => {
        const facts = qqSearchResponseEvidence({ code: 0, request: { code: 2001, message: 'Invalid request', data: { body: { item_song: [] } } },
            account: { private: 'not recorded' } }, { 'content-type': 'application/json', server: 'nginx', 'set-cookie': 'private' });
        expect(facts).toEqual({ code: 0, requestCode: 2001,
            responseSchema: { top: ['code', 'request', 'account'], request: ['code', 'message', 'data'], data: ['body'] },
            publicMessages: { 'request.message': 'Invalid request' }, responseHeaders: { 'content-type': 'application/json', server: 'nginx' } });
        expect(JSON.stringify(facts)).not.toContain('not recorded');
        expect(JSON.stringify(facts)).not.toContain('set-cookie');
    });
    it('redacts URLs and credential-like public error strings before limiting their length', () => {
        const secret = 'aVeryLongCredential0123456789';
        const facts = qqSearchResponseEvidence({ code: 2001, message: `Try https://example.com/?token=${secret} Bearer ${secret} access_token=${secret} ${secret}`,
            request: { tips: 'x'.repeat(500) } }, { server: `gateway https://internal.example/?secret=${secret}`, authorization: secret });
        const serialized = JSON.stringify(facts);
        expect(serialized).not.toContain(secret); expect(serialized).not.toContain('example.com');
        expect(facts.publicMessages?.['top.message']).toContain('[credential]');
        expect(facts.publicMessages?.['request.tips'].length).toBeLessThanOrEqual(160);
        expect(facts.responseHeaders).toEqual({ server: 'gateway [url]' });
    });
    it('rejects arbitrary response value types and unbounded schema while keeping numeric codes exact', () => {
        const extra = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field_${index}`, 'unretained']));
        const facts = qqSearchResponseEvidence({ code: 2001, ...extra, message: { token: 'not text' }, request: { code: '2001', tips: ['not text'] } });
        expect(facts.code).toBe(2001); expect(facts.requestCode).toBeNull();
        expect(facts.responseSchema.top).toHaveLength(30); expect(facts.publicMessages).toBeUndefined();
        expect(JSON.stringify(facts)).not.toContain('unretained');
    });
});
