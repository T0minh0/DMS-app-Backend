import { Prisma } from "@prisma/client";
import { DecimalInput, formatDecimal, serializeBigIntDecimal } from "../decimal";
import {
  addToStock,
  calculateBagStateDelta,
  StockDomainError,
  StockSnapshot,
} from "../stock/ledger";

export type MobileWeighingDomainErrorCode =
  | "MATERIAL_NOT_FOUND"
  | "WORKER_NOT_FOUND"
  | "WORKER_SCOPE_DENIED"
  | "DEVICE_NOT_FOUND"
  | "DEVICE_SCOPE_DENIED"
  | "INVALID_BAG_READING";

export class MobileWeighingDomainError extends Error {
  readonly code: MobileWeighingDomainErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    code: MobileWeighingDomainErrorCode,
    message: string,
    status: number,
    details?: unknown,
  ) {
    super(message);
    this.name = "MobileWeighingDomainError";
    this.code = code;
    this.status = status;
    this.details = serializeBigIntDecimal(details);
  }
}

export type RecordMobileWeighingInput = {
  cooperativeId: bigint;
  workerId: bigint;
  materialId: bigint;
  deviceId: bigint;
  reportedWeightKg: DecimalInput;
  bagFilled: boolean;
  measuredAt: Date;
};

type LockedBagStateRow = {
  bagStateId: bigint;
  isBegun: boolean;
  currentKg: Prisma.Decimal;
  lastUpdated: Date;
};

export type MobileMeasurementWithRefs = Prisma.MeasurmentsGetPayload<{
  include: {
    materialRef: { include: { group: true } };
    wastepickerRef: { select: { workerId: true; workerName: true } };
  };
}>;

async function ensureBagStateLocked(
  tx: Prisma.TransactionClient,
  cooperativeId: bigint,
  materialId: bigint,
) {
  await tx.$executeRaw`
    INSERT INTO "material_bag_state" (
      "cooperative_id",
      "material_id",
      "is_begun",
      "current_kg",
      "last_updated"
    )
    VALUES (${cooperativeId}, ${materialId}, false, ${new Prisma.Decimal(0)}, TIMESTAMP '1970-01-01 00:00:00')
    ON CONFLICT ("cooperative_id", "material_id") DO NOTHING
  `;

  const rows = await tx.$queryRaw<LockedBagStateRow[]>`
    SELECT
      "bag_state_id" AS "bagStateId",
      "is_begun" AS "isBegun",
      "current_kg" AS "currentKg",
      "last_updated" AS "lastUpdated"
    FROM "material_bag_state"
    WHERE "cooperative_id" = ${cooperativeId}
      AND "material_id" = ${materialId}
    FOR UPDATE
  `;

  if (!rows[0]) {
    throw new MobileWeighingDomainError(
      "INVALID_BAG_READING",
      "Estado de saco não pôde ser bloqueado para atualização",
      500,
      { cooperativeId, materialId },
    );
  }

  return rows[0];
}

async function assertMaterialWorkerDevice(
  tx: Prisma.TransactionClient,
  input: RecordMobileWeighingInput,
) {
  const [material, worker, device] = await Promise.all([
    tx.materials.findUnique({
      where: { materialId: input.materialId },
      select: { materialId: true },
    }),
    tx.workers.findUnique({
      where: { workerId: input.workerId },
      select: { workerId: true, cooperative: true },
    }),
    tx.devices.findUnique({
      where: { deviceId: input.deviceId },
      select: { deviceId: true, cooperativeId: true },
    }),
  ]);

  if (!material) {
    throw new MobileWeighingDomainError(
      "MATERIAL_NOT_FOUND",
      "Material não encontrado.",
      404,
      { materialId: input.materialId },
    );
  }

  if (!worker) {
    throw new MobileWeighingDomainError(
      "WORKER_NOT_FOUND",
      "Catador não encontrado.",
      404,
      { workerId: input.workerId },
    );
  }

  if (worker.cooperative !== input.cooperativeId) {
    throw new MobileWeighingDomainError(
      "WORKER_SCOPE_DENIED",
      "Catador pertence a outra cooperativa.",
      403,
      {
        workerId: input.workerId,
        workerCooperativeId: worker.cooperative,
        cooperativeId: input.cooperativeId,
      },
    );
  }

  if (!device) {
    throw new MobileWeighingDomainError(
      "DEVICE_NOT_FOUND",
      "Dispositivo não encontrado.",
      404,
      { deviceId: input.deviceId },
    );
  }

  if (device.cooperativeId !== input.cooperativeId) {
    throw new MobileWeighingDomainError(
      "DEVICE_SCOPE_DENIED",
      "Dispositivo fora da cooperativa.",
      403,
      {
        deviceId: input.deviceId,
        deviceCooperativeId: device.cooperativeId,
        cooperativeId: input.cooperativeId,
      },
    );
  }
}

function mapStockError(error: unknown): never {
  if (error instanceof StockDomainError && error.code === "INVALID_BAG_READING") {
    throw new MobileWeighingDomainError(
      "INVALID_BAG_READING",
      error.message,
      422,
      error.details,
    );
  }

  throw error;
}

export async function recordMobileWeighing(
  tx: Prisma.TransactionClient,
  input: RecordMobileWeighingInput,
) {
  await assertMaterialWorkerDevice(tx, input);

  const lockedBagState = await ensureBagStateLocked(
    tx,
    input.cooperativeId,
    input.materialId,
  );

  let delta: ReturnType<typeof calculateBagStateDelta>;
  try {
    delta = calculateBagStateDelta({
      previousCurrentKg: lockedBagState.currentKg,
      reportedCurrentKg: input.reportedWeightKg,
      previousUpdatedAt: lockedBagState.lastUpdated,
      reportedAt: input.measuredAt,
      bagFull: input.bagFilled,
    });
  } catch (error) {
    mapStockError(error);
  }

  const measurement = await tx.measurments.create({
    data: {
      weightKg: formatDecimal(delta.collectedDeltaKg),
      timeStamp: input.measuredAt,
      bagFilled: input.bagFilled,
      wastepicker: input.workerId,
      material: input.materialId,
      device: input.deviceId,
    },
    include: {
      materialRef: { include: { group: true } },
      wastepickerRef: { select: { workerId: true, workerName: true } },
    },
  }) as MobileMeasurementWithRefs;

  await tx.materialBagState.update({
    where: {
      cooperativeId_materialId: {
        cooperativeId: input.cooperativeId,
        materialId: input.materialId,
      },
    },
    data: {
      isBegun: delta.isBegun,
      currentKg: formatDecimal(delta.nextCurrentKg),
      lastUpdated: input.measuredAt,
    },
  });

  let stockSnapshot: StockSnapshot | null = null;
  if (delta.collectedDeltaKg.greaterThan(0)) {
    stockSnapshot = await addToStock(tx, {
      cooperativeId: input.cooperativeId,
      materialId: input.materialId,
      amountKg: delta.collectedDeltaKg,
    });
  }

  return {
    measurement,
    bagState: {
      bagStateId: lockedBagState.bagStateId,
      isBegun: delta.isBegun,
      currentKg: delta.nextCurrentKg,
    },
    collectedDeltaKg: delta.collectedDeltaKg,
    stockSnapshot,
  };
}
