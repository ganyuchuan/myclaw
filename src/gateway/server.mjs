import { createServer } from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { generateAssistantReply } from "../model/client.mjs";
import { runCopilotWithSharedSession } from "../tool/copilot.mjs";
import { runGitCommand } from "../tool/git.mjs";
import { restartService } from "../tool/service.mjs";
import {
  isRequestFrame,
  makeError,
  makeHello,
  makeResponse,
  safeParseJson,
} from "./protocol.mjs";

const METHODS = ["connect", "send", "agent", "copilot", "git", "service.restart", "cron.list", "cron.add", "cron.update", "cron.remove", "cron.run", "health"];

export function createGatewayServer(config, { cronScheduler } = {}) {
  const sessions = new Map();
  const connections = new Map();

  const sendEventFrame = (socket, event, payload) => {
    if (!socket || socket.readyState !== socket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({ type: "event", event, payload }));
  };

  const shouldPushCronEventToConnection = (connId, state, notify) => {
    if (!state.connected) {
      return false;
    }

    if (!notify || typeof notify !== "object" || Array.isArray(notify)) {
      return true;
    }

    if (notify.type !== "ws") {
      return false;
    }

    if (typeof notify.connId === "string" && notify.connId.trim()) {
      return notify.connId === connId;
    }

    if (typeof notify.clientId === "string" && notify.clientId.trim()) {
      return state.client?.id === notify.clientId;
    }

    return true;
  };

  const broadcastCronFinishedEvent = ({ job, trigger, status, error, output }) => {
    const payload = {
      ts: Date.now(),
      job: {
        id: job?.id,
        name: job?.name,
        action: job?.payload?.action,
      },
      trigger,
      status,
      error: error || null,
      output,
      notify: job?.notify,
    };

    for (const [connId, state] of connections.entries()) {
      if (!shouldPushCronEventToConnection(connId, state, job?.notify)) {
        continue;
      }
      sendEventFrame(state.socket, "cron.finished", payload);
    }
  };

  const unsubscribeCronFinished =
    cronScheduler && typeof cronScheduler.onJobFinished === "function"
      ? cronScheduler.onJobFinished((event) => {
          broadcastCronFinishedEvent(event);
        })
      : null;

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
      sendEventFrame(state.socket, "tick", { ts: Date.now(), connId });
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

          const stream = Boolean(frame.params?.stream);
          const streamId = String(frame.params?.streamId ?? frame.id).trim() || frame.id;

          const sendEvent = (event, payload) => {
            if (socket.readyState !== socket.OPEN) {
              return;
            }
            socket.send(
              JSON.stringify({
                type: "event",
                event,
                payload,
              }),
            );
          };

          const { output, sessionId } = await runCopilotWithSharedSession({
            prompt,
            config: config.copilot,
            onDelta: stream
              ? (delta) => {
                  sendEvent("copilot.delta", {
                    requestId: frame.id,
                    streamId,
                    delta,
                  });
                }
              : undefined,
            onDone: stream
              ? ({ output: finalOutput, sessionId: finalSessionId }) => {
                  sendEvent("copilot.done", {
                    requestId: frame.id,
                    streamId,
                    outputChars: String(finalOutput ?? "").length,
                    sessionId: finalSessionId || undefined,
                  });
                }
              : undefined,
          });

          socket.send(
            JSON.stringify(
              makeResponse(frame.id, true, { output, sessionId: sessionId || undefined }),
            ),
          );
          return;
        }

        if (frame.method === "git") {
          if (!config.git?.enabled) {
            socket.send(JSON.stringify(badRequest(frame.id, "git tool is disabled")));
            return;
          }

          const command = String(frame.params?.command ?? "");
          const args = Array.isArray(frame.params?.args) ? frame.params.args : undefined;

          const result = await runGitCommand({
            command,
            args,
            config: config.git,
          });

          if (!result.ok) {
            socket.send(
              JSON.stringify(
                makeResponse(
                  frame.id,
                  false,
                  {
                    ...result,
                    allowedCommands: config.git.allowedCommands,
                  },
                  makeError("TOOL_ERROR", result.error || result.output || "git command failed"),
                ),
              ),
            );
            return;
          }

          socket.send(
            JSON.stringify(
              makeResponse(frame.id, true, {
                ...result,
                allowedCommands: config.git.allowedCommands,
              }),
            ),
          );
          return;
        }

        if (frame.method === "service.restart") {
          if (!config.service?.enabled) {
            socket.send(JSON.stringify(badRequest(frame.id, "service tool is disabled")));
            return;
          }

          const target = String(frame.params?.target ?? "").trim().toLowerCase();
          if (!target) {
            socket.send(JSON.stringify(badRequest(frame.id, "service.restart target is required")));
            return;
          }

          const result = await restartService({
            target,
            config: config.service,
          });

          if (!result.ok) {
            socket.send(
              JSON.stringify(
                makeResponse(
                  frame.id,
                  false,
                  result,
                  makeError("TOOL_ERROR", result.output || "service restart failed"),
                ),
              ),
            );
            return;
          }

          socket.send(JSON.stringify(makeResponse(frame.id, true, result)));
          return;
        }

        // ── cron.* methods ──
        if (frame.method === "cron.list") {
          if (!cronScheduler) {
            socket.send(JSON.stringify(badRequest(frame.id, "cron subsystem is disabled")));
            return;
          }
          socket.send(JSON.stringify(makeResponse(frame.id, true, { jobs: cronScheduler.list() })));
          return;
        }

        if (frame.method === "cron.add") {
          if (!cronScheduler) {
            socket.send(JSON.stringify(badRequest(frame.id, "cron subsystem is disabled")));
            return;
          }
          const job = cronScheduler.add(frame.params ?? {});
          socket.send(JSON.stringify(makeResponse(frame.id, true, { job })));
          return;
        }

        if (frame.method === "cron.update") {
          if (!cronScheduler) {
            socket.send(JSON.stringify(badRequest(frame.id, "cron subsystem is disabled")));
            return;
          }
          const id = String(frame.params?.id ?? "").trim();
          if (!id) {
            socket.send(JSON.stringify(badRequest(frame.id, "cron.update requires id")));
            return;
          }
          const { id: _ignored, ...patch } = frame.params;
          const job = cronScheduler.update(id, patch);
          socket.send(JSON.stringify(makeResponse(frame.id, true, { job })));
          return;
        }

        if (frame.method === "cron.remove") {
          if (!cronScheduler) {
            socket.send(JSON.stringify(badRequest(frame.id, "cron subsystem is disabled")));
            return;
          }
          const id = String(frame.params?.id ?? "").trim();
          if (!id) {
            socket.send(JSON.stringify(badRequest(frame.id, "cron.remove requires id")));
            return;
          }
          const result = cronScheduler.remove(id);
          socket.send(JSON.stringify(makeResponse(frame.id, true, result)));
          return;
        }

        if (frame.method === "cron.run") {
          if (!cronScheduler) {
            socket.send(JSON.stringify(badRequest(frame.id, "cron subsystem is disabled")));
            return;
          }
          const id = String(frame.params?.id ?? "").trim();
          if (!id) {
            socket.send(JSON.stringify(badRequest(frame.id, "cron.run requires id")));
            return;
          }
          const result = await cronScheduler.run(id);
          socket.send(JSON.stringify(makeResponse(frame.id, true, result)));
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
      if (typeof unsubscribeCronFinished === "function") {
        unsubscribeCronFinished();
      }
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
