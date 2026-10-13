import { expect, it } from 'vitest';
import { nativeRendererErrors, assertNoNativeRendererErrors } from '../../manual/nativeRendererErrorGate.mjs';

it('gates only native renderer failures in this stage and preserves operation/code evidence', () => {
    const diagnostic = { events: [
        { at: 10, phase: 'native-error', reason: 'gain:HQPLAYER_COMMAND_REJECTED' },
        { at: 21, phase: 'captured' },
        { at: 22, phase: 'native-error', reason: 'volume:INVALID_REQUEST', backend: 'hqplayer', position: 24 },
    ] };
    expect(nativeRendererErrors(diagnostic, 30)).toEqual([]);
    const errors = nativeRendererErrors(diagnostic, 20);
    expect(errors).toEqual([{ at: 22, operation: 'volume', code: 'INVALID_REQUEST', backend: 'hqplayer', position: 24 }]);
    expect(() => assertNoNativeRendererErrors(errors)).toThrow('volume:INVALID_REQUEST');
    expect(() => assertNoNativeRendererErrors([])).not.toThrow();
});
it('does not include unsafe diagnostic text in a gate error', () => {
    const errors = nativeRendererErrors({ events: [{ at: 1, phase: 'native-error', reason: 'http://private/secret:token' }] }, 0);
    expect(() => assertNoNativeRendererErrors(errors)).toThrow('unknown:NATIVE_REQUEST_FAILED');
    expect(JSON.stringify(errors)).not.toContain('private');
});
