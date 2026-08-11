/**
 * Request Builder for Kiro/AWS CodeWhisperer
 *
 * Builds request payloads and headers for the AWS CodeWhisperer API.
 * Converts Anthropic format to Kiro native format (open-kiro compatible).
 */

import crypto from 'crypto';
import {
    KIRO_MODEL_MAPPING,
    KIRO_HEADERS
} from '../constants.js';

/**
 * Map an Anthropic model name to Kiro's internal model ID
 */
export function mapModelToKiro(anthropicModel: string): string {
    const lower = (anthropicModel || '').toLowerCase();

    if (KIRO_MODEL_MAPPING[lower]) {
        return KIRO_MODEL_MAPPING[lower];
    }

    if (lower.includes('opus')) {
        if (lower.includes('4.7') || lower.includes('4-7')) return 'claude-opus-4.7';
        if (lower.includes('4.5') || lower.includes('4-5')) return 'claude-opus-4.5';
        return 'claude-opus-4.6';
    }
    if (lower.includes('haiku')) return 'claude-haiku-4.5';
    if (lower.includes('sonnet')) {
        if (lower.includes('4.5') || lower.includes('4-5')) return 'claude-sonnet-4.5';
        return 'claude-sonnet-4.6';
    }
    if (lower.includes('minimax')) {
        if (lower.includes('2.1') || lower.includes('m2.1')) return 'minimax-m2.1';
        return 'minimax-m2.5';
    }
    if (lower.includes('deepseek')) return 'deepseek-3.2';
    if (lower.includes('glm')) return 'glm-5';
    if (lower.includes('qwen')) return 'qwen3-coder-next';

    return 'claude-sonnet-4.6';
}

/**
 * Convert Anthropic tool definition to Kiro native toolSpecification
 */
function convertToolToKiro(tool: any) {
    const schema = tool.input_schema || { type: 'object', properties: {} };
    if (!schema.type) schema.type = 'object';

    return {
        toolSpecification: {
            name: tool.name,
            description: tool.description || '',
            inputSchema: { json: schema }
        }
    };
}

/**
 * Convert an Anthropic server-side tool to a regular tool definition
 * so the model can invoke it and the proxy can handle execution.
 */
function convertServerToolToRegular(tool: any) {
    if (tool.type === 'web_search_20250305') {
        return {
            name: 'web_search',
            description: 'Search the web for current information. Returns search results with titles, URLs, and descriptions.',
            input_schema: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'The search query'
                    }
                },
                required: ['query']
            }
        };
    }
    // Unknown server tool — skip
    return null;
}

/**
 * Convert Anthropic tool_result content blocks to Kiro toolResults
 */
function convertToolResultToKiro(msg: any) {
    const results: any[] = [];
    if (!Array.isArray(msg.content)) return results;

    for (const block of msg.content) {
        if (block.type === 'tool_result') {
            const textContent = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                    ? block.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
                    : JSON.stringify(block.content);
            results.push({
                toolUseId: block.tool_use_id,
                content: [{ text: textContent }],
                status: block.is_error ? 'error' : 'success'
            });
        }
    }
    return results;
}

/**
 * Extract text content from a message's content field
 */
function extractTextContent(content: any): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';

    return content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n');
}

/**
 * Extract tool_use blocks from assistant message content
 */
function extractToolUses(content: any): any[] {
    if (!Array.isArray(content)) return [];
    return content
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any) => ({
            toolUseId: b.id,
            name: b.name,
            input: b.input || {}
        }));
}

/**
 * Extract images from message content blocks
 */
function extractImages(content: any): any[] {
    if (!Array.isArray(content)) return [];
    return content
        .filter((b: any) => b.type === 'image' && b.source?.type === 'base64')
        .map((b: any) => ({
            format: b.source.media_type?.split('/')[1] || 'png',
            source: { bytes: b.source.data }
        }));
}

/**
 * Build the Kiro request payload (open-kiro compatible format)
 */
