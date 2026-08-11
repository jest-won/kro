/**
 * Web Search via Kiro
 *
 * When Claude Code requests web_search (an Anthropic server tool),
 * this module sends a search query to Kiro and returns results
 * formatted as Anthropic web_search tool_result.
 */

import { getKiroAuthData } from '../auth/kiro-token-extractor.js';
import { buildKiroHeaders, mapModelToKiro } from './request-builder.js';
import { parseEventStreamAsync } from './aws-event-stream.js';
import { KIRO_ENDPOINTS, KIRO_API_PATHS, KIRO_DEFAULT_REGION } from '../constants.js';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';

/**
 * Execute a web search query via Kiro by asking it to search the web.
 * Returns the raw text response from Kiro containing search results.
 */
export async function executeWebSearch(query: string, model?: string): Promise<string> {
    const authData = await getKiroAuthData();
    const token = authData.accessToken;
    const region = authData.region || KIRO_DEFAULT_REGION;

    if (!token) {
        throw new Error('No Kiro authentication token available');
    }

    const kiroModel = mapModelToKiro(model || 'claude-sonnet-4-6');
    const endpoint = KIRO_ENDPOINTS[region] || KIRO_ENDPOINTS[KIRO_DEFAULT_REGION];
    const url = `${endpoint}${KIRO_API_PATHS.GENERATE_ASSISTANT}`;

    const payload = {
        conversationState: {
            conversationId: crypto.randomUUID(),
            chatTriggerType: 'MANUAL',
            currentMessage: {
                userInputMessage: {
                    content: `Search the web for: "${query}"\n\nProvide the search results with URLs, titles, and brief descriptions. Format each result as:\n- Title: [title]\n  URL: [url]\n  Description: [description]`,
                    modelId: kiroModel,
                    origin: 'KIRO_CLI'
                }
            },
            history: []
        },
        profileArn: null
    };

    const headers = {
        ...buildKiroHeaders(token, region, true),
        'x-amzn-access-model': kiroModel,
        'Accept': 'application/vnd.amazon.eventstream'
    };

    logger.info(`[WebSearch] Querying Kiro for: "${query}"`);

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Kiro web search failed: ${response.status} ${errorText}`);
    }

    // Collect all text from the streaming response
    const textChunks: string[] = [];
    for await (const event of parseEventStreamAsync(response.body)) {
        if (event.content !== undefined && typeof event.content === 'string') {
            textChunks.push(event.content);
        } else if (event.assistantResponseEvent?.content) {
            textChunks.push(event.assistantResponseEvent.content);
        }
    }

    const result = textChunks.join('');
    logger.info(`[WebSearch] Got ${result.length} chars from Kiro`);
    return result;
}

/**
 * Format Kiro's search response into Anthropic web_search_tool_result format
 */
export function formatSearchResult(query: string, kiroResponse: string) {
    return {
        type: 'web_search_tool_result',
        content: [
            {
                type: 'web_search_result',
                title: `Search results for: ${query}`,
                url: `https://search.kiro.dev/?q=${encodeURIComponent(query)}`,
                content: kiroResponse
            }
        ]
    };
}
