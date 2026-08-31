/**
 * PSYBOSS single project API.
 * Static export safe: NO database import at module level.
 */

import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const IS_STATIC = process.env.NEXT_PUBLIC_STATIC === 'true'

function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

function jsonSafe(data: unknown): unknown {
  return JSON.parse(JSON.stringify(data, bigIntReplacer))
}

async function getDb() {
  const { db } = await import('@/lib/db')
  return db
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (IS_STATIC) {
    return NextResponse.json({ error: 'Project persistence is disabled in demo mode' }, { status: 503 })
  }
  try {
    const db = await getDb()
    const { id } = await params
    const project = await db.project.findUnique({
      where: { id },
      include: {
        steps: { orderBy: [{ track: 'asc' }, { step: 'asc' }] },
        samples: true,
      },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    return NextResponse.json({ project: jsonSafe(project) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (IS_STATIC) {
    return NextResponse.json({ error: 'Project persistence is disabled in demo mode' }, { status: 503 })
  }
  try {
    const db = await getDb()
    const { id } = await params
    await db.project.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 })
  }
}
