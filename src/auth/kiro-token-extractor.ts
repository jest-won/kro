/**
 * Kiro Token Extractor Module
 * Extracts OAuth tokens from Kiro CLI's SQLite database
 * with automatic refresh and in-memory caching.
 *
 * Kiro uses AWS OIDC authentication and stores tokens in:
 * - macOS: ~/Library/Application Support/kiro-cli/data.sqlite3
 * - Windows: ~/AppData/Roaming/kiro-cli/data.sqlite3
 * - Linux: ~/.config/kiro-cli/data.sqlite3
 */

import Database from 'better-sqlite3';
import { KIRO_DB_PATH } from '../constants.js';
import { logger } from '../utils/logger.js';

// ─── In-memory token cache ───────────────────────────────────────────────────

interface CachedAuthData {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date | null;
    region: string;
    startUrl: string | null;
    scopes: string[];
    profileArn: string | null;
}

let cachedAuth: CachedAuthData | null = null;
let refreshInProgress: Promise<string | null> | null = null;
let refreshFailedUntil = 0;

// ─── DB read helpers ─────────────────────────────────────────────────────────

function readTokenFromDb(dbPath = KIRO_DB_PATH): CachedAuthData {
    let db;
    try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const row = (db.prepare("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'") as any).get();
        if (!row?.value) throw new Error('No auth token found in Kiro database');

        const value = row.value;
        const tokenData = JSON.parse(value.includes('|') ? value.substring(value.indexOf('|') + 1) : value);
        if (!tokenData.access_token) throw new Error('Auth data missing access_token field');

        return {
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token || null,
            expiresAt: tokenData.expires_at ? new Date(tokenData.expires_at) : null,
            region: tokenData.region || 'us-east-1',
            startUrl: tokenData.start_url || null,
            scopes: tokenData.scopes || [],
            profileArn: getProfileArn(dbPath)
        };
    } catch (error: any) {
        if (error.code === 'SQLITE_CANTOPEN') {
            throw new Error(`Kiro database not found at ${dbPath}. Make sure Kiro CLI is installed and you are logged in.`);
        }
        throw error;
    } finally {
        if (db) db.close();
    }
}

function getDeviceRegistration(dbPath = KIRO_DB_PATH) {
    let db;
    try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const row = (db.prepare("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:device-registration'") as any).get();
        if (!row?.value) {
            logger.warn('[Kiro] No device registration found in DB');
            return null;
        }
        const value = row.value;
        return JSON.parse(value.includes('|') ? value.substring(value.indexOf('|') + 1) : value);
    } catch (e: any) {
        logger.warn(`[Kiro] Failed to read device registration: ${e.message}`);
        return null;
    } finally {
        if (db) db.close();
    }
}

/**
 * Read the CodeWhisperer profile ARN that Kiro CLI persisted in its state table.
 *
 * IdC (Identity Center) / Pro accounts MUST send this ARN with every
 * generateAssistantResponse call, otherwise the API replies
 * 403 "User is not authorized to make this call.".
 * Builder ID accounts have no profile and legitimately send null.
 */
function getProfileArn(dbPath = KIRO_DB_PATH): string | null {
    let db;
    try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const row = (db.prepare("SELECT value FROM state WHERE key = 'api.codewhisperer.profile'") as any).get();
        if (!row?.value) return null;
        const value = row.value;
        const parsed = JSON.parse(value.includes('|') ? value.substring(value.indexOf('|') + 1) : value);
        return parsed?.arn || null;
    } catch {
        return null;
    } finally {
        if (db) db.close();
    }
}

// ─── DB write — persist refreshed token ──────────────────────────────────────

