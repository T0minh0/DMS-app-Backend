import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { compare, hash } from "bcryptjs";
import { limit } from "./recovery";
import { validNewPassword } from "../lib/auth/password";
import { digest, makeRefresh } from "../lib/auth/session";
import { mapUserTypeToRole } from "../lib/userType";

const loginBodySchema = z.object({
  cpf: z
    .string()
    .min(11, "Informe o CPF.")
    .transform((value) => value.replace(/\D/g, ""))
    .refine((value) => value.length === 11, "Informe um CPF válido."),
  password: z.string().min(1, "Informe a senha."),
  sessionVersion: z.literal(2).optional(),
});

export const authRoutes: FastifyPluginAsync = async (server) => {
  server.post("/login", async (request, reply) => {
    const { cpf, password, sessionVersion } = loginBodySchema.parse(
      request.body,
    );
    if (!(await limit(`login:ip:${request.ip}`, 100, 900)))
      throw server.httpErrors.tooManyRequests(
        "Muitas tentativas. Tente mais tarde.",
      );
    const key = digest(`login:cpf:${cpf}`);
    // The transaction-scoped advisory lock serializes password checks for the
    // same account across API instances. No guess can run past its budget.
    const result = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        const now = new Date();
        const failure = await tx.authAttemptLimit.findUnique({
          where: { key },
        });
        if (failure && failure.expiresAt > now && failure.count >= 10)
          return { status: "limited" as const };
        const worker = await tx.workers.findFirst({
          where: { cpf: Buffer.from(cpf, "utf-8") },
          select: {
            workerId: true,
            workerName: true,
            email: true,
            recoveryEmail: true,
            recoveryEmailVerified: true,
            cpf: true,
            password: true,
            authVersion: true,
            userType: true,
            cooperative: true,
            cooperativeRef: {
              select: { cooperativeId: true, cooperativeName: true },
            },
          },
        });
        const passwordHash = worker?.password
          ? Buffer.from(worker.password).toString("utf-8")
          : "$2a$10$7EqJtq98hPqEX7fNZaFWoO5uG9KWSJ3TXwKEt5S9tMyYXtFMwJDpa";
        const valid = await compare(password, passwordHash);
        if (!worker || !worker.password || !valid) {
          const until = new Date(now.getTime() + 900_000);
          await tx.$queryRaw`INSERT INTO "AuthAttemptLimit" ("key", "count", "expiresAt") VALUES (${key}, 1, (${until}::timestamptz AT TIME ZONE 'UTC'))
            ON CONFLICT ("key") DO UPDATE SET "count" = CASE WHEN "AuthAttemptLimit"."expiresAt" <= (${now}::timestamptz AT TIME ZONE 'UTC') THEN 1 ELSE "AuthAttemptLimit"."count" + 1 END,
            "expiresAt" = CASE WHEN "AuthAttemptLimit"."expiresAt" <= (${now}::timestamptz AT TIME ZONE 'UTC') THEN (${until}::timestamptz AT TIME ZONE 'UTC') ELSE "AuthAttemptLimit"."expiresAt" END RETURNING "count"`;
          return { status: "invalid" as const };
        }
        await tx.authAttemptLimit.deleteMany({ where: { key } });
        return { status: "ok" as const, worker };
      },
      { maxWait: 15_000, timeout: 15_000 },
    );
    if (result.status === "limited")
      throw server.httpErrors.tooManyRequests(
        "Muitas tentativas. Tente mais tarde.",
      );
    if (result.status === "invalid")
      throw server.httpErrors.unauthorized("Credenciais inválidas.");
    const worker = result.worker;
    const session =
      sessionVersion === 2
        ? await makeRefresh(worker.workerId, worker.authVersion)
        : undefined;
    const token = await server.jwt.sign(
      {
        userId: worker.workerId.toString(),
        authVersion: worker.authVersion,
        ...(session ? { sessionVersion: 2, sid: session.id } : {}),
      },
      session ? { expiresIn: "15m" } : {},
    );
    const refreshToken = session?.token;

    const workerCpf =
      worker.cpf && worker.cpf.length > 0
        ? Buffer.from(worker.cpf).toString("utf-8")
        : null;

    return {
      accessToken: token,
      ...(refreshToken ? { refreshToken, expiresIn: 900 } : {}),
      user: {
        id: worker.workerId.toString(),
        name: worker.workerName,
        email: worker.email,
        recoveryEmail: worker.recoveryEmail ?? null,
        recoveryEmailVerified: worker.recoveryEmailVerified ?? false,
        cpf: workerCpf,
        userType: mapUserTypeToRole(worker.userType),
        cooperativeId: worker.cooperative
          ? worker.cooperative.toString()
          : null,
        cooperativeName: worker.cooperativeRef?.cooperativeName ?? null,
      },
    };
  });

  server.get(
    "/me",
    {
      preHandler: [server.authenticate],
    },
    async (request) => {
      const workerId = BigInt(request.user.userId);

      const worker = await prisma.workers.findUnique({
        where: {
          workerId,
        },
        select: {
          workerId: true,
          workerName: true,
          email: true,
          recoveryEmail: true,
          recoveryEmailVerified: true,
          cpf: true,
          userType: true,
          cooperative: true,
          cooperativeRef: {
            select: {
              cooperativeId: true,
              cooperativeName: true,
            },
          },
        },
      });

      if (!worker) {
        throw server.httpErrors.notFound("Trabalhador não encontrado.");
      }

      const workerCpf =
        worker.cpf && worker.cpf.length > 0
          ? Buffer.from(worker.cpf).toString("utf-8")
          : null;

      return {
        id: worker.workerId.toString(),
        name: worker.workerName,
        email: worker.email,
        recoveryEmail: worker.recoveryEmail ?? null,
        recoveryEmailVerified: worker.recoveryEmailVerified ?? false,
        cpf: workerCpf,
        userType: mapUserTypeToRole(worker.userType),
        cooperativeId: worker.cooperative
          ? worker.cooperative.toString()
          : null,
        cooperativeName: worker.cooperativeRef?.cooperativeName ?? null,
      };
    },
  );

  const updateProfileBodySchema = z
    .object({
      name: z.string().min(1, "Nome é obrigatório").optional(),
      email: z.string().email("Email inválido").optional(),
      currentPassword: z
        .string()
        .min(1, "Senha atual é obrigatória")
        .optional(),
      newPassword: z
        .string()
        .min(6, "Nova senha deve ter no mínimo 6 caracteres")
        .optional(),
    })
    .refine(
      (data) => {
        if (data.newPassword && !data.currentPassword) {
          return false;
        }
        return true;
      },
      {
        message: "Senha atual é necessária para definir uma nova senha",
        path: ["currentPassword"],
      },
    );

  server.put(
    "/me",
    {
      preHandler: [server.authenticate],
    },
    async (request) => {
      const workerId = BigInt(request.user.userId);
      const { name, email, currentPassword, newPassword } =
        updateProfileBodySchema.parse(request.body);

      const worker = await prisma.workers.findUnique({
        where: { workerId },
      });

      if (!worker) {
        throw server.httpErrors.notFound("Trabalhador não encontrado.");
      }

      const updateData: any = {};
      if (name) updateData.workerName = name;
      if (email) updateData.email = email;

      if (newPassword && currentPassword) {
        if (!worker.password) {
          throw server.httpErrors.badRequest(
            "Usuário não possui senha definida para alteração.",
          );
        }
        const currentPasswordHash = Buffer.from(worker.password).toString(
          "utf-8",
        );
        const isValid = await compare(currentPassword, currentPasswordHash);
        if (!isValid) {
          throw server.httpErrors.unauthorized("Senha atual incorreta.");
        }
        if (!validNewPassword(newPassword, mapUserTypeToRole(worker.userType)))
          throw server.httpErrors.badRequest("Senha inválida.");
        const newPasswordHash = await hash(newPassword, 10);
        updateData.password = Buffer.from(newPasswordHash, "utf-8");
        updateData.authVersion = { increment: 1 };
      }

      if (Object.keys(updateData).length === 0) {
        const workerCpf =
          worker.cpf && worker.cpf.length > 0
            ? Buffer.from(worker.cpf).toString("utf-8")
            : null;
        return {
          message: "Nenhuma alteração realizada.",
          user: {
            id: worker.workerId.toString(),
            name: worker.workerName,
            email: worker.email,
            recoveryEmail: worker.recoveryEmail ?? null,
            recoveryEmailVerified: worker.recoveryEmailVerified ?? false,
            cpf: workerCpf,
            userType: mapUserTypeToRole(worker.userType),
            cooperativeId: worker.cooperative
              ? worker.cooperative.toString()
              : null,
            cooperativeName: null, // We didn't fetch the cooperative name if no update
          },
        };
      }

      updateData.lastUpdate = new Date();

      const changed = await prisma.workers.updateMany({
        where: { workerId, authVersion: worker.authVersion },
        data: updateData,
      });
      if (changed.count !== 1)
        throw server.httpErrors.conflict(
          "Sessão ou credencial alterada. Entre novamente.",
        );
      const updatedWorker = await prisma.workers.findUniqueOrThrow({
        where: { workerId },
        select: {
          workerId: true,
          workerName: true,
          email: true,
          recoveryEmail: true,
          recoveryEmailVerified: true,
          cpf: true,
          userType: true,
          cooperative: true,
          cooperativeRef: {
            select: {
              cooperativeId: true,
              cooperativeName: true,
            },
          },
        },
      });

      const workerCpf =
        updatedWorker.cpf && updatedWorker.cpf.length > 0
          ? Buffer.from(updatedWorker.cpf).toString("utf-8")
          : null;

      return {
        message: "Perfil atualizado com sucesso.",
        user: {
          id: updatedWorker.workerId.toString(),
          name: updatedWorker.workerName,
          email: updatedWorker.email,
          recoveryEmail: updatedWorker.recoveryEmail ?? null,
          recoveryEmailVerified: updatedWorker.recoveryEmailVerified ?? false,
          cpf: workerCpf,
          userType: mapUserTypeToRole(updatedWorker.userType),
          cooperativeId: updatedWorker.cooperative
            ? updatedWorker.cooperative.toString()
            : null,
          cooperativeName:
            updatedWorker.cooperativeRef?.cooperativeName ?? null,
        },
      };
    },
  );
};
