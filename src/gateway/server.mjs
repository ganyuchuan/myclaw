import { createServer } from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { generateAssistantReply } from "../model/client.mjs";
import { runCopilot } from "../tool/copilot.mjs";
import {
  isRequestFrame,
  makeError,
  makeHello,
  makeResponse,
  safeParseJson,
} from "./protocol.mjs";

const METHODS = ["connect", "send", "agent", "copilot", "health"];

export function createGatewayServer(config) {
  const sessions = new Map();
  const connections = new Map();

  const httpServer = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const payload = JSON.stringify({
        ok: true,
        service: "myclaw-gateway",
        uptimeSec: Math.floor(process.uptime()),
        sessions: sessions.size,
        connections: connections.size,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(payload);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  const tick = setInterval(() => {
    for (const [connId, state] of connections.entries()) {
      if (state.socket.readyState !== state.socket.OPEN) {
        continue;
      }
      state.socket.send(
        JSON.stringify({
          type: "event",
          event: "tick",
          payload: { ts: Date.now(), connId },
        }),
      );
    }
  }, 10_000);

  const getSession = (sessionId) => {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, []);
    }
    return sessions.get(sessionId);
  };

  const unauthorized = (id) => makeResponse(id, false, undefined, makeError("UNAUTHORIZED", "invalid token"));
  const badRequest = (id, message) => makeResponse(id, false, undefined, makeError("INVALID_REQUEST", message));

  wss.on("connection", (socket) => {
    const connId = crypto.randomUUID();
    connections.set(connId, { socket, connected: false });

    socket.on("message", async (buffer) => {
      const raw = buffer.toString("utf8");
      if (Buffer.byteLength(raw, "utf8") > config.maxPayloadBytes) {
        socket.send(JSON.stringify(badRequest("unknown", "payload too large")));
        socket.close(1009, "payload too large");
        return;
      }

      const frame = safeParseJson(raw);
      if (!isRequestFrame(frame)) {
        socket.send(JSON.stringify(badRequest("unknown", "invalid request frame")));
        return;
      }

      const state = connections.get(connId);
      if (!state) {
        return;
      }

      if (!state.connected && frame.method !== "connect") {
        socket.send(JSON.stringify(badRequest(frame.id, "first method must be connect")));
        socket.close(1008, "handshake required");
        return;
      }

      try {
        if (frame.method === "connect") {
          const token = frame.params?.auth?.token;
          if (token !== config.gatewayToken) {
            socket.send(JSON.stringify(unauthorized(frame.id)));
            socket.close(1008, "unauthorized");
            return;
          }

          state.connected = true;
          state.client = frame.params?.client ?? {};
          socket.send(JSON.stringify(makeResponse(frame.id, true, makeHello(connId, METHODS))));
          return;
        }

        if (frame.method === "health") {
          socket.send(
            JSON.stringify(
              makeResponse(frame.id, true, {
                ok: true,
                uptimeSec: Math.floor(process.uptime()),
                sessions: sessions.size,
              }),
            ),
          );
          return;
        }

        if (frame.method === "send") {
          const sessionId = String(frame.params?.sessionId ?? "main");
          const text = String(frame.params?.text ?? "").trim();
          if (!text) {
            socket.send(JSON.stringify(badRequest(frame.id, "send.text is required")));
            return;
          }

          const history = getSession(sessionId);
          history.push({ role: "user", content: text, ts: Date.now() });

          socket.send(
            JSON.stringify(
              makeResponse(frame.id, true, {
                accepted: true,
                sessionId,
                historySize: history.length,
              }),
            ),
          );
          return;
        }

        if (frame.method === "agent") {
          const sessionId = String(frame.params?.sessionId ?? "main");
          const text = frame.params?.text ? String(frame.params?.text) : "";
          const history = getSession(sessionId);
          if (text.trim()) {
            history.push({ role: "user", content: text.trim(), ts: Date.now() });
          }

          const provider = String(config.llm.provider);
          const model = String(config.llm.model);
          const messages = history.map((entry) => ({ role: entry.role, content: entry.content }));

          const reply = await generateAssistantReply({
            messages,
            llm: config.llm,
          });

          history.push({ role: "assistant", content: reply, ts: Date.now() });

          socket.send(
            JSON.stringify(
              makeResponse(frame.id, true, {
                sessionId,
                provider,
                model,
                reply,
                historySize: history.length,
              }),
            ),
          );
          return;
        }

        if (frame.method === "copilot") {
          if (!config.copilot?.enabled) {
            socket.send(JSON.stringify(badRequest(frame.id, "copilot tool is disabled")));
            return;
          }

          const prompt = String(frame.params?.prompt ?? "").trim();
          if (!prompt) {
            socket.send(JSON.stringify(badRequest(frame.id, "copilot.prompt is required")));
            return;
          }

          const output = await runCopilot({ prompt, config: config.copilot });

          socket.send(
            JSON.stringify(
              makeResponse(frame.id, true, { output }),
            ),
          );
          return;
        }

        socket.send(JSON.stringify(badRequest(frame.id, `unknown method: ${frame.method}`)));
      } catch (error) {
        socket.send(
          JSON.stringify(
            makeResponse(frame.id, false, undefined, makeError("INTERNAL_ERROR", String(error?.message ?? error))),
          ),
        );
      }
    });

    socket.on("close", () => {
      connections.delete(connId);
    });
  });

  return {
    listen() {
      return new Promise((resolve) => {
        httpServer.listen(config.port, "127.0.0.1", () => resolve());
      });
    },
    close() {
      clearInterval(tick);
      for (const state of connections.values()) {
        state.socket.close();
      }
      return new Promise((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
