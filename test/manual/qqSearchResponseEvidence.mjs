// Diagnostic catalog response evidence only. Keep response values to explicit public fields.
const safeText = value => typeof value === 'string' ? value
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '[credential]')
    .replace(/\b(?:access[_-]?token|refresh[_-]?token|cookie|authorization|password|secret|skey|uin)\s*[:=]\s*[^\s,;"']+/gi, '[credential]')
    .replace(/\b[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{10,})*\b/g, '[opaque]')
    .slice(0, 160) : undefined;

const schemaKeys = value => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).filter(key => /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(key)).slice(0, 30) : [];

export function qqSearchResponseEvidence(body, headers = {}) {
    /** @type {Record<string, string>} */
    const messages = {};
    for (const [scope, value] of [['top', body], ['request', body?.request]]) {
        for (const key of ['message', 'msg', 'tips', 'tip']) {
            const text = safeText(value?.[key]);
            if (text !== undefined) messages[`${scope}.${key}`] = text;
        }
    }
    /** @type {Record<string, string>} */
    const responseHeaders = {};
    for (const key of ['content-type', 'cache-control', 'server']) {
        const text = safeText(headers[key]);
        if (text !== undefined) responseHeaders[key] = text;
    }
    const code = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
    return {
        code: code(body?.code), requestCode: code(body?.request?.code),
        responseSchema: { top: schemaKeys(body), request: schemaKeys(body?.request), data: schemaKeys(body?.request?.data) },
        ...(Object.keys(messages).length ? { publicMessages: messages } : {}),
        ...(Object.keys(responseHeaders).length ? { responseHeaders } : {}),
    };
}
