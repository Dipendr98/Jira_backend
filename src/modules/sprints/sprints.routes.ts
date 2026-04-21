import { FastifyInstance } from 'fastify'
import { prisma } from '../../config/prisma'
import { z } from 'zod'
import { logActivity } from '../../utils/helpers'
import { requireProjectMember } from '../../utils/rbac'

const CreateSprintSchema = z.object({
  name: z.string().min(1),
  goal: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional()
})

export async function sprintRoutes(app: FastifyInstance) {

  // GET /api/projects/:id/sprints - List all sprints
  app.get('/projects/:id/sprints', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Sprints'],
      summary: 'List all sprints for a project',
      params: { type: 'object', properties: { id: { type: 'string' } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const sprints = await prisma.sprint.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { issues: true } },
        issues: {
          select: { storyPoints: true, status: { select: { name: true } } }
        }
      }
    })

    // Calculate velocity (completed story points) per sprint
    // Calculate velocity (completed story points) per sprint
    const sprintsWithStats = sprints.map((sprint: any) => {
      const totalPoints = sprint.issues.reduce((sum: number, i: any) => sum + (i.storyPoints || 0), 0)
      const completedPoints = sprint.issues
        .filter((i: any) => i.status.name === 'Done')
        .reduce((sum: number, i: any) => sum + (i.storyPoints || 0), 0)

      return {
        ...sprint,
        issues: undefined, // don't return full issues list here
        stats: {
          totalIssues: sprint._count.issues,
          totalPoints,
          completedPoints,
          velocity: sprint.status === 'COMPLETED' ? completedPoints : null
        }
      }
    })

    return reply.send(sprintsWithStats)
  })

  // POST /api/projects/:id/sprints - Create sprint
  app.post('/projects/:id/sprints', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Sprints'],
      summary: 'Create a new sprint',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          goal: { type: 'string' },
          startDate: { type: 'string', format: 'date-time' },
          endDate: { type: 'string', format: 'date-time' }
        }
      }
    }
  }, async (request, reply) => {
    const { id: projectId } = request.params as { id: string }
    const body = CreateSprintSchema.parse(request.body)

    const sprint = await prisma.sprint.create({
      data: {
        projectId,
        name: body.name,
        goal: body.goal,
        startDate: body.startDate ? new Date(body.startDate) : undefined,
        endDate: body.endDate ? new Date(body.endDate) : undefined
      }
    })

    return reply.status(201).send(sprint)
  })

  // POST /api/sprints/:id/start - Start a sprint
  app.post('/sprints/:id/start', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Sprints'],
      summary: 'Start a sprint',
      params: { type: 'object', properties: { id: { type: 'string' } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const sprint = await prisma.sprint.findUnique({ where: { id } })
    if (!sprint) return reply.status(404).send({ error: 'Sprint not found' })
    try { await requireProjectMember(sprint.projectId, request.user.id, 'ADMIN') } catch {
      return reply.status(403).send({ error: 'Forbidden: admin role required to start sprints' })
    }
    if (sprint.status !== 'PLANNED') {
      return reply.status(400).send({ error: 'Only PLANNED sprints can be started' })
    }

    // Check no other sprint is active in this project
    const activeSprint = await prisma.sprint.findFirst({
      where: { projectId: sprint.projectId, status: 'ACTIVE' }
    })
    if (activeSprint) {
      return reply.status(400).send({
        error: `Sprint "${activeSprint.name}" is already active. Complete it first.`
      })
    }

    const updated = await prisma.sprint.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        startDate: new Date()
      }
    })

    await logActivity({
      projectId: sprint.projectId,
      userId: request.user.id,
      eventType: 'sprint_started',
      newValue: sprint.name
    })

    app.io.to(`project:${sprint.projectId}`).emit('sprint_updated', updated)

    return reply.send(updated)
  })

  // POST /api/sprints/:id/complete - Complete a sprint
  // This handles the carry-over scenario from the assignment
  app.post('/sprints/:id/complete', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Sprints'],
      summary: 'Complete a sprint with carry-over options',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          // IDs of incomplete issues to carry over to next sprint
          carryOverIssueIds: { type: 'array', items: { type: 'string' } },
          nextSprintId: { type: 'string', description: 'Sprint to move carry-over issues to' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { carryOverIssueIds = [], nextSprintId } = request.body as {
      carryOverIssueIds?: string[]
      nextSprintId?: string
    }

    const sprint = await prisma.sprint.findUnique({
      where: { id },
      include: {
        issues: {
          include: { status: true }
        }
      }
    })
    if (!sprint) return reply.status(404).send({ error: 'Sprint not found' })
    try { await requireProjectMember(sprint.projectId, request.user.id, 'ADMIN') } catch {
      return reply.status(403).send({ error: 'Forbidden: admin role required to complete sprints' })
    }
    if (sprint.status !== 'ACTIVE') {
      return reply.status(400).send({ error: 'Only ACTIVE sprints can be completed' })
    }

    // Find incomplete issues (not "Done")
    const incompleteIssues = sprint.issues.filter((i: any) => i.status.name !== 'Done')

    // Calculate velocity
    const completedPoints = sprint.issues
      .filter((i: any) => i.status.name === 'Done')
      .reduce((sum: number, i: any) => sum + (i.storyPoints || 0), 0)

    await prisma.$transaction(async (tx: any) => {
      // Mark sprint as completed
      await tx.sprint.update({
        where: { id },
        data: { status: 'COMPLETED', endDate: new Date() }
      })

      // Move selected issues to next sprint (or backlog if no nextSprintId)
      if (carryOverIssueIds.length > 0) {
        await tx.issue.updateMany({
          where: { id: { in: carryOverIssueIds }, sprintId: id }, // only issues belonging to this sprint
          data: { sprintId: nextSprintId || null } // null = backlog
        })

        // Log carry-over in activity
        await tx.activityLog.createMany({
          data: carryOverIssueIds.map(issueId => ({
            projectId: sprint.projectId,
            issueId,
            userId: request.user.id,
            eventType: 'sprint_carry_over',
            oldValue: sprint.name,
            newValue: nextSprintId ? `Sprint ${nextSprintId}` : 'Backlog'
          }))
        })
      }

      // Move remaining incomplete issues to backlog
      const notCarriedOver = incompleteIssues
        .filter((i: any) => !carryOverIssueIds.includes(i.id))
        .map((i: any) => i.id)

      if (notCarriedOver.length > 0) {
        await tx.issue.updateMany({
          where: { id: { in: notCarriedOver } },
          data: { sprintId: null }
        })
      }
    })

    app.io.to(`project:${sprint.projectId}`).emit('sprint_updated', {
      sprintId: id,
      status: 'COMPLETED'
    })

    return reply.send({
      message: 'Sprint completed successfully',
      summary: {
        totalIssues: sprint.issues.length,
        completedIssues: sprint.issues.length - incompleteIssues.length,
        incompleteIssues: incompleteIssues.length,
        velocity: completedPoints,
        carriedOver: carryOverIssueIds.length,
        movedToBacklog: incompleteIssues.length - carryOverIssueIds.length
      }
    })
  })

  // GET /api/sprints/:id/incomplete - See what's not done before completing
  app.get('/sprints/:id/incomplete', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Sprints'],
      summary: 'Get incomplete issues in a sprint',
      params: { type: 'object', properties: { id: { type: 'string' } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const sprint = await prisma.sprint.findUnique({
      where: { id },
      include: {
        issues: {
          include: {
            status: true,
            assignee: { select: { id: true, displayName: true } }
          }
        }
      }
    })
    if (!sprint) return reply.status(404).send({ error: 'Sprint not found' })

    const incomplete = sprint.issues.filter((i: any) => i.status.name !== 'Done')
    const totalPoints = incomplete.reduce((sum: number, i: any) => sum + (i.storyPoints || 0), 0)

    return reply.send({ incomplete, totalIncompletePoints: totalPoints })
  })

  // PATCH /api/issues/:id/sprint - Move issue between backlog and sprint
  app.patch('/issues/:issueId/sprint', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Sprints'],
      summary: 'Move issue to sprint or backlog',
      params: { type: 'object', properties: { issueId: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          sprintId: { type: 'string', nullable: true, description: 'null to move to backlog' }
        }
      }
    }
  }, async (request, reply) => {
    const { issueId } = request.params as { issueId: string }
    const { sprintId } = request.body as { sprintId: string | null }

    const updated = await prisma.issue.update({
      where: { id: issueId },
      data: { sprintId },
      include: { sprint: true, status: true }
    })

    return reply.send(updated)
  })
}
