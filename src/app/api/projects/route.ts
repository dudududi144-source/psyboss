/**
 * PSYBOSS project persistence API.
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
  // Dynamic import INSIDE the function - never runs during static build
  const { db } = await import('@/lib/db')
  return db
}

// GET /api/projects — list all projects
export async function GET() {
  if (IS_STATIC) {
    return NextResponse.json({ projects: [] })
  }
  try {
    const db = await getDb()
    const projects = await db.project.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        bpm: true,
        patternEnabled: true,
        updatedAt: true,
        _count: { select: { steps: true, samples: true } },
      },
    })
    return NextResponse.json({ projects: jsonSafe(projects) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 })
  }
}

// POST /api/projects — create or update a project
export async function POST(req: NextRequest) {
  if (IS_STATIC) {
    return NextResponse.json({ error: 'Project persistence is disabled in demo mode' }, { status: 503 })
  }
  try {
    const db = await getDb()
    const body = await req.json()
    const { id, name, bpm, seed, patternEnabled, steps } = body

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }

    const project = await db.project.upsert({
      where: { id: id ?? 'new' },
      create: {
        id: id,
        name,
        bpm: bpm ?? 144,
        seed: BigInt(seed ?? 0x9e3779b9),
        patternEnabled: patternEnabled ?? false,
      },
      update: {
        name,
        bpm: bpm ?? 144,
        patternEnabled: patternEnabled ?? false,
      },
    })

    if (steps && Array.isArray(steps)) {
      await db.patternStep.deleteMany({ where: { projectId: project.id } })
      for (const s of steps) {
        await db.patternStep.create({
          data: {
            projectId: project.id,
            track: s.track,
            step: s.step,
            active: s.active ?? false,
            scene: s.scene ?? 0,
            condition: typeof s.condition === 'string' ? s.condition : JSON.stringify(s.condition),
            locks: typeof s.locks === 'string' ? s.locks : JSON.stringify(s.locks ?? []),
          },
        })
      }
    }

    return NextResponse.json({ id: project.id, name: project.name })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 })
  }
}
