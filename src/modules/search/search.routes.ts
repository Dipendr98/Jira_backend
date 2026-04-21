import { FastifyInstance } from 'fastify'
import { prisma } from '../../config/prisma'

export async function searchRoutes(app: FastifyInstance) {

  // GET /api/search?q=...&projectId=...&status=...&assignee=...
  // Supports BOTH full-text search AND structured filters
  app.get('/search', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Search'],
      summary: 'Search issues with full-text and structured filters',
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Full-text search across title, description, comments' },
          projectId: { type: 'string' },
          status: { type: 'string', description: 'Status name e.g. "In Progress"' },
          assignee: { type: 'string', description: 'User display name' },
          priority: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          type: { type: 'string', enum: ['EPIC', 'STORY', 'TASK', 'BUG', 'SUBTASK'] },
          label: { type: 'string' },
          sprintId: { type: 'string' },
          cursor: { type: 'string' },
          limit: { type: 'number', default: 20 }
        }
      }
    }
  }, async (request, reply) => {
    const {
      q,
      projectId,
      status,
      assignee,
      priority,
      type,
      label,
      sprintId,
      cursor,
      limit = 20
    } = request.query as {
      q?: string
      projectId?: string
      status?: string
      assignee?: string
      priority?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
      type?: 'EPIC' | 'STORY' | 'TASK' | 'BUG' | 'SUBTASK'
      label?: string
      sprintId?: string
      cursor?: string
      limit?: number
    }

    // Build Prisma where clause dynamically
    // Only add filters that were actually provided
    const where: any = {
      // Only show issues from projects user is member of
      project: {
        members: { some: { userId: request.user.id } }
      }
    }

    if (projectId) where.projectId = projectId
    if (priority) where.priority = priority
    if (type) where.type = type
    if (sprintId) where.sprintId = sprintId
    if (label) where.labels = { has: label }

    if (status) {
      where.status = { name: { equals: status, mode: 'insensitive' } }
    }

    if (assignee) {
      where.assignee = { displayName: { contains: assignee, mode: 'insensitive' } }
    }

    // Full-text search: searches title AND description
    if (q) {
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        // Also search in comments
        {
          comments: {
            some: { content: { contains: q, mode: 'insensitive' } }
          }
        }
      ]
    }

    const issues = await prisma.issue.findMany({
      where,
      take: Number(limit) + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: [
        { priority: 'asc' }, // CRITICAL first
        { updatedAt: 'desc' }
      ],
      include: {
        status: true,
        assignee: { select: { id: true, displayName: true, avatarUrl: true } },
        project: { select: { id: true, key: true, name: true } },
        sprint: { select: { id: true, name: true } },
        _count: { select: { comments: true } }
      }
    })

    const hasMore = issues.length > Number(limit)
    const items = hasMore ? issues.slice(0, -1) : issues
    const nextCursor = hasMore ? items[items.length - 1].id : null

    return reply.send({
      items,
      nextCursor,
      hasMore,
      total: items.length
    })
  })
}
