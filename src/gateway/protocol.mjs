export const PROTOCOL_VERSION = 1;

export function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function isRequestFrame(frame) {
  return Boolean(
    frame &&
      typeof frame === "object" &&
      frame.type === "req" &&
      typeof frame.id === "string" &&
      frame.id.length > 0 &&
      typeof frame.method === "string" &&
      frame.method.length > 0,
  );
}

export function makeResponse(id, ok, payload, error) {
  return {
    type: "res",
    id,
    ok,
    ...(payload !== undefined ? { payload } : {}),
    ...(error ? { error } : {}),
  };
}

export function makeError(code, message) {
  return {
    code,
    message,
  };
}

export function makeHello(connId, methods) {
  return {
    type: "hello-ok",
    protocol: PROTOCOL_VERSION,
    server: {
      connId,
      version: "myclaw-gateway/0.1.0",
    },
    features: {
      methods,
      events: ["tick"],
    },
  };
}
