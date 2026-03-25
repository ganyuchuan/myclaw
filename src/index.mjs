import { config } from "./config.mjs";
import { createGatewayServer } from "./gateway/server.mjs";

const server = createGatewayServer(config);

await server.listen();

console.log(`[myclaw] gateway listening on ws://127.0.0.1:${config.port}/ws`);
console.log(`[myclaw] health endpoint: http://127.0.0.1:${config.port}/health`);

const shutdown = async () => {
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
