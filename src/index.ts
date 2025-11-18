import { buildServer } from "./server";
import { env } from "./env";

async function main() {
  const server = buildServer();

  try {
    await server.listen({
      port: env.PORT,
      host: "0.0.0.0"
    });
    server.log.info(`HTTP server listening on port ${env.PORT}`);
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
}

void main();



