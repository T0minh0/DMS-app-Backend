import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const toBytes = (value: string) => Buffer.from(value, 'utf8');

async function main() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Worker_contributions", "Stock", "Measurments", "Sales", "Devices", "Workers", "Buyers", "Materials", "Groups", "Cooperative" RESTART IDENTITY CASCADE;',
  );

  const cooperativeCentral = await prisma.cooperative.create({
    data: {
      cooperativeName: 'Cooperativa Central Horizonte',
    },
  });

  const cooperativeLeste = await prisma.cooperative.create({
    data: {
      cooperativeName: 'Cooperativa Vale do Leste',
    },
  });

  const groupPaper = await prisma.groups.create({
    data: {
      groupName: 'Papéis',
    },
  });

  const groupPlastic = await prisma.groups.create({
    data: {
      groupName: 'Plásticos',
    },
  });

  const materialCardboard = await prisma.materials.create({
    data: {
      materialName: 'Papelão Ondulado',
      materialGroup: groupPaper.groupId,
    },
  });

  const materialWhitePaper = await prisma.materials.create({
    data: {
      materialName: 'Papel Branco',
      materialGroup: groupPaper.groupId,
    },
  });

  const materialPet = await prisma.materials.create({
    data: {
      materialName: 'Plástico PET Cristal',
      materialGroup: groupPlastic.groupId,
    },
  });

  const device1 = await prisma.devices.create({
    data: {
      cooperativeId: cooperativeCentral.cooperativeId,
    },
  });

  const device2 = await prisma.devices.create({
    data: {
      cooperativeId: cooperativeCentral.cooperativeId,
    },
  });

  const buyerCity = await prisma.buyers.create({
    data: {
      buyerName: 'Recicla Cidades LTDA',
    },
  });

  const buyerEco = await prisma.buyers.create({
    data: {
      buyerName: 'Eco Verde Comercial',
    },
  });

  const managerPassword = await bcrypt.hash('manager123', 10);
  const workerPassword = await bcrypt.hash('worker123', 10);

  const manager = await prisma.workers.create({
    data: {
      workerName: 'Rosa Almeida',
      cooperative: cooperativeCentral.cooperativeId,
      cpf: toBytes('12345678901'),
      userType: '0',
      birthDate: new Date('1985-04-12'),
      enterDate: new Date('2020-02-01'),
      exitDate: null,
      pis: toBytes('12345678900'),
      rg: toBytes('123456789'),
      gender: 'Feminino',
      password: toBytes(managerPassword),
      email: 'rosa.almeida@coophorizonte.org',
      lastUpdate: new Date(),
    },
  });

  const workerJoao = await prisma.workers.create({
    data: {
      workerName: 'João Carvalho',
      cooperative: cooperativeCentral.cooperativeId,
      cpf: toBytes('98765432100'),
      userType: '1',
      birthDate: new Date('1991-07-19'),
      enterDate: new Date('2021-05-10'),
      exitDate: null,
      pis: toBytes('98765432100'),
      rg: toBytes('987654321'),
      gender: 'Masculino',
      password: toBytes(workerPassword),
      email: 'joao.carvalho@coophorizonte.org',
      lastUpdate: new Date(),
    },
  });

  const workerMaria = await prisma.workers.create({
    data: {
      workerName: 'Maria Oliveira',
      cooperative: cooperativeCentral.cooperativeId,
      cpf: toBytes('56473829100'),
      userType: '1',
      birthDate: new Date('1994-03-03'),
      enterDate: new Date('2022-01-15'),
      exitDate: null,
      pis: toBytes('56473829100'),
      rg: toBytes('564738291'),
      gender: 'Feminino',
      password: toBytes(workerPassword),
      email: 'maria.oliveira@coophorizonte.org',
      lastUpdate: new Date(),
    },
  });

  const workerPedro = await prisma.workers.create({
    data: {
      workerName: 'Pedro Santos',
      cooperative: cooperativeLeste.cooperativeId,
      cpf: toBytes('43210987654'),
      userType: '1',
      birthDate: new Date('1988-11-02'),
      enterDate: new Date('2019-09-01'),
      exitDate: null,
      pis: toBytes('43210987650'),
      rg: toBytes('432109876'),
      gender: 'Masculino',
      password: toBytes(workerPassword),
      email: 'pedro.santos@coopvaleleste.org',
      lastUpdate: new Date(),
    },
  });

  await prisma.measurments.createMany({
    data: [
      {
        weightKg: '135.50',
        timeStamp: new Date('2024-02-05'),
        wastepicker: workerJoao.workerId,
        material: materialCardboard.materialId,
        device: device1.deviceId,
        bagFilled: true,
      },
      {
        weightKg: '92.40',
        timeStamp: new Date('2024-02-06'),
        wastepicker: workerMaria.workerId,
        material: materialPet.materialId,
        device: device2.deviceId,
        bagFilled: true,
      },
      {
        weightKg: '48.10',
        timeStamp: new Date('2024-02-07'),
        wastepicker: workerJoao.workerId,
        material: materialWhitePaper.materialId,
        device: device1.deviceId,
        bagFilled: true,
      },
      {
        weightKg: '76.35',
        timeStamp: new Date('2024-02-08'),
        wastepicker: workerMaria.workerId,
        material: materialPet.materialId,
        device: device2.deviceId,
        bagFilled: false,
      },
      {
        weightKg: '88.60',
        timeStamp: new Date('2024-02-10'),
        wastepicker: workerPedro.workerId,
        material: materialCardboard.materialId,
        device: device2.deviceId,
        bagFilled: true,
      },
    ],
  });

  await prisma.sales.createMany({
    data: [
      {
        date: new Date('2024-02-12'),
        material: materialCardboard.materialId,
        weight: '120.00',
        priceKg: '1.35',
        buyer: buyerCity.buyerId,
        responsible: manager.workerId,
      },
      {
        date: new Date('2024-02-18'),
        material: materialPet.materialId,
        weight: '85.00',
        priceKg: '2.40',
        buyer: buyerEco.buyerId,
        responsible: manager.workerId,
      },
    ],
  });

  await prisma.stock.createMany({
    data: [
      {
        cooperative: cooperativeCentral.cooperativeId,
        material: materialCardboard.materialId,
        totalCollectedKg: '350.00',
        totalSoldKg: '180.00',
        currentStockKg: '170.00',
      },
      {
        cooperative: cooperativeCentral.cooperativeId,
        material: materialPet.materialId,
        totalCollectedKg: '260.00',
        totalSoldKg: '95.00',
        currentStockKg: '165.00',
      },
    ],
  });

  await prisma.$executeRawUnsafe(`
    INSERT INTO "Worker_contributions"
      ("Wastepicker", "Material", cooperative, "Period", "Weight_KG", "Last_updated")
    VALUES
      (${workerJoao.workerId}, ${materialCardboard.materialId}, ${cooperativeCentral.cooperativeId}, daterange('2024-01-01', '2024-01-31', '[]'), 210.50, '2024-02-11'),
      (${workerMaria.workerId}, ${materialPet.materialId}, ${cooperativeCentral.cooperativeId}, daterange('2024-01-01', '2024-01-31', '[]'), 185.90, '2024-02-11'),
      (${workerPedro.workerId}, ${materialCardboard.materialId}, ${cooperativeLeste.cooperativeId}, daterange('2024-01-01', '2024-01-31', '[]'), 140.25, '2024-02-11');
  `);

  console.log('✅ Database seeded successfully.');
  console.log('Test accounts:');
  console.log('- Manager CPF: 12345678901 / Password: manager123');
  console.log('- Worker CPF: 98765432100 / Password: worker123');
}

main()
  .catch((error) => {
    console.error('❌ Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

