// Portado verbatim de Web/DMS_NextJS_MGM/src/lib/decimal.ts.
// Mantido identico ao portal para garantir paridade aritmetica entre os sistemas.
import { Prisma } from "@prisma/client";

export type DecimalInput = Prisma.Decimal | string | number | bigint;

export class DecimalValidationError extends Error {
  readonly code = "INVALID_DECIMAL";
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "DecimalValidationError";
    this.field = field;
  }
}

function normalizeDecimalInput(value: DecimalInput, field: string) {
  if (Prisma.Decimal.isDecimal(value)) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DecimalValidationError(field, `${field} deve ser um decimal finito`);
    }

    return value.toString();
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new DecimalValidationError(field, `${field} é obrigatório`);
  }

  return trimmed;
}

export function toDecimal(value: DecimalInput | null | undefined, field = "valor") {
  if (value === null || value === undefined) {
    throw new DecimalValidationError(field, `${field} é obrigatório`);
  }

  try {
    const normalized = normalizeDecimalInput(value, field);
    return Prisma.Decimal.isDecimal(normalized)
      ? normalized
      : new Prisma.Decimal(normalized);
  } catch (error) {
    if (error instanceof DecimalValidationError) {
      throw error;
    }

    throw new DecimalValidationError(field, `${field} deve ser um decimal válido`);
  }
}

export function assertDecimalScale(
  value: DecimalInput | null | undefined,
  scale: number,
  field = "valor",
) {
  const decimal = toDecimal(value, field);

  if (decimal.decimalPlaces() > scale) {
    throw new DecimalValidationError(
      field,
      `${field} deve ter no máximo ${scale} casas decimais`,
    );
  }

  return decimal;
}

export function parseDecimal2(value: DecimalInput | null | undefined, field = "valor") {
  return assertDecimalScale(value, 2, field);
}

export function parsePositiveDecimal2(
  value: DecimalInput | null | undefined,
  field = "valor",
) {
  const decimal = parseDecimal2(value, field);

  if (!decimal.greaterThan(0)) {
    throw new DecimalValidationError(field, `${field} deve ser maior que zero`);
  }

  return decimal;
}

export function parseNonNegativeDecimal2(
  value: DecimalInput | null | undefined,
  field = "valor",
) {
  const decimal = parseDecimal2(value, field);

  if (decimal.lessThan(0)) {
    throw new DecimalValidationError(field, `${field} deve ser maior ou igual a zero`);
  }

  return decimal;
}

export function roundDecimal(
  value: DecimalInput | null | undefined,
  scale = 2,
  field = "valor",
) {
  return toDecimal(value, field).toDecimalPlaces(scale, Prisma.Decimal.ROUND_HALF_UP);
}

export function formatDecimal(
  value: DecimalInput | null | undefined,
  scale = 2,
  field = "valor",
) {
  return roundDecimal(value, scale, field).toFixed(scale);
}

export function decimalToJsonNumber(
  value: DecimalInput | null | undefined,
  scale = 2,
  field = "valor",
) {
  return Number(formatDecimal(value, scale, field));
}

export function serializeBigIntDecimal(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Prisma.Decimal.isDecimal(value)) {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeBigIntDecimal(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        serializeBigIntDecimal(item),
      ]),
    );
  }

  return value;
}
