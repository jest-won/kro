/**
 * Kiro response converter — streams Kiro responses to Claude Code in Anthropic SSE format.
 *
 * With native tool use, Kiro sends tool_use events directly via the event stream.
 * ThinkingParser handles <thinking> tag extraction from text content.
 */

import { sendKiroMessageStream } from './streaming-handler.js';
import { ThinkingParser } from './thinking-parser.js';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';

/**
 * Stream a single Kiro response turn, converting to Anthropic SSE format.
 * Native tool_use events from Kiro are passed through directly.
 */
export async function* runAgenticLoop(anthropicRequest, signal = null) {
    const messageId = `msg_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`;
    const parser = new ThinkingParser();
    const usage: Record<string, number> = { input_tokens: 0, output_tokens: 0 };

    // Collect all events first to handle thinking/tool_use properly
    const textChunks: string[] = [];
    const toolUseEvents: any[] = [];

    for await (const event of sendKiroMessageStream(anthropicRequest)) {
        if (signal?.aborted) break;

        if (event.type === 'message_delta' && event.usage) {
            Object.assign(usage, event.usage);
            continue;
        }

        // Collect native tool_use blocks from streaming-handler
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

    // Estimate tokens if Kiro didn't provide them
    if (usage.output_tokens === 0 && fullText.length > 0) {
        usage.output_tokens = Math.ceil(fullText.length / 4);
    }
    if (usage.input_tokens === 0) {
        const inputText = JSON.stringify(anthropicRequest.messages) + (anthropicRequest.system || '');
        usage.input_tokens = Math.ceil(inputText.length / 4);
    }

    // Parse thinking from collected text
    const parsed = parser.feed(fullText);
    const final = parser.finalize();
    const thinkingText = (parsed.thinking + final.thinking).trim();
    const regularText = (parsed.text + final.text).trim();

    // Emit message_start
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
            usage
        }
    };

    let blockIndex = 0;

    // Emit thinking block if present
    if (thinkingText) {
        yield { type: 'content_block_start', index: blockIndex, content_block: { type: 'thinking', thinking: '' } };
        yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: thinkingText } };
        yield { type: 'content_block_stop', index: blockIndex };
        blockIndex++;
    }

    if (toolUseEvents.length > 0) {
        // Tool use response: emit text preamble, then tool_use blocks
        logger.info(`[Kiro] Emitting ${toolUseEvents.length} native tool_use block(s)`);

        if (regularText) {
            yield { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } };
            yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: regularText } };
            yield { type: 'content_block_stop', index: blockIndex };
            blockIndex++;
        }

        for (const tu of toolUseEvents) {
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

        yield { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage };
    } else {
        // Plain text response
        if (regularText) {
            yield { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } };
            yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: regularText } };
            yield { type: 'content_block_stop', index: blockIndex };
        }
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage };
    }

    yield { type: 'message_stop' };
}
