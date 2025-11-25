import { buildServer } from "./server";
import { env } from "./env";

async function main() {
  const server = buildServer();

  try {
    await server.listen({
      port: env.PORT,
      host: env.HOST
    });
    server.log.info(`HTTP server listening on ${env.HOST}:${env.PORT}`);
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
}

void main();