export function buildKiroRequest(anthropicRequest: any) {
    const model = mapModelToKiro(anthropicRequest.model);
    const messages = anthropicRequest.messages || [];
    const tools = anthropicRequest.tools || [];
    const system = anthropicRequest.system || '';

    // Extract system content
    let systemContent = '';
    if (typeof system === 'string') {
        systemContent = system;
    } else if (Array.isArray(system)) {
        systemContent = system
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n');
    }

    // Build history from all messages except the last user message
    const history: any[] = [];

    if (systemContent) {
        history.push({
            userInputMessage: { content: systemContent, origin: 'KIRO_CLI' }
        });
        history.push({
            assistantResponseMessage: { content: 'I understand. I will follow these instructions.' }
        });
    }

    // Find the last user message index
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            lastUserIdx = i;
            break;
        }
    }

    // Build history from messages (excluding last user message)
    for (let i = 0; i < messages.length; i++) {
        if (i === lastUserIdx) continue;
        const msg = messages[i];

        if (msg.role === 'assistant') {
            const text = extractTextContent(msg.content);
            const toolUses = extractToolUses(msg.content);
            const entry: any = { assistantResponseMessage: { content: text } };
            if (toolUses.length > 0) {
                entry.assistantResponseMessage.toolUses = toolUses;
            }
            history.push(entry);
        } else if (msg.role === 'user') {
            const toolResults = convertToolResultToKiro(msg);
            const text = extractTextContent(msg.content);
            const images = extractImages(msg.content);
            const entry: any = {
                userInputMessage: {
                    content: text,
                    origin: 'KIRO_CLI'
                }
            };
            if (images.length > 0) {
                entry.userInputMessage.images = images;
            }
            if (toolResults.length > 0) {
                entry.userInputMessage.userInputMessageContext = { toolResults };
            }
            history.push(entry);
        }
    }

    // Build current message from last user message
    const lastUserMsg = lastUserIdx >= 0 ? messages[lastUserIdx] : { content: '' };
    const currentText = extractTextContent(lastUserMsg.content);
    const currentImages = extractImages(lastUserMsg.content);
    const currentToolResults = convertToolResultToKiro(lastUserMsg);

    const currentMessage: any = {
        userInputMessage: {
            content: currentText,
            modelId: model,
            origin: 'KIRO_CLI'
        }
    };

    if (currentImages.length > 0) {
        currentMessage.userInputMessage.images = currentImages;
    }

    // Attach tools and/or toolResults to current message context
    // Convert server-side tools (e.g. web_search_20250305) to regular tool definitions
    // so Kiro's model can invoke them. The proxy handles execution.
    const context: any = {};
    const convertedTools = tools.map((t: any) => {
        if (t.type && t.type !== 'custom') {
            // Server tool — convert to a regular tool definition
            return convertServerToolToRegular(t);
        }
        return t;
    }).filter(Boolean);
    if (convertedTools.length > 0) {
        context.tools = convertedTools.map(convertToolToKiro);
    }
    if (currentToolResults.length > 0) {
        context.toolResults = currentToolResults;
    }
    if (Object.keys(context).length > 0) {
        currentMessage.userInputMessage.userInputMessageContext = {
            ...currentMessage.userInputMessage.userInputMessageContext,
            ...context
        };
    }

    const payload: any = {
        conversationState: {
            conversationId: crypto.randomUUID(),
            chatTriggerType: 'MANUAL',
            currentMessage,
            history
        },
        profileArn: null
    };

    // Add inference config if any parameters are set
    const inferenceConfig: any = {};
    if (anthropicRequest.max_tokens) inferenceConfig.maxTokens = anthropicRequest.max_tokens;
    if (anthropicRequest.temperature !== undefined) inferenceConfig.temperature = anthropicRequest.temperature;
    if (anthropicRequest.top_p !== undefined) inferenceConfig.topP = anthropicRequest.top_p;
    if (Object.keys(inferenceConfig).length > 0) {
        payload.inferenceConfig = inferenceConfig;
    }

    return payload;
}

/**
 * Build headers for CodeWhisperer API requests
 */
export function buildKiroHeaders(token: string, region = 'us-east-1', streaming = false) {
    return {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': streaming ? 'application/vnd.amazon.eventstream' : 'application/json',
        'X-Amz-Region': region,
        ...KIRO_HEADERS
    };
}