function persistTokenToDb(newAccessToken: string, expiresAt: Date | null, newRefreshToken?: string, dbPath = KIRO_DB_PATH): boolean {
    let db;
    try {
        db = new Database(dbPath, { fileMustExist: true });
        const row = (db.prepare("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'") as any).get();
        if (!row?.value) return false;

        const rawValue = row.value;
        const prefix = rawValue.includes('|') ? rawValue.substring(0, rawValue.indexOf('|') + 1) : '';
        const jsonStr = rawValue.includes('|') ? rawValue.substring(rawValue.indexOf('|') + 1) : rawValue;
        const tokenData = JSON.parse(jsonStr);

        tokenData.access_token = newAccessToken;
        if (expiresAt) {
            tokenData.expires_at = expiresAt.toISOString();
        }
        if (newRefreshToken) {
            tokenData.refresh_token = newRefreshToken;
        }

        const newValue = prefix + JSON.stringify(tokenData);
        db.prepare("UPDATE auth_kv SET value = ? WHERE key = 'kirocli:odic:token'").run(newValue);
        logger.info('[Kiro] Refreshed token persisted to database');
        return true;
    } catch (e: any) {
        // DB might be read-only (e.g., Docker :ro mount) — that's okay, we still have in-memory cache
        logger.debug(`[Kiro] Could not persist token to DB: ${e.message}`);
        return false;
    } finally {
        if (db) db.close();
    }
}

// ─── Token refresh ───────────────────────────────────────────────────────────

async function refreshAccessToken(authData: CachedAuthData): Promise<string | null> {
    if (Date.now() < refreshFailedUntil) {
        logger.debug('[Kiro] Skipping refresh — in cooldown period');
        return null;
    }

    const reg = getDeviceRegistration();
    if (!reg?.client_id || !reg?.client_secret || !authData.refreshToken) {
        logger.warn('[Kiro] Cannot refresh — missing device registration or refresh token');
        logger.debug(`[Kiro] Refresh prereqs: client_id=${!!reg?.client_id}, client_secret=${!!reg?.client_secret}, refresh_token=${!!authData.refreshToken}`);
        return null;
    }

    // Check if device registration itself has expired
    if (reg.client_secret_expires_at) {
        const expiresAt = typeof reg.client_secret_expires_at === 'number'
            ? reg.client_secret_expires_at * 1000
            : new Date(reg.client_secret_expires_at).getTime();
        if (Date.now() > expiresAt) {
            logger.error('[Kiro] ⚠️  Device registration (client_secret) has expired. Re-authenticate with: kiro auth login');
            refreshFailedUntil = Date.now() + 5 * 60 * 1000;
            return null;
        }
    }

    const region = authData.region || 'us-east-1';
    const url = `https://oidc.${region}.amazonaws.com/token`;

    // Try refresh with the given token first, then retry with DB token if different
    // (handles token rotation: Kiro CLI may have refreshed and rotated the refresh_token)
    const tokensToTry: string[] = [authData.refreshToken];

    try {
        const freshFromDb = readTokenFromDb();
        if (freshFromDb.refreshToken && freshFromDb.refreshToken !== authData.refreshToken) {
            logger.info('[Kiro] DB has a different refresh token (rotated externally), will try it too');
            tokensToTry.push(freshFromDb.refreshToken);
        }
        // Also if DB has a valid access token, just use it directly
        if (freshFromDb.expiresAt && freshFromDb.expiresAt > new Date()) {
            logger.info('[Kiro] DB has a valid access token (refreshed externally), using it');
            cachedAuth = freshFromDb;
            return freshFromDb.accessToken;
        }
    } catch {
        // DB read failed, continue with what we have
    }

    logger.debug(`[Kiro] Refreshing token via ${url} (client_id: ${reg.client_id.substring(0, 8)}...)`);

    for (const refreshToken of tokensToTry) {
        try {
            const body: Record<string, string> = {
                grant_type: 'refresh_token',
                client_id: reg.client_id,
                client_secret: reg.client_secret,
                refresh_token: refreshToken
            };

            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(body).toString()
            });

            if (!resp.ok) {
                const errBody = await resp.text().catch(() => '');
                logger.warn(`[Kiro] Token refresh failed: ${resp.status} ${errBody}`);

                // If we have more tokens to try, continue
                if (tokensToTry.indexOf(refreshToken) < tokensToTry.length - 1) {
                    logger.info('[Kiro] Trying next refresh token...');
                    continue;
                }

                if (resp.status === 400 || resp.status === 401) {
                    refreshFailedUntil = Date.now() + 5 * 60 * 1000;
                    logger.error('[Kiro] ⚠️  Refresh token expired. Please re-authenticate with: kiro auth login');
                } else {
                    refreshFailedUntil = Date.now() + 60 * 1000;
                }
                return null;
            }

            const data: any = await resp.json();
            if (!data.access_token) return null;

            const expiresIn = data.expires_in || 3600;
            const expiresAt = new Date(Date.now() + expiresIn * 1000);

            cachedAuth = {
                ...authData,
                accessToken: data.access_token,
                refreshToken: data.refresh_token || refreshToken,
                expiresAt
            };

            persistTokenToDb(data.access_token, expiresAt, data.refresh_token);
            refreshFailedUntil = 0;

            logger.info(`[Kiro] ✓ Token refreshed successfully (expires: ${expiresAt.toISOString()})`);
            return data.access_token;
        } catch (e: any) {
            logger.warn(`[Kiro] Token refresh error: ${e.message}`);
            if (tokensToTry.indexOf(refreshToken) < tokensToTry.length - 1) {
                continue;
            }
            refreshFailedUntil = Date.now() + 30 * 1000;
            return null;
        }
    }

    return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get Kiro auth data with automatic token refresh.
 * Uses in-memory cache to avoid DB reads on every request.
 */
