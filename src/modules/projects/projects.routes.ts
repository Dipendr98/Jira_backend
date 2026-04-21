import { FastifyInstance } from 'fastify'
import { prisma } from '../../config/prisma'
import { z } from 'zod'

const CreateProjectSchema = z.object({
  name: z.string().min(2),
  key: z.string().min(2).max(10).toUpperCase(), // e.g. "PROJ"
  description: z.string().optional()
})

export async function projectRoutes(app: FastifyInstance) {

  // POST /api/projects - Create a new project
  app.post('/projects', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Projects'],
      summary: 'Create a new project',
      body: {
        type: 'object',
        required: ['name', 'key'],
        properties: {
          name: { type: 'string' },
          key: { type: 'string', description: 'Short project key e.g. PROJ' },
          description: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const body = CreateProjectSchema.parse(request.body)

    // Check key is unique
    const exists = await prisma.project.findUnique({ where: { key: body.key } })
    if (exists) {
      return reply.status(409).send({ error: `Project key "${body.key}" already exists` })
    }

    // Create project + default workflow statuses + add creator as OWNER
    // We use a Prisma transaction so either ALL succeed or ALL fail
    const project = await prisma.$transaction(async (tx: any) => {
      const proj = await tx.project.create({
        data: {
          name: body.name,
          key: body.key,
          description: body.description
        }
      })

      // Add the creator as project owner
      await tx.projectMember.create({
        data: { userId: request.user.id, projectId: proj.id, role: 'OWNER' }
      })

      // Create default workflow statuses
      const defaultStatuses = [
        { name: 'To Do', color: '#94a3b8', position: 0, isDefault: true },
        { name: 'In Progress', color: '#3b82f6', position: 1 },
        { name: 'In Review', color: '#f59e0b', position: 2 },
        { name: 'Done', color: '#22c55e', position: 3 }
      ]

      const statuses = await Promise.all(
        defaultStatuses.map(s =>
          tx.workflowStatus.create({ data: { ...s, projectId: proj.id } })
        )
      )

      // Create default allowed transitions:
      // To Do → In Progress → In Review → Done
      // (NOT To Do → Done directly)
      const transitions = [
        [statuses[0].id, statuses[1].id], // To Do → In Progress
        [statuses[1].id, statuses[2].id], // In Progress → In Review
        [statuses[1].id, statuses[0].id], // In Progress → To Do (allow going back)
        [statuses[2].id, statuses[3].id], // In Review → Done
        [statuses[2].id, statuses[1].id], // In Review → In Progress (send back)
      ]

      await Promise.all(
        transitions.map(([from, to]) =>
          tx.statusTransition.create({
            data: { fromStatusId: from, toStatusId: to }
          })
        )
      )

      return proj
    })

    return reply.status(201).send(project)
  })

  // GET /api/projects - List all projects the user is member of
  app.get('/projects', {
    preHandler: [app.authenticate],
    schema: { tags: ['Projects'], summary: 'List user projects' }
  }, async (request, reply) => {
    const projects = await prisma.project.findMany({
      where: {
        members: { some: { userId: request.user.id } }
      },
      include: {
        members: { include: { user: { select: { id: true, displayName: true, avatarUrl: true } } } },
        _count: { select: { issues: true, sprints: true } }
      }
    })
    return reply.send(projects)
  })

  // GET /api/projects/:id - Get single project details
  app.get('/projects/:id', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Projects'],
      summary: 'Get project details',
      params: { type: 'object', properties: { id: { type: 'string' } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const project = await prisma.project.findFirst({
      where: {
        id,
        members: { some: { userId: request.user.id } }
      },
      include: {
        members: {
          include: { user: { select: { id: true, displayName: true, email: true, avatarUrl: true } } }
        },
        workflowStatuses: {
          orderBy: { position: 'asc' },
          include: { transitionsFrom: { include: { toStatus: true } } }
        },
        sprints: { orderBy: { createdAt: 'desc' }, take: 5 }
      }
    })

    if (!project) return reply.status(404).send({ error: 'Project not found' })
    return reply.send(project)
  })

  // GET /api/projects/:id/board - Get full board state (all issues grouped by status)
  app.get('/projects/:id/board', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Projects'],
      summary: 'Get kanban board state',
      params: { type: 'object', properties: { id: { type: 'string' } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    // Get active sprint
    const activeSprint = await prisma.sprint.findFirst({
      where: { projectId: id, status: 'ACTIVE' }
    })

    // Get all statuses with their issues
    const statuses = await prisma.workflowStatus.findMany({
      where: { projectId: id },
      orderBy: { position: 'asc' },
      include: {
        issues: {
          where: activeSprint
            ? { sprintId: activeSprint.id }
            : { sprintId: null }, // Show backlog if no active sprint
          include: {
            assignee: { select: { id: true, displayName: true, avatarUrl: true } },
            reporter: { select: { id: true, displayName: true } },
            _count: { select: { comments: true, children: true } }
          },
          orderBy: { createdAt: 'desc' }
        }
      }
    })

    return reply.send({
      activeSprint,
      columns: statuses.map((s: any) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        issues: s.issues
      }))
    })
  })

  // GET /api/projects/:id/activity - Activity feed
  app.get('/projects/:id/activity', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Projects'],
      summary: 'Get project activity feed',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          cursor: { type: 'string' },
          limit: { type: 'number', default: 20 }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { cursor, limit = 20 } = request.query as { cursor?: string; limit?: number }

    const activities = await prisma.activityLog.findMany({
      where: { projectId: id },
      take: Number(limit) + 1, // fetch one extra to check if there's a next page
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, displayName: true, avatarUrl: true } },
        issue: { select: { id: true, issueKey: true, title: true } }
      }
    })

    // Cursor-based pagination
    const hasMore = activities.length > Number(limit)
    const items = hasMore ? activities.slice(0, -1) : activities
    const nextCursor = hasMore ? items[items.length - 1].id : null

    return reply.send({ items, nextCursor, hasMore })
  })
}
