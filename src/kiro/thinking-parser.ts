type State = 'detecting' | 'thinking' | 'text';

export interface ThinkingParseResult {
    thinking: string;
    text: string;
}

const OPEN_TAG = '<' + 'thinking>';
const CLOSE_TAG = '</' + 'thinking>';

export class ThinkingParser {
    private state: State = 'detecting';
    private buffer = '';

    feed(content: string): ThinkingParseResult {
        const result: ThinkingParseResult = { thinking: '', text: '' };
        this.buffer += content;

        while (this.buffer.length > 0) {
            if (this.state === 'detecting') {
                const trimmed = this.buffer.trimStart();
                if (trimmed.length === 0) break;

                if (OPEN_TAG.startsWith(trimmed)) {
                    break;
                }
                if (trimmed.startsWith(OPEN_TAG)) {
                    this.state = 'thinking';
                    this.buffer = trimmed.slice(OPEN_TAG.length);
                    continue;
                }
                this.state = 'text';
                this.buffer = trimmed;
                continue;
            }

            if (this.state === 'thinking') {
                const closeIdx = this.buffer.indexOf(CLOSE_TAG);
                if (closeIdx === -1) {
                    for (let i = 1; i < CLOSE_TAG.length; i++) {
                        if (this.buffer.endsWith(CLOSE_TAG.slice(0, i))) {
                            const safe = this.buffer.slice(0, this.buffer.length - i);
                            if (safe) result.thinking += safe;
                            this.buffer = this.buffer.slice(this.buffer.length - i);
                            return result;
                        }
                    }
                    result.thinking += this.buffer;
                    this.buffer = '';
                    break;
                }
                result.thinking += this.buffer.slice(0, closeIdx);
                this.buffer = this.buffer.slice(closeIdx + CLOSE_TAG.length);
                this.state = 'text';
                continue;
            }

            result.text += this.buffer;
            this.buffer = '';
            break;
        }

        return result;
    }

    finalize(): ThinkingParseResult {
        const result: ThinkingParseResult = { thinking: '', text: '' };
        if (this.buffer.length === 0) return result;

        if (this.state === 'thinking') {
            result.thinking = this.buffer;
        } else {
            result.text = this.buffer;
        }
        this.buffer = '';
        return result;
    }
}
