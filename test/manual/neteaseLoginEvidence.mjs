// Observe the exact Omni authentication attempt without retrying it or retaining credentials/IDs.
const safeCode = value => {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= 9999 ? numeric : null;
};
const safeErrorCode = error => ['auth-required', 'unsupported', 'forbidden', 'unavailable', 'not-found', 'invalid-config'].includes(error?.code)
    ? error.code : 'login-check-failed';
const endpoint = () => ({ observed: false, code: null, nestedCode: null, profilePresent: null, accountPresent: null });
const usableId = value => (typeof value === 'number' || typeof value === 'string')
    && Number.isSafeInteger(Number(value)) && Number(value) > 0;

// Select the synchronous provider call's typed session object; concurrent refreshes have other objects.
export async function checkNeteaseLoginWithEvidence({ omni, api, readSession, now = () => new Date().toISOString() }) {
    const diagnostics = { scope: 'same-omni-attempt', login: endpoint(), account: endpoint(),
        sameCapturedSession: false, sessionUnchanged: false, identityFieldsComplete: false, identitiesMatch: null,
        observationComplete: false };
    const initialCookie = readSession();
    let acquiring = true, selectedSession, loginId, accountId, accountProfileId;
    const loginOriginal = api.getLoginStatus, accountOriginal = api.getUserAccount;
    const loginObserved = async function (session, ...args) {
        if (acquiring) { selectedSession = session; acquiring = false; }
        const selected = session === selectedSession && session && Object.hasOwn(session, 'cookie');
        if (selected) diagnostics.sameCapturedSession = session.cookie === initialCookie;
        try {
            const response = await loginOriginal.call(this, session, ...args);
            if (selected) {
                diagnostics.login = { observed: true, code: safeCode(response?.code), nestedCode: safeCode(response?.data?.code),
                    profilePresent: Boolean(response?.data?.profile), accountPresent: Boolean(response?.data?.account) };
                loginId = response?.data?.profile?.userId ?? response?.data?.profile?.id;
            }
            return response;
        } catch (error) {
            if (selected) { diagnostics.login.observed = true; diagnostics.login.errorCode = safeErrorCode(error); }
            throw error;
        }
    };
    const accountObserved = async function (session, ...args) {
        const selected = selectedSession && session === selectedSession;
        try {
            const response = await accountOriginal.call(this, session, ...args);
            if (selected) {
                diagnostics.account = { observed: true, code: safeCode(response?.code), nestedCode: safeCode(response?.data?.code),
                    profilePresent: Boolean(response?.profile), accountPresent: Boolean(response?.account) };
                accountProfileId = response?.profile?.userId ?? response?.profile?.id;
                accountId = response?.account?.id ?? response?.profile?.userId;
            }
            return response;
        } catch (error) {
            if (selected) { diagnostics.account.observed = true; diagnostics.account.errorCode = safeErrorCode(error); }
            throw error;
        }
    };
    api.getLoginStatus = loginObserved; api.getUserAccount = accountObserved;
    let authenticated = false, errorCode;
    try {
        const attempt = omni.getLoginStatus('netease');
        acquiring = false;
        const user = await attempt;
        authenticated = Boolean(user?.id);
    } catch (error) { errorCode = safeErrorCode(error); }
    finally {
        acquiring = false;
        if (api.getLoginStatus === loginObserved) api.getLoginStatus = loginOriginal;
        if (api.getUserAccount === accountObserved) api.getUserAccount = accountOriginal;
    }
    diagnostics.sessionUnchanged = readSession() === initialCookie;
    diagnostics.identityFieldsComplete = [loginId, accountId, accountProfileId].every(usableId);
    if (diagnostics.login.observed && diagnostics.account.observed) {
        diagnostics.identitiesMatch = diagnostics.identityFieldsComplete
            && String(loginId) === String(accountId) && String(loginId) === String(accountProfileId);
    }
    diagnostics.observationComplete = diagnostics.login.observed && diagnostics.sameCapturedSession;
    const omniAuthenticated = authenticated;
    if (authenticated && (!diagnostics.observationComplete || !diagnostics.sessionUnchanged || diagnostics.identitiesMatch !== true)) {
        authenticated = false; errorCode = 'login-observation-unverified';
    }
    return { authenticated, omniAuthenticated, checkedAt: now(), ...(errorCode ? { errorCode } : {}), diagnostics };
}
