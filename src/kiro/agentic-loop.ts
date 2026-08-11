/**
 * Kiro response converter — streams Kiro responses to Claude Code in Anthropic SSE format.
 *
 * With native tool use, Kiro sends tool_use events directly via the event stream.
 * ThinkingParser handles <thinking> tag extraction from text content.
 *
 * Server-side tools (web_search) are intercepted and executed by the proxy,
 * then re-submitted to Kiro for a final answer.
 */

import { sendKiroMessageStream } from './streaming-handler.js';
import { executeWebSearch } from './web-search.js';
import { ThinkingParser } from './thinking-parser.js';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';

// Server-side tool names that the proxy handles internally
const PROXY_HANDLED_TOOLS = new Set(['web_search']);

// Max internal turns for server-tool execution before giving up
const MAX_INTERNAL_TURNS = 3;

// Accumulated credit usage across all requests (in-memory, resets on restart)
export const kiroUsage = { total_credits: 0, request_count: 0 };

/**
 * Collect all events from a Kiro stream into text + tool_use blocks.
 */
async function collectKiroResponse(anthropicRequest: any, signal?: AbortSignal) {
    const parser = new ThinkingParser();
    const usage: Record<string, number> = { input_tokens: 0, output_tokens: 0 };
    let sessionCredits = 0;
    const textChunks: string[] = [];
    const toolUseEvents: any[] = [];

    for await (const event of sendKiroMessageStream(anthropicRequest)) {
        if (signal?.aborted) break;

        if (event.type === 'message_delta' && event.usage) {
            if (event.usage.kiro_credits !== undefined) {
                sessionCredits += event.usage.kiro_credits;
            } else {
                Object.assign(usage, event.usage);
            }
            continue;
        }

        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            toolUseEvents.push({ start: event });
            continue;
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
            const last = toolUseEvents[toolUseEvents.length - 1];
            if (last) {
                if (!last.inputChunks) last.inputChunks = [];
                last.inputChunks.push(event.delta.partial_json);
            }
            continue;
        }
        if (event.type === 'content_block_stop' && toolUseEvents.length > 0) {
            const last = toolUseEvents[toolUseEvents.length - 1];
            if (last && !last.stop) last.stop = event;
            continue;
        }

        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            textChunks.push(event.delta.text);
        }
    }

    const fullText = textChunks.join('');
    const parsed = parser.feed(fullText);
    const final = parser.finalize();
    const thinkingText = (parsed.thinking + final.thinking).trim();
    const regularText = (parsed.text + final.text).trim();

    // Estimate tokens if Kiro didn't provide them
    if (usage.output_tokens === 0 && fullText.length > 0) {
        usage.output_tokens = Math.ceil(fullText.length / 4);
    }
    if (usage.input_tokens === 0) {
        const inputText = JSON.stringify(anthropicRequest.messages) + (anthropicRequest.system || '');
        usage.input_tokens = Math.ceil(inputText.length / 4);
    }

    return { thinkingText, regularText, toolUseEvents, usage, sessionCredits };
}

/**
 * Parse tool_use events into structured objects with parsed input.
 */
function parseToolUseEvents(toolUseEvents: any[]) {
    return toolUseEvents.map(tu => {
        const block = tu.start.content_block;
        let input = {};
        if (tu.inputChunks?.length > 0) {
            try { input = JSON.parse(tu.inputChunks.join('')); } catch {}
        }
        return { id: block.id, name: block.name, input };
    });
}

/**
 * Execute a proxy-handled tool and return the result text.
 */
async function executeProxyTool(name: string, input: any, model?: string): Promise<string> {
    if (name === 'web_search') {
        const query = input.query || input.q || '';
        if (!query) return 'Error: no search query provided';
        try {
            return await executeWebSearch(query, model);
        } catch (e: any) {
            logger.error(`[WebSearch] Error: ${e.message}`);
            return `Web search failed: ${e.message}`;
        }
    }
    return `Unknown proxy tool: ${name}`;
}

/**
 * Stream a single Kiro response turn, converting to Anthropic SSE format.
 * If the model invokes server-side tools (e.g. web_search), the proxy
 * executes them internally and re-queries Kiro with the results.
 */
