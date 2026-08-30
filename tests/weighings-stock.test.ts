import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { formatDecimal } from "../src/lib/decimal";
import {
  MobileWeighingDomainError,
  recordMobileWeighing,
} from "../src/lib/weighings/recordMobileWeighing";

type FakeStockRow = {
  stockId: bigint;
  cooperative: bigint;
  material: bigint;
  totalCollectedKg: Prisma.Decimal;
  totalSoldKg: Prisma.Decimal;
  currentStockKg: Prisma.Decimal;
};

type FakeBagState = {
  bagStateId: bigint;
  cooperativeId: bigint;
  materialId: bigint;
  isBegun: boolean;
  currentKg: Prisma.Decimal;
  lastUpdated: Date;
};

function toBigInt(value: unknown) {
  return BigInt(String(value));
}

function toDecimal(value: unknown) {
  if (Prisma.Decimal.isDecimal(value)) {
    return value;
  }

  return new Prisma.Decimal(String(value));
}

function keyFor(cooperativeId: bigint, materialId: bigint) {
  return `${cooperativeId.toString()}:${materialId.toString()}`;
}

function cloneStock(row: FakeStockRow) {
  return {
    stockId: row.stockId,
    totalCollectedKg: row.totalCollectedKg,
    totalSoldKg: row.totalSoldKg,
    currentStockKg: row.currentStockKg,
  };
}

