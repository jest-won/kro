/**
 * Kiro Token Extractor Module
 * Extracts OAuth tokens from Kiro CLI's SQLite database.
 *
 * Strategy: Always read the latest token from DB. Kiro CLI/IDE manages
 * token refresh internally — this proxy just consumes whatever is current.
 * Short in-memory cache (30s) avoids hitting SQLite on every single request.
 *
 * Kiro stores tokens in:
 * - macOS: ~/Library/Application Support/kiro-cli/data.sqlite3
 * - Windows: ~/AppData/Roaming/kiro-cli/data.sqlite3
 * - Linux: ~/.config/kiro-cli/data.sqlite3
 */

import Database from 'better-sqlite3';
import { KIRO_DB_PATH } from '../constants.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KiroAuthData {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date | null;
    region: string;
    startUrl: string | null;
    scopes: string[];
    profileArn: string | null;
}

// ─── Short-lived cache (avoid DB reads on every request) ────────────────────

const CACHE_TTL_MS = 30_000; // 30 seconds

let cachedAuth: KiroAuthData | null = null;
let cacheReadAt = 0;

// ─── DB read helpers ─────────────────────────────────────────────────────────

function readTokenFromDb(dbPath = KIRO_DB_PATH): KiroAuthData {
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

/**
 * Read the CodeWhisperer profile ARN that Kiro CLI persisted in its state table.
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

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get Kiro auth data. Reads from DB with short-lived cache.
 * On cache miss or expiry, always goes back to DB for the freshest token.
 */
export async function getKiroAuthData(): Promise<KiroAuthData> {
    const now = Date.now();
    const cacheValid = cachedAuth && (now - cacheReadAt < CACHE_TTL_MS);

    if (cacheValid) {
        // Even with a valid cache, check if token is about to expire
        // If so, re-read DB in case Kiro CLI refreshed it
        const expiresAt = cachedAuth!.expiresAt;
        const expiringSoon = expiresAt && (new Date() >= new Date(expiresAt.getTime() - 2 * 60 * 1000));
        if (!expiringSoon) {
            return cachedAuth!;
        }
        logger.debug('[Kiro] Cached token expiring soon, re-reading from DB...');
    }

    // Read fresh from DB
    cachedAuth = readTokenFromDb();
    cacheReadAt = now;

    if (cachedAuth.expiresAt && new Date() >= cachedAuth.expiresAt) {
        logger.warn(`[Kiro] Token from DB is expired (expired at ${cachedAuth.expiresAt.toISOString()}). Kiro CLI may need to refresh it.`);
    }

    return cachedAuth;
}

/**
 * Invalidate the in-memory token cache.
 * Call this on 401/403 to force a fresh DB read on next request.
 */
export function invalidateTokenCache() {
    logger.info('[Kiro] Token cache invalidated — will re-read from DB');
    cachedAuth = null;
    cacheReadAt = 0;
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
 * Check if Kiro is authenticated (has token in DB)
 */
export function isKiroAuthenticated() {
    try {
        const data = readTokenFromDb();
        return !!data.accessToken;
    } catch {
        return false;
    }
}
