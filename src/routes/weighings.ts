import { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { z } from "zod";
import { mapUserTypeToRole } from "../lib/userType";
import { sendWeighingNotification } from "../services/pushNotifications";

const createWeighingBodySchema = z.object({
  materialId: z
    .string()
    .min(1, "Informe o material coletado."),
  weightGrams: z
    .union([z.number(), z.string()])
    .transform((value) => Number(value))
    .pipe(
      z
        .number({
          invalid_type_error: "Peso inválido."
        })
        .positive("O peso precisa ser maior que zero.")
    ),
  deviceExternalId: z
    .string()
    .trim()
    .min(1)
    .optional(),
  bagFilled: z.boolean().optional(),
  // Quando o operador eh gestor, identifica a quem atribuir a pesagem. Catador
  // logado tem esse campo ignorado (usa o proprio id).
  wastepickerId: z
    .string()
    .trim()
    .min(1)
    .optional()
});

type MeasurementWithRefs = Prisma.MeasurmentsGetPayload<{
  include: {
    materialRef: { include: { group: true } };
    wastepickerRef: { select: { workerId: true; workerName: true } };
  };
}>;

async function resolveMaterial(identifier: string) {
  const trimmed = identifier.trim();

  const numericId = (() => {
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  })();

  if (numericId !== null) {
    const byId = await prisma.materials.findUnique({
      where: { materialId: numericId }
    });
    if (byId) {
      return byId;
    }
  }

  return prisma.materials.findFirst({
    where: {
      materialName: {
        equals: trimmed,
        mode: "insensitive"
      }
    }
  });
}

function gramsToKilogramsDecimal(grams: number) {
  return new Prisma.Decimal(grams).div(1000);
}

function measurementToDto(measurement: MeasurementWithRefs) {
  const weightKg = new Prisma.Decimal(measurement.weightKg);
  const weightGrams = weightKg.mul(1000).toNumber();
  const group = measurement.materialRef?.group;

  return {
    id: measurement.weightingId.toString(),
    userId: measurement.wastepicker.toString(),
    wastepickerId: measurement.wastepicker.toString(),
    wastepickerName: measurement.wastepickerRef?.workerName ?? null,
    materialId: measurement.material.toString(),
    materialName: measurement.materialRef?.materialName ?? "Material",
    materialGroup: group
      ? { id: group.groupId.toString(), name: group.groupName }
      : null,
    weightGrams: Math.round(weightGrams),
    createdAt: measurement.timeStamp.toISOString()
  };
}

export const weighingsRoutes: FastifyPluginAsync = async (server) => {
  server.get(
    "/me",
    {
      preHandler: [server.authenticate]
    },
    async (request) => {
      const workerId = BigInt(request.user.userId);

      const measurements = await prisma.measurments.findMany({
        where: {
          wastepicker: workerId
        },
        include: {
          materialRef: { include: { group: true } },
          wastepickerRef: { select: { workerId: true, workerName: true } }
        },
        orderBy: {
          timeStamp: "desc"
        },
        take: 100
      });

      return measurements.map(measurementToDto);
    }
  );

  server.post(
    "/",
    {
      preHandler: [server.authenticate]
    },
    async (request) => {
      const operatorId = BigInt(request.user.userId);
      const body = createWeighingBodySchema.parse(request.body);

      const operator = await prisma.workers.findUnique({
        where: { workerId: operatorId },
        select: {
          workerId: true,
          userType: true,
          cooperative: true
        }
      });

      if (!operator?.cooperative) {
        throw server.httpErrors.badRequest(
          "Cooperativa não encontrada para o trabalhador autenticado."
        );
      }

      const operatorRole = mapUserTypeToRole(operator.userType);

      // Decidir a quem atribuir a pesagem:
      // - Gestor: precisa indicar `wastepickerId` no body; valida que o catador
      //   existe, pertence a mesma cooperativa e eh de fato catador.
      // - Catador: usa o proprio id (compat com fluxo antigo de self-service).
      let wastepickerId: bigint;

      if (operatorRole === "manager") {
        if (!body.wastepickerId) {
          throw server.httpErrors.badRequest(
            "Gestor precisa informar wastepickerId ao registrar uma pesagem."
          );
        }

        let parsedWastepickerId: bigint;
        try {
          parsedWastepickerId = BigInt(body.wastepickerId);
        } catch {
          throw server.httpErrors.badRequest("wastepickerId invalido.");
        }

        const target = await prisma.workers.findUnique({
          where: { workerId: parsedWastepickerId },
          select: {
            workerId: true,
            userType: true,
            cooperative: true,
            exitDate: true
          }
        });

        if (!target) {
          throw server.httpErrors.notFound("Catador nao encontrado.");
        }
        if (target.cooperative !== operator.cooperative) {
          throw server.httpErrors.forbidden(
            "Catador pertence a outra cooperativa."
          );
        }
        if (target.exitDate) {
          throw server.httpErrors.badRequest("Catador inativo.");
        }
        if (mapUserTypeToRole(target.userType) !== "worker") {
          throw server.httpErrors.badRequest(
            "wastepickerId precisa apontar para um catador."
          );
        }

        wastepickerId = parsedWastepickerId;
      } else {
        wastepickerId = operatorId;
      }

      const material = await resolveMaterial(body.materialId);

      if (!material) {
        throw server.httpErrors.notFound("Material não encontrado.");
      }

      let device = await prisma.devices.findFirst({
        where: { cooperativeId: operator.cooperative }
      });

      if (!device) {
        device = await prisma.devices.create({
          data: {
            cooperativeId: operator.cooperative
          }
        });
      }

      const measurement = await prisma.measurments.create({
        data: {
          weightKg: gramsToKilogramsDecimal(body.weightGrams),
          timeStamp: new Date(),
          bagFilled: body.bagFilled ?? false,
          wastepicker: wastepickerId,
          material: material.materialId,
          device: device.deviceId
        },
        include: {
          materialRef: { include: { group: true } },
          wastepickerRef: { select: { workerId: true, workerName: true } }
        }
      });

      // So notifica quando foi gestor que pesou — catador em modo legado nao
      // precisa de push (a propria UI ja deu feedback).
      if (operatorRole === "manager") {
        // Fire-and-forget: nao bloqueia a resposta. Erros sao tratados dentro
        // do servico (best-effort, log.warn).
        void sendWeighingNotification({
          wastepickerId,
          materialName: measurement.materialRef?.materialName ?? "Material",
          weightGrams: body.weightGrams,
          weighingId: measurement.weightingId,
          log: request.log
        });
      }

      return measurementToDto(measurement);
    }
  );

  server.post(
    "/requests",
    {
      preHandler: [server.authenticate]
    },
    async (request, reply) => {
      request.log.info(
        { workerId: request.user.userId },
        "Nova solicitação de pesagem registrada."
      );

      reply.code(202);
      return {
        status: "queued"
      };
    }
  );
};

