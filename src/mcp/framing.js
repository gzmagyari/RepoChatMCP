export class StdioJsonRpcServer {
  constructor({ onRequest, onNotification, logger = console.error } = {}) {
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.logger = logger;
    this.buffer = Buffer.alloc(0);
    this.expectedLength = null;
    this.transportMode = null;
    process.stdin.on('data', (chunk) => this.handleChunk(chunk));
    process.stdin.on('error', (error) => this.logger(error));
  }

  start() {
    process.stdin.resume();
  }

  handleChunk(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);

    if (!this.transportMode) {
      this.transportMode = this.detectTransportMode();
      if (!this.transportMode) {
        return;
      }
    }

    if (this.transportMode === 'json-lines') {
      this.handleJsonLines();
      return;
    }

    this.handleContentLengthFrames();
  }

  detectTransportMode() {
    const text = this.buffer.toString('utf8');
    const trimmed = text.replace(/^\uFEFF?[\s\r\n]*/, '');

    if (!trimmed) {
      return null;
    }

    if ('Content-Length:'.startsWith(trimmed) || trimmed.startsWith('Content-Length:')) {
      return 'content-length';
    }

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return 'json-lines';
    }

    return null;
  }

  handleJsonLines() {
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }

      const lineBuffer = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      const line = lineBuffer.toString('utf8').trim();
      if (!line) {
        continue;
      }

      this.handleMessage(line);
    }
  }

  handleContentLengthFrames() {
    while (true) {
      if (this.expectedLength == null) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const headerText = this.buffer.slice(0, headerEnd).toString('utf8');
        const match = headerText.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          this.logger('Missing Content-Length header');
          this.buffer = Buffer.alloc(0);
          return;
        }
        this.expectedLength = Number(match[1]);
        this.buffer = this.buffer.slice(headerEnd + 4);
      }

      if (this.buffer.length < this.expectedLength) return;
      const body = this.buffer.slice(0, this.expectedLength).toString('utf8');
      this.buffer = this.buffer.slice(this.expectedLength);
      this.expectedLength = null;
      this.handleMessage(body);
    }
  }

  async handleMessage(body) {
    let message;
    try {
      message = JSON.parse(body);
    } catch (error) {
      this.logger(`Invalid JSON-RPC payload: ${error.message}`);
      return;
    }

    if (message.id !== undefined && this.onRequest) {
      try {
        const result = await this.onRequest(message);
        this.send({ jsonrpc: '2.0', id: message.id, result });
      } catch (error) {
        this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } });
      }
      return;
    }

    if (this.onNotification) {
      try {
        await this.onNotification(message);
      } catch (error) {
        this.logger(`Notification handler error: ${error.message}`);
      }
    }
  }

  send(message) {
    if (this.transportMode !== 'content-length') {
      process.stdout.write(`${JSON.stringify(message)}\n`);
      return;
    }

    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
    process.stdout.write(Buffer.concat([header, body]));
  }
}
