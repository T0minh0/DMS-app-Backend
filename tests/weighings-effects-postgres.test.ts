import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { recordMobileWeighing } from '../src/lib/weighings/recordMobileWeighing';

const url = process.env.COLLECTION_TEST_DATABASE_URL;
const safe = (() => { try { const parsed = new URL(url ?? ''); return ['127.0.0.1','localhost'].includes(parsed.hostname) && parsed.pathname === '/dms_collection_delete_test'; } catch { return false; } })();

test('mobile records exact reversible bag and stock effects in the weighing transaction', { skip: !safe }, async () => {
  const db = new PrismaClient({ datasources: { db: { url } } });
  const coop = await db.cooperative.create({ data: { cooperativeName: 'Mobile deletion effects test' } });
  const material = await db.materials.create({ data: { materialName: 'Mobile effects test' } });
  const device = await db.devices.create({ data: { cooperativeId: coop.cooperativeId } });
  const worker = await db.workers.create({ data: { cooperative: coop.cooperativeId, workerName: 'Mobile test', userType: '1',
    cpf: Buffer.from(`mobile-test-${coop.cooperativeId}`), birthDate: new Date('2000-01-01'), enterDate: new Date('2020-01-01'),
    pis: Buffer.from('0'), rg: Buffer.from('0'), password: Buffer.from('unused'), email: 'mobile@example.test' } });
  try {
    const base = { cooperativeId: coop.cooperativeId, materialId: material.materialId, workerId: worker.workerId, deviceId: device.deviceId };
    await db.$transaction(tx => recordMobileWeighing(tx, { ...base, reportedWeightKg: '10.00', bagFilled: false, measuredAt: new Date('2026-11-10T12:00:00Z') }));
    const closing = await db.$transaction(tx => recordMobileWeighing(tx, { ...base, reportedWeightKg: '15.00', bagFilled: true, measuredAt: new Date('2026-11-11T12:00:00Z') }));
    const effects = await db.$queryRaw<Array<{ collected: string; current: string; before: { currentKg: string; isBegun: boolean }; after: { currentKg: string; isBegun: boolean }; source: string }>>`
      SELECT collected_delta_kg::text AS collected,current_delta_kg::text AS current,bag_before AS before,bag_after AS after,source
      FROM measurement_effect WHERE measurement_id=${closing.measurement.weightingId}`;
    assert.equal(effects.length, 1);
    assert.equal(effects[0].collected, '5.00');
    assert.equal(effects[0].current, '5.00');
    assert.deepEqual(effects[0].before, { currentKg: '10.00', isBegun: true });
    assert.deepEqual(effects[0].after, { currentKg: '0.00', isBegun: false });
    assert.equal(effects[0].source, 'mobile');
    const stock = await db.stock.findUniqueOrThrow({ where: { cooperative_material: { cooperative: coop.cooperativeId, material: material.materialId } } });
    assert.equal(stock.currentStockKg.toFixed(2), '15.00');
  } finally {
    await db.$executeRaw`DELETE FROM measurement_effect WHERE cooperative_id=${coop.cooperativeId}`;
    await db.measurments.deleteMany({ where: { wastepicker: worker.workerId } });
    await db.materialBagState.deleteMany({ where: { cooperativeId: coop.cooperativeId } });
    await db.stock.deleteMany({ where: { cooperative: coop.cooperativeId } });
    await db.workers.delete({ where: { workerId: worker.workerId } });
    await db.devices.delete({ where: { deviceId: device.deviceId } });
    await db.materials.delete({ where: { materialId: material.materialId } });
    await db.cooperative.delete({ where: { cooperativeId: coop.cooperativeId } });
    await db.$disconnect();
  }
});
