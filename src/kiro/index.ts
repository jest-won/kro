/**
 * Kiro Client for AWS CodeWhisperer
 *
 * Communicates with AWS CodeWhisperer API using Kiro's authentication tokens.
 * Provides Claude model access through AWS's infrastructure.
 *
 * This module mirrors the cloudcode module but uses AWS APIs instead of Google.
 */

// Re-export public API
export { sendKiroMessageStream } from './streaming-handler.js';
export { listKiroModels } from './model-api.js';
