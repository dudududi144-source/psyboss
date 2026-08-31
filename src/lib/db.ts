/**
 * PSYBOSS database client — Prisma + Turso libSQL.
 *
 * Uses the driver adapter pattern (previewFeatures: ["driverAdapters"]) to connect
 * Prisma to Turso's libSQL. The adapter handles the libSQL protocol + auth token.
 *
 * Static export safe: the client is created lazily, so importing this module
 * during a static build (no DATABASE_URL) does not throw.
 */

import type { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

let _db: PrismaClient | null = null

function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set')
  }
  const authToken = process.env.DATABASE_AUTH_TOKEN
  // Dynamic imports so the bundler does not pull these into the static build.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient: PC } = require('@prisma/client')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaLibSql } = require('@prisma/adapter-libsql')
  const adapter = new PrismaLibSql({ url, authToken })
  return new PC({ adapter })
}

/**
 * Lazy getter — safe to import at build time.
 * Throws only when actually accessed without a database configured.
 */
export function getDb(): PrismaClient {
  if (_db) return _db
  if (globalForPrisma.prisma) {
    _db = globalForPrisma.prisma
    return _db
  }
  _db = createPrismaClient()
  if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = _db
  return _db
}

// Backwards-compatible proxy: `db.project.findMany(...)` still works,
// but the client is only created on first property access.
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getDb()
    const value = (client as unknown as Record<string | symbol, unknown>)[prop]
    return typeof value === 'function' ? value.bind(client) : value
  },
})
