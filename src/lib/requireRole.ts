import { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../prisma";
import { mapUserTypeToRole, type UserRole } from "./userType";

/**
 * Pre-handler factory que exige que o usuario autenticado tenha um dos `roles`.
 *
 * Uso: `preHandler: [server.authenticate, requireRole("manager")]`.
 *
 * Le `userType` do banco a cada request (custo: 1 query). Faz sentido para uma
 * API com baixa cardinalidade de requests; se virar gargalo, da pra colocar o
 * role no JWT payload e ler la — mas hoje o payload so tem `userId`.
 */
export function requireRole(...roles: UserRole[]) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    const workerId = (() => {
      try {
        return BigInt(request.user.userId);
      } catch {
        return null;
      }
    })();

    if (workerId === null) {
      return reply.code(401).send({
        error: "Token invalido.",
        code: "UNAUTHORIZED"
      });
    }

    const worker = await prisma.workers.findUnique({
      where: { workerId },
      select: { userType: true }
    });

    if (!worker) {
      return reply.code(401).send({
        error: "Usuario nao encontrado.",
        code: "UNAUTHORIZED"
      });
    }

    const role = mapUserTypeToRole(worker.userType);

    if (!roles.includes(role)) {
      return reply.code(403).send({
        error: "Acesso negado.",
        code: "FORBIDDEN"
      });
    }

    // Anota o role no request para handlers reutilizarem sem nova query.
    (request as FastifyRequest & { authRole?: UserRole }).authRole = role;
  };
}
