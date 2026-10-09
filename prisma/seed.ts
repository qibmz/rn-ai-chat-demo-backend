import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('拒绝在 production 环境执行 prisma seed');
  }

  const email = normalizeEmail(process.env.SEED_EMAIL ?? 'admin@example.com');
  const password = process.env.SEED_PASSWORD ?? 'password123';
  const passwordHash = await bcrypt.hash(password, 12);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Never overwrite an existing account password
    const user = await prisma.user.update({
      where: { email },
      data: { emailVerifiedAt: existing.emailVerifiedAt ?? new Date() },
    });
    console.log(
      `Seed skipped password update for ${user.email} (id=${user.id})`,
    );
    return;
  }

  const user = await prisma.user.create({
    data: { email, passwordHash, emailVerifiedAt: new Date() },
  });

  console.log(`Seeded user ${user.email} (id=${user.id})`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
