import crypto from "node:crypto";
import WebSocket from "ws";

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createGatewayClient({
  gatewayUrl,
  gatewayToken,
  clientId,
  requestTimeoutMs,
}) {
  let socket = null;
  let connected = false;
  const pending = new Map();
  const eventHandlers = new Set();

  const clearPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const sendFrame = (frame) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("gateway socket is not connected");
    }
    socket.send(JSON.stringify(frame));
  };

  const request = (method, params = {}) => {
    if (!connected && method !== "connect") {
      return Promise.reject(new Error("gateway handshake is not ready"));
    }

    const id = crypto.randomUUID();
    const frame = { type: "req", id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`gateway request timeout: ${method}`));
      }, requestTimeoutMs);

      pending.set(id, { resolve, reject, timer });

      try {
        sendFrame(frame);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  };

  const connect = async () => {
    if (connected) {
      return;
    }

    socket = new WebSocket(gatewayUrl);

    await new Promise((resolve, reject) => {
      const onOpen = () => {
        socket.off("error", onError);
        resolve();
      };
      const onError = (error) => {
        socket.off("open", onOpen);
        reject(error);
      };

      socket.once("open", onOpen);
      socket.once("error", onError);
    });

    socket.on("message", (buffer) => {
      const frame = safeParseJson(buffer.toString("utf8"));
      if (!frame || typeof frame !== "object") {
        return;
      }

      if (frame.type === "event") {
        for (const handler of eventHandlers) {
          try {
            handler(frame);
          } catch {
            // Ignore listener errors so they don't break socket handling.
          }
        }
        return;
      }

      if (frame.type !== "res" || typeof frame.id !== "string") {
        return;
      }

      const entry = pending.get(frame.id);
      if (!entry) {
        return;
      }

      clearTimeout(entry.timer);
      pending.delete(frame.id);

      if (frame.ok) {
        entry.resolve(frame.payload);
        return;
      }

      const message = frame.error?.message || "gateway request failed";
      entry.reject(new Error(message));
    });

    socket.on("close", () => {
      connected = false;
      clearPending(new Error("gateway socket closed"));
    });

    socket.on("error", () => {
      // Connection-level failures are surfaced through close/request errors.
    });

    await request("connect", {
      auth: { token: gatewayToken },
      client: { id: clientId, version: "0.1.0" },
    });

    connected = true;
  };

  const close = () => {
    connected = false;
    if (socket) {
      socket.close();
      socket = null;
    }
    clearPending(new Error("bridge client closed"));
  };

  return {
    connect,
    request,
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => {
        eventHandlers.delete(handler);
      };
    },
    close,
    isConnected: () => connected,
  };
}