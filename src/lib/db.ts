/**
 * PSYBOSS database client — Prisma + Turso libSQL.
 *
 * Uses the driver adapter pattern (previewFeatures: ["driverAdapters"]) to connect
 * Prisma to Turso's libSQL. The adapter handles the libSQL protocol + auth token.
 */

import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set')
  }
  const authToken = process.env.DATABASE_AUTH_TOKEN
  // PrismaLibSql takes a Config object (url + authToken), not a libsql Client.
  const adapter = new PrismaLibSql({ url, authToken })
  return new PrismaClient({ adapter })
}

export const db =
  globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
