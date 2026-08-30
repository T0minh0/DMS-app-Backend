import { Prisma } from "@prisma/client";
import {
  DecimalInput,
  DecimalValidationError,
  formatDecimal,
  parseDecimal2,
  parseNonNegativeDecimal2,
  parsePositiveDecimal2,
  serializeBigIntDecimal,
} from "../decimal";

type LockedStockRow = {
  stockId: bigint;
  totalCollectedKg: Prisma.Decimal;
  totalSoldKg: Prisma.Decimal;
  currentStockKg: Prisma.Decimal;
};

export type StockSnapshot = {
  stockId?: bigint;
  totalCollectedKg: Prisma.Decimal;
  totalSoldKg: Prisma.Decimal;
  currentStockKg: Prisma.Decimal;
};

export type StockDomainErrorCode =
  | "INVALID_STOCK_DECIMAL"
  | "INVALID_BAG_READING"
  | "STOCK_INVARIANT_VIOLATION";

export class StockDomainError extends Error {
  readonly code: StockDomainErrorCode;
  readonly status = 422;
  readonly details?: unknown;

  constructor(code: StockDomainErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "StockDomainError";
    this.code = code;
    this.details = serializeBigIntDecimal(details);
  }
}

export type AddToStockInput = {
  cooperativeId: bigint;
  materialId: bigint;
  amountKg: DecimalInput;
};

export type BagStateDeltaInput = {
  previousCurrentKg: DecimalInput;
  reportedCurrentKg: DecimalInput;
  previousUpdatedAt: Date | string | number;
  reportedAt: Date | string | number;
  bagFull: boolean;
};

const ZERO = new Prisma.Decimal(0);

function parseStockDecimal(parse: () => Prisma.Decimal) {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DecimalValidationError) {
      throw new StockDomainError("INVALID_STOCK_DECIMAL", error.message, {
        field: error.field,
      });
    }

    throw error;
  }
}

function parseStockDecimal2(value: DecimalInput, field: string) {
  return parseStockDecimal(() => parseDecimal2(value, field));
}

function parsePositiveStockDecimal2(value: DecimalInput, field: string) {
  return parseStockDecimal(() => parsePositiveDecimal2(value, field));
}

function parseNonNegativeStockDecimal2(value: DecimalInput, field: string) {
  return parseStockDecimal(() => parseNonNegativeDecimal2(value, field));
}

function parseReadingTimestamp(value: Date | string | number, field: string) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new StockDomainError(
      "INVALID_BAG_READING",
      `${field} deve ser uma data válida`,
      { field },
    );
  }

  return date;
}

function rowToSnapshot(row: LockedStockRow): StockSnapshot {
  return {
    stockId: row.stockId,
    totalCollectedKg: row.totalCollectedKg,
    totalSoldKg: row.totalSoldKg,
    currentStockKg: row.currentStockKg,
  };
}

function assertNonNegativeStock(snapshot: StockSnapshot) {
  const invalidField = [
    ["totalCollectedKg", snapshot.totalCollectedKg],
    ["totalSoldKg", snapshot.totalSoldKg],
    ["currentStockKg", snapshot.currentStockKg],
  ].find(([, value]) => (value as Prisma.Decimal).lessThan(0));

  if (invalidField) {
    throw new StockDomainError(
      "STOCK_INVARIANT_VIOLATION",
      `Estoque inválido: ${invalidField[0]} não pode ser negativo`,
      snapshot,
    );
  }

  const physicalAvailableKg = snapshot.totalCollectedKg.minus(snapshot.totalSoldKg);
  if (snapshot.currentStockKg.greaterThan(physicalAvailableKg)) {
    throw new StockDomainError(
      "STOCK_INVARIANT_VIOLATION",
      "Estoque inválido: currentStockKg excede totalCollectedKg - totalSoldKg",
      {
        stockId: snapshot.stockId,
        currentStockKg: snapshot.currentStockKg,
        physicalAvailableKg,
      },
    );
  }
}

export async function addToStock(
  tx: Prisma.TransactionClient,
  input: AddToStockInput,
) {
  const amountKg = parsePositiveStockDecimal2(input.amountKg, "amountKg");

  const rows = await tx.$queryRaw<LockedStockRow[]>`
    INSERT INTO "Stock" (
      "Cooperative",
      "Material",
      "Total_collected_KG",
      "Total_sold_KG",
      "Current_stock_KG"
    )
    VALUES (${input.cooperativeId}, ${input.materialId}, ${amountKg}, ${ZERO}, ${amountKg})
    ON CONFLICT ("Cooperative", "Material")
    DO UPDATE SET
      "Total_collected_KG" = "Stock"."Total_collected_KG" + EXCLUDED."Total_collected_KG",
      "Current_stock_KG" = "Stock"."Current_stock_KG" + EXCLUDED."Current_stock_KG"
    RETURNING
      "Stock_id" AS "stockId",
      "Total_collected_KG" AS "totalCollectedKg",
      "Total_sold_KG" AS "totalSoldKg",
      "Current_stock_KG" AS "currentStockKg"
  `;

  const snapshot = rowToSnapshot(rows[0]);
  assertNonNegativeStock(snapshot);
  return snapshot;
}

export function calculateBagStateDelta(input: BagStateDeltaInput) {
  const previousCurrentKg = parseNonNegativeStockDecimal2(
    input.previousCurrentKg,
    "previousCurrentKg",
  );
  const reportedCurrentKg = parseNonNegativeStockDecimal2(
    input.reportedCurrentKg,
    "reportedCurrentKg",
  );
  const previousUpdatedAt = parseReadingTimestamp(
    input.previousUpdatedAt,
    "previousUpdatedAt",
  );
  const reportedAt = parseReadingTimestamp(input.reportedAt, "reportedAt");

  if (reportedAt.getTime() <= previousUpdatedAt.getTime()) {
    throw new StockDomainError(
      "INVALID_BAG_READING",
      "Leitura do saco deve ser posterior à última leitura aceita",
      {
        previousUpdatedAt: previousUpdatedAt.toISOString(),
        reportedAt: reportedAt.toISOString(),
      },
    );
  }

  if (!input.bagFull && reportedCurrentKg.lessThan(previousCurrentKg)) {
    throw new StockDomainError(
      "INVALID_BAG_READING",
      "Leitura acumulada não pode ser menor que o estado atual do saco sem reset",
      {
        previousCurrentKg,
        reportedCurrentKg,
      },
    );
  }

  const collectedDeltaKg = Prisma.Decimal.max(
    reportedCurrentKg.minus(previousCurrentKg),
    ZERO,
  );

  return {
    collectedDeltaKg,
    nextCurrentKg: input.bagFull ? ZERO : reportedCurrentKg,
    isBegun: !input.bagFull,
  };
}
