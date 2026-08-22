/**
 * PSYBOSS single project API.
 * GET /api/projects/[id] — load a project with all steps + samples.
 * DELETE /api/projects/[id] — delete a project.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// ROAST-6 #2 fix: BigInt JSON serialization — JSON.stringify throws on BigInt.
function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

function jsonSafe(data: unknown): unknown {
  return JSON.parse(JSON.stringify(data, bigIntReplacer))
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
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
  try {
    const { id } = await params
    await db.project.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 })
  }
}
