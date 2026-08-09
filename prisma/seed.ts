/**
 * Development seed.
 *
 * Creates the default tenant that stands in for authentication until it exists.
 * Everything downstream is already tenant-scoped, so this row is what makes the
 * app usable in Phase 1 without a login screen — and what makes adding auth
 * later a matter of resolving a real organization instead of re-parenting data.
 *
 * Idempotent: safe to run repeatedly against an existing database.
 */
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { hashPassword } from '../src/modules/auth/password';

const prisma = new PrismaClient();

/** Stable ids so fixtures, tests, and manual QA can rely on them. */
export const DEFAULT_ORGANIZATION_ID = 'org_leadradar_default';
export const DEFAULT_PROJECT_ID = 'proj_leadradar_default';
export const DEFAULT_USER_ID = 'user_leadradar_dev';

/** Mirrors the .env.example defaults, expressed in micros. */
const DAILY_BUDGET_MICROS = 5 * 1_000_000;
const MONTHLY_BUDGET_MICROS = 50 * 1_000_000;

async function main(): Promise<void> {
  const organization = await prisma.organization.upsert({
    where: { id: DEFAULT_ORGANIZATION_ID },
    update: {},
    create: {
      id: DEFAULT_ORGANIZATION_ID,
      name: 'LeadRadar Development',
      slug: 'leadradar-dev',
      plan: 'free',
    },
  });

  /**
   * Development password.
   *
   * Taken from SEED_PASSWORD when set, otherwise generated randomly and printed
   * once. Deliberately NOT a fixed default like "password123": a known seeded
   * credential is the kind of thing that survives into a staging deployment and
   * becomes a real breach.
   */
  const seedPassword = process.env.SEED_PASSWORD ?? `dev-${randomBytes(9).toString('base64url')}`;
  const generated = process.env.SEED_PASSWORD === undefined;

  const user = await prisma.user.upsert({
    where: { id: DEFAULT_USER_ID },
    update: { passwordHash: await hashPassword(seedPassword) },
    create: {
      id: DEFAULT_USER_ID,
      email: 'dev@leadradar.local',
      name: 'Development User',
      passwordHash: await hashPassword(seedPassword),
    },
  });

  await prisma.membership.upsert({
    where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
    update: { role: 'OWNER' },
    create: { organizationId: organization.id, userId: user.id, role: 'OWNER' },
  });

  await prisma.project.upsert({
    where: { id: DEFAULT_PROJECT_ID },
    update: {},
    create: {
      id: DEFAULT_PROJECT_ID,
      organizationId: organization.id,
      name: 'Default Project',
      description: 'Default workspace for development searches.',
    },
  });

  // Budgets exist from the first run, so no development search can quietly spend
  // an unbounded amount if someone flips MOCK_EXTERNAL_APIS to false.
  for (const [scope, limitMicros] of [
    ['DAILY', DAILY_BUDGET_MICROS],
    ['MONTHLY', MONTHLY_BUDGET_MICROS],
  ] as const) {
    await prisma.budget.upsert({
      where: { organizationId_scope: { organizationId: organization.id, scope } },
      update: { limitMicros },
      create: { organizationId: organization.id, scope, limitMicros },
    });
  }

  console.log(
    `Seeded organization ${organization.slug} (${organization.id}) ` +
      `with owner ${user.email} and default project.`,
  );
  console.log('');
  console.log('  Sign in at /login');
  console.log(`    email:    ${user.email}`);
  console.log(`    password: ${seedPassword}`);
  if (generated) {
    console.log('');
    console.log('  This password was generated and is shown only now.');
    console.log('  Set SEED_PASSWORD to choose your own before re-seeding.');
  }
  console.log('');
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
