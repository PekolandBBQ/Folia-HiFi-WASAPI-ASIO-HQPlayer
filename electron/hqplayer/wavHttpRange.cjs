// electron/hqplayer/wavHttpRange.cjs — finite ranges describe an available prefix, never invent future captured bytes.
function wavHttpRange(range, { available, complete, limit }) {
    const total = complete ? available : limit;
    if (!range) return { status: 200, start: 0, end: complete ? total - 1 : null };
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return { status: 416, reason: 'invalid-range' };
    let start = match[1] ? Number(match[1]) : null;
    let end = match[2] ? Number(match[2]) : null;
    if (start === null) {
        if (!Number.isSafeInteger(end) || end <= 0) return { status: 416, reason: 'invalid-suffix' };
        if (!complete) return { status: 503, reason: 'suffix-awaits-producer-end' };
        start = Math.max(0, total - end); end = total - 1;
    }
    if (!Number.isSafeInteger(start) || start < 0 || start >= total
        || (end !== null && (!Number.isSafeInteger(end) || end < start))) return { status: 416, reason: 'outside-representation' };
    // RFC permits ignoring Range. A live read from zero must remain a continuous stream.
    if (!complete && start === 0 && end === null) return { status: 200, start: 0, end: null, reason: 'live-from-zero' };
    if (start >= available) return { status: 503, reason: 'requested-bytes-not-captured' };
    end = Math.min(end ?? available - 1, available - 1);
    return { status: 206, start, end, contentRange: `bytes ${start}-${end}/${complete ? total : '*'}` };
}
module.exports = { wavHttpRange };