export async function* runAgenticLoop(anthropicRequest: any, signal: AbortSignal | null = null) {
    const messageId = `msg_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`;
    let totalUsage: Record<string, number> = { input_tokens: 0, output_tokens: 0 };
    let totalCredits = 0;

    // Internal loop: handle proxy tools (web_search) transparently
    let currentRequest = { ...anthropicRequest };
    let finalThinking = '';
    let finalText = '';
    let finalToolUseEvents: any[] = [];

    for (let turn = 0; turn < MAX_INTERNAL_TURNS; turn++) {
        const result = await collectKiroResponse(currentRequest, signal || undefined);
        totalCredits += result.sessionCredits;
        totalUsage.input_tokens += result.usage.input_tokens;
        totalUsage.output_tokens += result.usage.output_tokens;

        if (turn === 0) finalThinking = result.thinkingText;

        // Check if any tool_use is a proxy-handled tool
        const parsedTools = parseToolUseEvents(result.toolUseEvents);
        const proxyTools = parsedTools.filter(t => PROXY_HANDLED_TOOLS.has(t.name));
        const clientTools = parsedTools.filter(t => !PROXY_HANDLED_TOOLS.has(t.name));

        if (proxyTools.length === 0) {
            // No proxy tools — this is the final response
            finalText = result.regularText;
            // Re-build toolUseEvents for client tools only
            finalToolUseEvents = result.toolUseEvents.filter(tu =>
                !PROXY_HANDLED_TOOLS.has(tu.start.content_block.name)
            );
            break;
        }

        // Execute proxy tools
        logger.info(`[Proxy] Executing ${proxyTools.length} server-side tool(s): ${proxyTools.map(t => t.name).join(', ')}`);

        const toolResults: any[] = [];
        for (const tool of proxyTools) {
            const resultText = await executeProxyTool(tool.name, tool.input, currentRequest.model);
            toolResults.push({
                type: 'tool_result',
                tool_use_id: tool.id,
                content: resultText
            });
        }

        // Build follow-up request with tool results appended
        // Add assistant message with tool_use, then user message with tool_results
        const assistantContent: any[] = [];
        if (result.regularText) {
            assistantContent.push({ type: 'text', text: result.regularText });
        }
        for (const tool of parsedTools) {
            assistantContent.push({
                type: 'tool_use',
                id: tool.id,
                name: tool.name,
                input: tool.input
            });
        }

        const newMessages = [
            ...currentRequest.messages,
            { role: 'assistant', content: assistantContent },
            { role: 'user', content: toolResults }
        ];

        currentRequest = { ...currentRequest, messages: newMessages };
        logger.info(`[Proxy] Re-querying Kiro with tool results (turn ${turn + 2})`);
    }

    // Accumulate credit usage
    if (totalCredits > 0) {
        kiroUsage.total_credits += totalCredits;
        kiroUsage.request_count++;
    }

    // ─── Emit SSE events ─────────────────────────────────────────────────────

    yield {
        type: 'message_start',
        message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: anthropicRequest.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: totalUsage
        }
    };

    let blockIndex = 0;

    // Thinking block
    if (finalThinking) {
        yield { type: 'content_block_start', index: blockIndex, content_block: { type: 'thinking', thinking: '' } };
        yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: finalThinking } };
        yield { type: 'content_block_stop', index: blockIndex };
        blockIndex++;
    }

    if (finalToolUseEvents.length > 0) {
        // Tool use response for client-side tools
        logger.info(`[Kiro] Emitting ${finalToolUseEvents.length} native tool_use block(s)`);

        if (finalText) {
            yield { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } };
            yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: finalText } };
            yield { type: 'content_block_stop', index: blockIndex };
            blockIndex++;
        }

        for (const tu of finalToolUseEvents) {
            const startBlock = tu.start.content_block;
            yield {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'tool_use', id: startBlock.id, name: startBlock.name, input: {} }
            };
            if (tu.inputChunks?.length > 0) {
                yield {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'input_json_delta', partial_json: tu.inputChunks.join('') }
                };
            }
            yield { type: 'content_block_stop', index: blockIndex };
            blockIndex++;
        }

        yield { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: totalUsage };
    } else {
        // Plain text response
        if (finalText) {
            yield { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } };
            yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: finalText } };
            yield { type: 'content_block_stop', index: blockIndex };
        }
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: totalUsage };
    }

    yield { type: 'message_stop' };
}
