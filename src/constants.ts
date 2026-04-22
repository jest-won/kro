/**
 * Constants for Kiro Claude Proxy
 * Kiro-specific configuration and AWS CodeWhisperer integration
 */

import { homedir, platform } from 'os';
import { join } from 'path';

/**
 * Get the Kiro CLI database path based on the current platform.
 * Kiro stores OAuth tokens in SQLite database similar to VS Code extensions.
 */
function getKiroDbPath() {
    const home = homedir();
    switch (platform()) {
        case 'darwin':
            return join(home, 'Library/Application Support/kiro-cli/data.sqlite3');
        case 'win32':
            return join(home, 'AppData/Roaming/kiro-cli/data.sqlite3');
        default: // linux, freebsd, etc.
            return join(home, '.config/kiro-cli/data.sqlite3');
    }
}

// Basic configuration
export const REQUEST_BODY_LIMIT = '50mb';
export const DEFAULT_PORT = 8080;
export const MAX_RETRIES = 3; // Max retry attempts

// Kiro CLI database path for token extraction
export const KIRO_DB_PATH = getKiroDbPath();

// AWS CodeWhisperer API endpoints by region
export const KIRO_ENDPOINTS = {
    'us-east-1': 'https://codewhisperer.us-east-1.amazonaws.com',
    'us-west-2': 'https://codewhisperer.us-west-2.amazonaws.com',
    'eu-west-1': 'https://codewhisperer.eu-west-1.amazonaws.com',
    'ap-northeast-1': 'https://codewhisperer.ap-northeast-1.amazonaws.com'
};

// Kiro API paths
export const KIRO_API_PATHS = {
    GENERATE_ASSISTANT: '/generateAssistantResponse',
};

// Default AWS region for Kiro
export const KIRO_DEFAULT_REGION = 'us-east-1';

// Kiro model mappings (Claude model names to Kiro's internal model IDs)
export const KIRO_MODEL_MAPPING = {
    // Claude models
    'claude-opus-4-7':   'claude-opus-4.6',   // 4.7 not available, fallback
    'claude-opus-4-6':   'claude-opus-4.6',
    'claude-opus-4-5':   'claude-opus-4.5',
    'claude-sonnet-4-6': 'claude-sonnet-4.6',
    'claude-sonnet-4-5': 'claude-sonnet-4.5',
    'claude-sonnet-4-0': 'claude-sonnet-4.5',  // 4.0 not available, fallback
    'claude-haiku-4-5':  'claude-haiku-4.5',
    // Open weight models
    'minimax-m2-5':      'minimax-m2.5',
    'glm-5':             'glm-5',
    'deepseek-3-2':      'deepseek-3.2',
    'minimax-m2-1':      'minimax-m2.1',
    'qwen3-coder-next':  'qwen3-coder-next',
    // Auto
    'auto': 'auto'
};

// Kiro-specific headers for AWS CodeWhisperer Streaming Service
export const KIRO_HEADERS = {
    'User-Agent': 'kiro',
    'Content-Type': 'application/json'
};


