/**
 * PSYBOSS project persistence API.
 * POST /api/projects — create or update a project (upsert by id).
 * GET /api/projects — list all projects (most recent first).
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/projects — list all projects
export async function GET() {
  try {
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
    return NextResponse.json({ projects })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 })
  }
}

// POST /api/projects — create or update a project
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, name, bpm, seed, patternEnabled, steps, samples } = body

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }

    // Upsert the project
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

    // If steps are provided, replace all existing steps for this project
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
