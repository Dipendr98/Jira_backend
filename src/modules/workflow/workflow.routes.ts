import { FastifyInstance } from 'fastify'
import { prisma } from '../../config/prisma'
import { requireProjectMember } from '../../utils/rbac'
import { AppError } from '../../utils/errors'

export async function workflowRoutes(app: FastifyInstance) {

  // GET /api/projects/:id/workflow - Get workflow config for a project
  app.get('/projects/:id/workflow', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Workflow'],
      summary: 'Get workflow statuses and allowed transitions',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Project ID' } } }
    }
  }, async (request, reply) => {
    const { id: projectId } = request.params as { id: string }

    const statuses = await prisma.workflowStatus.findMany({
      where: { projectId },
      orderBy: { position: 'asc' },
      include: {
        transitionsFrom: {
          include: { toStatus: { select: { id: true, name: true, color: true } } }
        }
      }
    })

    return reply.send(statuses)
  })

  // POST /api/projects/:id/workflow/statuses - Add a custom status
  app.post('/projects/:id/workflow/statuses', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Workflow'],
      summary: 'Add a new status to the workflow',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Project ID' } } },
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          color: { type: 'string', default: '#6366f1' }
        }
      }
    }
  }, async (request, reply) => {
    const { id: projectId } = request.params as { id: string }
    const { name, color } = request.body as { name: string; color?: string }
    try { await requireProjectMember(projectId, request.user.id, 'ADMIN') } catch {
      return reply.status(403).send({ error: 'Forbidden: admin role required' })
    }

    // Put new status at the end
    const lastStatus = await prisma.workflowStatus.findFirst({
      where: { projectId },
      orderBy: { position: 'desc' }
    })

    const status = await prisma.workflowStatus.create({
      data: {
        projectId,
        name,
        color: color || '#6366f1',
        position: (lastStatus?.position || 0) + 1
      }
    })

    return reply.status(201).send(status)
  })

  // POST /api/projects/:id/workflow/transitions - Define allowed transition
  app.post('/projects/:id/workflow/transitions', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Workflow'],
      summary: 'Add an allowed status transition',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Project ID' } } },
      body: {
        type: 'object',
        required: ['fromStatusId', 'toStatusId'],
        properties: {
          fromStatusId: { type: 'string' },
          toStatusId: { type: 'string' },
          autoAction: { type: 'string', description: 'JSON: auto actions on transition (e.g., {"type": "notify_assignee"})' }
        }
      }
    }
  }, async (request, reply) => {
    const { id: projectId } = request.params as { id: string }
    const { fromStatusId, toStatusId, autoAction } = request.body as {
      fromStatusId: string
      toStatusId: string
      autoAction?: string
    }
    try { await requireProjectMember(projectId, request.user.id, 'ADMIN') } catch {
      return reply.status(403).send({ error: 'Forbidden: admin role required' })
    }

    const transition = await prisma.statusTransition.create({
      data: { fromStatusId, toStatusId, autoAction }
    })

    return reply.status(201).send(transition)
  })

  // DELETE /api/workflow/transitions/:id - Remove a transition
  app.delete('/workflow/transitions/:id', {
    preHandler: [app.authenticate],
    schema: { 
      tags: ['Workflow'], 
      summary: 'Remove an allowed transition',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Transition ID' } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    await prisma.statusTransition.delete({ where: { id } })
    return reply.status(204).send()
  })
}
