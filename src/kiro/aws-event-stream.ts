/**
 * AWS Event Stream Parser for Kiro/CodeWhisperer
 *
 * Parses the AWS binary event stream format used by CodeWhisperer APIs.
 * Format: [total_length:4][headers_length:4][prelude_crc:4][headers:headers_length][payload][message_crc:4]
 */

/**
 * Parse AWS event stream from a ReadableStream (for streaming responses)
 * @param {ReadableStream} stream - The readable stream from fetch response
 * @yields {Object} Parsed events as they arrive
 */
export async function* parseEventStreamAsync(stream) {
    const reader = stream.getReader();
    let buffer = new Uint8Array(0);
    
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            // Append new data to buffer
            const newBuffer = new Uint8Array(buffer.length + value.length);
            newBuffer.set(buffer);
            newBuffer.set(value, buffer.length);
            buffer = newBuffer;
            
            // Parse complete messages from buffer
            let offset = 0;
            while (offset < buffer.length) {
                if (offset + 12 > buffer.length) break;
                
                const view = new DataView(buffer.buffer, buffer.byteOffset + offset);
                const totalLength = view.getUint32(0);
                
                if (offset + totalLength > buffer.length) break;
                
                const headersLength = view.getUint32(4);
                const payloadOffset = offset + 12 + headersLength;
                const payloadLength = totalLength - headersLength - 16;
                
                if (payloadLength > 0) {
                    const payload = new TextDecoder().decode(
                        buffer.slice(payloadOffset, payloadOffset + payloadLength)
                    );
                    
                    try {
                        yield JSON.parse(payload);
                    } catch (e) {
                        yield { raw: payload };
                    }
                }
                
                offset += totalLength;
            }

            // Keep unprocessed data in buffer
            if (offset > 0) {
                buffer = buffer.slice(offset);
            }
        }
    } finally {
        reader.releaseLock();
    }
}
