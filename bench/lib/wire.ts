import type { Socket, TCPSocketListener } from 'bun';

/**
 * A TCP relay that counts what crosses it and can hold every chunk for half a
 * round trip each way. The byte counts are what the link carries, after any
 * compression the two ends agreed on, which is the number a weak 4G link cares
 * about; the delay is what makes a sequence of round trips show up as time.
 */
export interface Wire {
  url: string;
  /** Bytes the client sent, bytes the core sent, TCP chunks the core sent. */
  read(): { up: number; down: number; chunksDown: number };
  reset(): void;
  stop(): void;
}

interface Side {
  peer: Socket<Side> | null;
  /** Written before the peer socket existed, or while it pushed back. */
  backlog: Uint8Array[];
  towardCore: boolean;
}

export function startWire(targetPort: number, oneWayDelayMs = 0): Wire {
  let up = 0;
  let down = 0;
  let chunksDown = 0;

  const flush = (socket: Socket<Side>): void => {
    const side = socket.data;
    while (side.backlog.length > 0) {
      const head = side.backlog[0] as Uint8Array;
      const wrote = socket.write(head);
      if (wrote < head.byteLength) {
        side.backlog[0] = head.subarray(Math.max(0, wrote));
        return;
      }
      side.backlog.shift();
    }
  };

  const forward = (from: Socket<Side>, bytes: Uint8Array): void => {
    if (from.data.towardCore) {
      down += bytes.byteLength;
      chunksDown += 1;
    } else {
      up += bytes.byteLength;
    }
    const copy = new Uint8Array(bytes);
    const deliver = (): void => {
      const peer = from.data.peer;
      if (peer === null) {
        from.data.backlog.push(copy);
        return;
      }
      peer.data.backlog.push(copy);
      flush(peer);
    };
    if (oneWayDelayMs > 0) setTimeout(deliver, oneWayDelayMs);
    else deliver();
  };

  const listener: TCPSocketListener<Side> = Bun.listen<Side>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(client) {
        client.data = { peer: null, backlog: [], towardCore: false };
        void Bun.connect<Side>({
          hostname: '127.0.0.1',
          port: targetPort,
          socket: {
            open(core) {
              core.data = { peer: client, backlog: [], towardCore: true };
              // What the client wrote before the core side existed.
              const early = client.data.backlog.splice(0);
              client.data.peer = core;
              core.data.backlog.push(...early);
              flush(core);
            },
            data(core, bytes) { forward(core, bytes); },
            drain(core) { flush(core); },
            close(core) { setTimeout(() => core.data.peer?.end(), oneWayDelayMs + 5); },
            error(core) { core.data.peer?.end(); },
          },
        });
      },
      data(client, bytes) { forward(client, bytes); },
      drain(client) { flush(client); },
      close(client) { client.data.peer?.end(); },
      error(client) { client.data.peer?.end(); },
    },
  });

  return {
    url: `http://127.0.0.1:${listener.port}`,
    read: () => ({ up, down, chunksDown }),
    reset: () => {
      up = 0;
      down = 0;
      chunksDown = 0;
    },
    stop: () => listener.stop(true),
  };
}
