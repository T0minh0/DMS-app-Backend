import { FastifyPluginAsync } from "fastify";
import { prisma } from "../prisma";

interface NoticeRow {
  noticeId: bigint;
  cooperativeId: bigint | null;
  createdAt: Date;
  lastUpdated: Date;
  createdBy: bigint;
  priority: number;
  expiresAt: Date | null;
  title: string;
  content: string;
}

// Espelha formatNotice de Web/.../src/app/api/notices/_shared.ts.
function formatNotice(notice: NoticeRow) {
  return {
    _id: notice.noticeId.toString(),
    cooperative_id: notice.cooperativeId?.toString() ?? null,
    created_at: notice.createdAt.toISOString(),
    last_updated: notice.lastUpdated.toISOString(),
    created_by: notice.createdBy.toString(),
    priority: notice.priority,
    expires_at: notice.expiresAt?.toISOString() ?? null,
    title: notice.title,
    content: notice.content,
    is_global: notice.cooperativeId === null,
  };
}

export const noticesRoutes: FastifyPluginAsync = async (server) => {
  // Avisos visiveis ao catador: os globais + os da cooperativa dele, nao expirados.
  // Somente leitura — o catador nao cria nem edita avisos (isso e funcao do gerente
  // no portal web).
  server.get(
    "/",
    {
      preHandler: [server.authenticate],
    },
    async (request) => {
      const workerId = BigInt(request.user.userId);

      const worker = await prisma.workers.findUnique({
        where: { workerId },
        select: { cooperative: true },
      });

      if (!worker) {
        throw server.httpErrors.notFound("Trabalhador não encontrado.");
      }

      const now = new Date();
      const notices = await prisma.noticeBoard.findMany({
        where: {
          AND: [
            {
              OR: [
                { cooperativeId: null },
                { cooperativeId: worker.cooperative },
              ],
            },
            {
              OR: [
                { expiresAt: null },
                { expiresAt: { gt: now } },
              ],
            },
          ],
        },
        orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      });

      return {
        notices: notices.map((notice) => formatNotice(notice)),
      };
    },
  );
};
