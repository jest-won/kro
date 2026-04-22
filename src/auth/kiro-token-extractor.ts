/**
 * Kiro Token Extractor Module
 * Extracts OAuth tokens from Kiro CLI's SQLite database
 *
 * Kiro uses AWS OIDC authentication and stores tokens in:
 * - macOS: ~/Library/Application Support/kiro-cli/data.sqlite3
 * - Windows: ~/AppData/Roaming/kiro-cli/data.sqlite3
 * - Linux: ~/.config/kiro-cli/data.sqlite3
 */

import Database from 'better-sqlite3';
import { KIRO_DB_PATH } from '../constants.js';
import { logger } from '../utils/logger.js';

function getKiroAuthStatus(dbPath = KIRO_DB_PATH) {
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
            refreshToken: tokenData.refresh_token,
            expiresAt: tokenData.expires_at ? new Date(tokenData.expires_at) : null,
            region: tokenData.region || 'us-east-1',
            startUrl: tokenData.start_url,
            scopes: tokenData.scopes || []
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
        if (!row?.value) return null;
        const value = row.value;
        return JSON.parse(value.includes('|') ? value.substring(value.indexOf('|') + 1) : value);
    } catch {
        return null;
    } finally {
        if (db) db.close();
    }
}

let refreshFailedUntil = 0;

async function refreshAccessToken(authData: any): Promise<string | null> {
    if (Date.now() < refreshFailedUntil) return null;

    const reg = getDeviceRegistration();
    if (!reg?.client_id || !reg?.client_secret || !authData.refreshToken) return null;

    const region = authData.region || 'us-east-1';
    const url = `https://oidc.${region}.amazonaws.com/token`;

    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: reg.client_id,
                client_secret: reg.client_secret,
                refresh_token: authData.refreshToken
            }).toString()
        });

        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            logger.warn(`[Kiro] Token refresh failed: ${resp.status} ${body}`);
            // Don't retry for 10 minutes on failure
            refreshFailedUntil = Date.now() + 10 * 60 * 1000;
            return null;
        }

        const data: any = await resp.json();
        logger.info('[Kiro] Token refreshed successfully');
        return data.access_token || null;
    } catch (e: any) {
        logger.warn(`[Kiro] Token refresh error: ${e.message}`);
        return null;
    }
}

export async function getKiroAuthData() {
    const data = getKiroAuthStatus();

    // Refresh if expired or expiring within 5 minutes
    const expiresAt = data.expiresAt;
    const needsRefresh = expiresAt && (new Date() >= new Date(expiresAt.getTime() - 5 * 60 * 1000));

    if (needsRefresh) {
        logger.info('[Kiro] Token expiring soon, refreshing...');
        const newToken = await refreshAccessToken(data);
        if (newToken) {
            return { ...data, accessToken: newToken };
        }
        logger.warn('[Kiro] Refresh failed, using existing token');
    }

    return data;
}

/**
 * Check if Kiro database exists and is accessible
 * @param {string} [dbPath] - Optional custom database path
 * @returns {boolean} True if database exists and can be opened
 */
export function isKiroDatabaseAccessible(dbPath = KIRO_DB_PATH) {
    let db;
    try {
        db = new Database(dbPath, {
            readonly: true,
            fileMustExist: true
        });
        return true;
    } catch {
        return false;
    } finally {
        if (db) {
            db.close();
        }
    }
}

/**
 * Check if Kiro is authenticated (has valid token)
 * @returns {boolean} True if authenticated
 */
export function isKiroAuthenticated() {
    try {
        const data = getKiroAuthStatus();

        // Check if token is expired
        if (data.expiresAt && new Date() >= data.expiresAt) {
            logger.warn('[Kiro] Token is expired');
            return false;
        }

        return !!data.accessToken;
    } catch {
        return false;
    }
}