function createFakeTx() {
  let nextBagStateId = BigInt(1);
  let nextStockId = BigInt(1);
  let nextMeasurementId = BigInt(1);
  const calls: string[] = [];
  const materials = new Set<bigint>([BigInt(7), BigInt(8)]);
  const workers = new Map<bigint, { workerId: bigint; cooperative: bigint }>([
    [BigInt(20), { workerId: BigInt(20), cooperative: BigInt(100) }],
    [BigInt(21), { workerId: BigInt(21), cooperative: BigInt(200) }],
  ]);
  const devices = new Map<bigint, { deviceId: bigint; cooperativeId: bigint }>([
    [BigInt(3), { deviceId: BigInt(3), cooperativeId: BigInt(100) }],
    [BigInt(4), { deviceId: BigInt(4), cooperativeId: BigInt(200) }],
  ]);
  const bagStates = new Map<string, FakeBagState>([
    [
      keyFor(BigInt(100), BigInt(7)),
      {
        bagStateId: nextBagStateId,
        cooperativeId: BigInt(100),
        materialId: BigInt(7),
        isBegun: true,
        currentKg: new Prisma.Decimal("4.25"),
        lastUpdated: new Date("2026-05-13T09:00:00Z"),
      },
    ],
  ]);
  nextBagStateId += BigInt(1);

  const stock = new Map<string, FakeStockRow>([
    [
      keyFor(BigInt(100), BigInt(7)),
      {
        stockId: nextStockId,
        cooperative: BigInt(100),
        material: BigInt(7),
        totalCollectedKg: new Prisma.Decimal("10.00"),
        totalSoldKg: new Prisma.Decimal("0.00"),
        currentStockKg: new Prisma.Decimal("10.00"),
      },
    ],
  ]);
  nextStockId += BigInt(1);

  const measurements: Array<{
    weightingId: bigint;
    weightKg: Prisma.Decimal;
    timeStamp: Date;
    wastepicker: bigint;
    material: bigint;
    device: bigint;
    bagFilled: boolean;
  }> = [];

  async function $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = strings.join("?");
    calls.push(sql);

    if (/INSERT INTO "material_bag_state"/.test(sql)) {
      assert.match(sql, /ON CONFLICT \("cooperative_id", "material_id"\) DO NOTHING/);
      const cooperativeId = toBigInt(values[0]);
      const materialId = toBigInt(values[1]);
      const bagKey = keyFor(cooperativeId, materialId);

      if (!bagStates.has(bagKey)) {
        bagStates.set(bagKey, {
          bagStateId: nextBagStateId,
          cooperativeId,
          materialId,
          isBegun: false,
          currentKg: new Prisma.Decimal(0),
          lastUpdated: new Date("1970-01-01T00:00:00Z"),
        });
        nextBagStateId += BigInt(1);
      }

      return 1;
    }

    throw new Error(`Unexpected fake execute SQL: ${sql}`);
  }

  async function $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = strings.join("?");
    calls.push(sql);

    if (/FROM "material_bag_state"/.test(sql)) {
      assert.match(sql, /FOR UPDATE/);
      const cooperativeId = toBigInt(values[0]);
      const materialId = toBigInt(values[1]);
      const bag = bagStates.get(keyFor(cooperativeId, materialId));
      return bag
        ? [{
          bagStateId: bag.bagStateId,
          isBegun: bag.isBegun,
          currentKg: bag.currentKg,
          lastUpdated: bag.lastUpdated,
        }]
        : [];
    }

    if (/INSERT INTO "Stock"/.test(sql)) {
      assert.match(sql, /ON CONFLICT \("Cooperative", "Material"\)/);
      const cooperativeId = toBigInt(values[0]);
      const materialId = toBigInt(values[1]);
      const amount = toDecimal(values[2]);
      const stockKey = keyFor(cooperativeId, materialId);
      const existing = stock.get(stockKey);

      if (existing) {
        existing.totalCollectedKg = existing.totalCollectedKg.plus(amount);
        existing.currentStockKg = existing.currentStockKg.plus(amount);
        return [cloneStock(existing)];
      }

      const created = {
        stockId: nextStockId,
        cooperative: cooperativeId,
        material: materialId,
        totalCollectedKg: amount,
        totalSoldKg: new Prisma.Decimal(0),
        currentStockKg: amount,
      };
      nextStockId += BigInt(1);
      stock.set(stockKey, created);
      return [cloneStock(created)];
    }

    throw new Error(`Unexpected fake query SQL: ${sql}`);
  }

  const tx = {
    $executeRaw,
    $queryRaw,
    materials: {
      findUnique: async ({ where }: { where: { materialId: bigint } }) =>
        materials.has(where.materialId) ? { materialId: where.materialId } : null,
    },
    workers: {
      findUnique: async ({ where }: { where: { workerId: bigint } }) =>
        workers.get(where.workerId) ?? null,
    },
    devices: {
      findUnique: async ({ where }: { where: { deviceId: bigint } }) =>
        devices.get(where.deviceId) ?? null,
    },
    measurments: {
      create: async ({
        data,
      }: {
        data: {
          weightKg: string;
          timeStamp: Date;
          wastepicker: bigint;
          material: bigint;
          device: bigint;
          bagFilled: boolean;
        };
      }) => {
        const created = {
          weightingId: nextMeasurementId,
          weightKg: new Prisma.Decimal(data.weightKg),
          timeStamp: data.timeStamp,
          wastepicker: data.wastepicker,
          material: data.material,
          device: data.device,
          bagFilled: data.bagFilled,
        };
        nextMeasurementId += BigInt(1);
        measurements.push(created);
        return created;
      },
    },
    materialBagState: {
      update: async ({
        where,
        data,
      }: {
        where: {
          cooperativeId_materialId: {
            cooperativeId: bigint;
            materialId: bigint;
          };
        };
        data: {
          isBegun: boolean;
          currentKg: string;
          lastUpdated: Date;
        };
      }) => {
        const ids = where.cooperativeId_materialId;
        const bag = bagStates.get(keyFor(ids.cooperativeId, ids.materialId));
        assert.ok(bag, "bag state must exist before update");
        bag.isBegun = data.isBegun;
        bag.currentKg = new Prisma.Decimal(data.currentKg);
        bag.lastUpdated = data.lastUpdated;
        return bag;
      },
    },
  } as unknown as Prisma.TransactionClient;

  return {
    tx,
    calls,
    measurements,
    getBag: (cooperativeId: bigint, materialId: bigint) =>
      bagStates.get(keyFor(cooperativeId, materialId)),
    getStock: (cooperativeId: bigint, materialId: bigint) =>
      stock.get(keyFor(cooperativeId, materialId)),
  };
}

