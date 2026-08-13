// ---------------------------------------------------------------------------
// SSE hub -- one event stream per browser tab.
//
// The web UI stays current two ways: the filesystem watcher pushes
// `state-changed` when anything under a project directory moves, and the
// command runner pushes `job-*` events as a spawned CLI command streams
// output. Both funnel through this hub so the server has exactly one place
// that knows how to talk to an EventSource.
// ---------------------------------------------------------------------------

import type { ServerResponse } from 'node:http';

export interface SseEvent {
  event: string;
  data: unknown;
}

interface Client {
  id: number;
  res: ServerResponse;
}

export class EventHub {
  private clients = new Map<number, Client>();
  private nextId = 1;

  /** Attach a response as an SSE stream. Returns a detach function. */
  attach(res: ServerResponse): () => void {
    const id = this.nextId++;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    this.clients.set(id, { id, res });

    // Heartbeat keeps intermediaries from closing an idle stream.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        this.detach(id);
      }
    }, 25_000);
    heartbeat.unref();

    const cleanup = () => {
      clearInterval(heartbeat);
      this.detach(id);
    };
    res.on('close', cleanup);
    return cleanup;
  }

  private detach(id: number): void {
    this.clients.delete(id);
  }

  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients.values()) {
      try {
        client.res.write(payload);
      } catch {
        this.detach(client.id);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