export async function getKiroAuthData(): Promise<CachedAuthData> {
    // 1. If no cache, read from DB
    if (!cachedAuth) {
        cachedAuth = readTokenFromDb();
    }

    // 2. Check if token needs refresh (expired or expiring within 5 minutes)
    const expiresAt = cachedAuth.expiresAt;
    const now = new Date();
    const needsRefresh = expiresAt && (now >= new Date(expiresAt.getTime() - 5 * 60 * 1000));

    if (needsRefresh) {
        logger.info('[Kiro] Token expiring soon, refreshing...');

        // Deduplicate concurrent refresh attempts
        if (!refreshInProgress) {
            refreshInProgress = refreshAccessToken(cachedAuth).finally(() => {
                refreshInProgress = null;
            });
        }

        const newToken = await refreshInProgress;
        if (newToken) {
            // cachedAuth is already updated inside refreshAccessToken
            return cachedAuth;
        }

        // Refresh failed — if token is fully expired, try re-reading DB
        // (in case Kiro CLI refreshed it externally)
        if (expiresAt && now >= expiresAt) {
            logger.info('[Kiro] Token expired, re-reading from DB...');
            try {
                const freshFromDb = readTokenFromDb();
                if (freshFromDb.expiresAt && freshFromDb.expiresAt > now) {
                    cachedAuth = freshFromDb;
                    logger.info('[Kiro] Found fresh token in DB (refreshed externally)');
                    return cachedAuth;
                }
            } catch {
                // DB read failed — continue with expired token
            }
        }

        logger.warn('[Kiro] Refresh failed, using existing token (may be expired)');
    }

    return cachedAuth;
}

/**
 * Invalidate the in-memory token cache.
 * Call this when a 401 is received to force a fresh token on next request.
 */
export function invalidateTokenCache() {
    logger.info('[Kiro] Token cache invalidated');
    cachedAuth = null;
    refreshFailedUntil = 0; // Allow immediate retry
}

/**
 * Check if token refresh is currently in a failed cooldown state.
 * When true, the refresh token is likely expired and re-authentication is needed.
 */
export function isRefreshBlocked(): boolean {
    return Date.now() < refreshFailedUntil;
}

/**
 * Check if Kiro database exists and is accessible
 */
export function isKiroDatabaseAccessible(dbPath = KIRO_DB_PATH) {
    let db;
    try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        return true;
    } catch {
        return false;
    } finally {
        if (db) db.close();
    }
}

/**
 * Check if Kiro is authenticated (has valid token or can refresh)
 */
export function isKiroAuthenticated() {
    try {
        // If we have a cached token that's not expired, we're good
        if (cachedAuth?.accessToken) {
            if (!cachedAuth.expiresAt || new Date() < cachedAuth.expiresAt) {
                return true;
            }
            // Expired but might be refreshable
            if (cachedAuth.refreshToken) return true;
        }

        const data = readTokenFromDb();
        if (!data.accessToken) return false;

        // Even if expired, if we have a refresh token, we can recover
        if (data.expiresAt && new Date() >= data.expiresAt) {
            return !!data.refreshToken;
        }

        return true;
    } catch {
        return false;
    }
}