test("recordMobileWeighing stores deltas, updates bag state, and increments stock", async () => {
  const store = createFakeTx();

  const first = await recordMobileWeighing(store.tx, {
    cooperativeId: BigInt(100),
    workerId: BigInt(20),
    materialId: BigInt(7),
    deviceId: BigInt(3),
    reportedWeightKg: new Prisma.Decimal("5.75"),
    bagFilled: false,
    measuredAt: new Date("2026-05-13T09:10:00Z"),
  });

  assert.equal(formatDecimal(first.collectedDeltaKg), "1.50");
  assert.equal(formatDecimal(first.measurement.weightKg), "1.50");
  assert.equal(first.measurement.bagFilled, false);
  assert.equal(store.getBag(BigInt(100), BigInt(7))?.isBegun, true);
  assert.equal(formatDecimal(store.getBag(BigInt(100), BigInt(7))!.currentKg), "5.75");
  assert.equal(formatDecimal(store.getStock(BigInt(100), BigInt(7))!.currentStockKg), "11.50");

  const second = await recordMobileWeighing(store.tx, {
    cooperativeId: BigInt(100),
    workerId: BigInt(20),
    materialId: BigInt(7),
    deviceId: BigInt(3),
    reportedWeightKg: new Prisma.Decimal("8.00"),
    bagFilled: true,
    measuredAt: new Date("2026-05-13T09:20:00Z"),
  });

  assert.equal(formatDecimal(second.collectedDeltaKg), "2.25");
  assert.equal(formatDecimal(second.measurement.weightKg), "2.25");
  assert.equal(second.measurement.bagFilled, true);
  assert.equal(store.getBag(BigInt(100), BigInt(7))?.isBegun, false);
  assert.equal(formatDecimal(store.getBag(BigInt(100), BigInt(7))!.currentKg), "0.00");
  assert.equal(formatDecimal(store.getStock(BigInt(100), BigInt(7))!.currentStockKg), "13.75");
  assert.ok(store.calls.some((sql) => /FOR UPDATE/.test(sql)));
});

test("recordMobileWeighing creates stock for the first material weighing", async () => {
  const store = createFakeTx();

  const result = await recordMobileWeighing(store.tx, {
    cooperativeId: BigInt(100),
    workerId: BigInt(20),
    materialId: BigInt(8),
    deviceId: BigInt(3),
    reportedWeightKg: new Prisma.Decimal("25.00"),
    bagFilled: true,
    measuredAt: new Date("2026-05-13T10:00:00Z"),
  });

  assert.equal(formatDecimal(result.collectedDeltaKg), "25.00");
  assert.equal(formatDecimal(result.stockSnapshot!.currentStockKg), "25.00");
  assert.equal(formatDecimal(store.getStock(BigInt(100), BigInt(8))!.totalCollectedKg), "25.00");
  assert.equal(formatDecimal(store.getBag(BigInt(100), BigInt(8))!.currentKg), "0.00");
});

test("recordMobileWeighing rejects regressive readings without mutating state", async () => {
  const store = createFakeTx();

  await assert.rejects(
    () =>
      recordMobileWeighing(store.tx, {
        cooperativeId: BigInt(100),
        workerId: BigInt(20),
        materialId: BigInt(7),
        deviceId: BigInt(3),
        reportedWeightKg: new Prisma.Decimal("4.00"),
        bagFilled: false,
        measuredAt: new Date("2026-05-13T09:10:00Z"),
      }),
    (error) =>
      error instanceof MobileWeighingDomainError &&
      error.code === "INVALID_BAG_READING",
  );

  assert.equal(store.measurements.length, 0);
  assert.equal(formatDecimal(store.getBag(BigInt(100), BigInt(7))!.currentKg), "4.25");
  assert.equal(formatDecimal(store.getStock(BigInt(100), BigInt(7))!.currentStockKg), "10.00");
});
