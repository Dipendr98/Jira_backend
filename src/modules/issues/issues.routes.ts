// Routes are now THIN — they only:
// 1. Parse the HTTP request
// 2. Call the service
// 3. Return the HTTP response
// All business logic is in issues.service.ts

import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createIssue, updateIssue, transitionIssue, AppError } from './issues.service'
import { prisma } from '../../config/prisma'
import { requireProjectMember } from '../../utils/rbac'

const CreateIssueSchema = z.object({
  type: z.enum(['EPIC', 'STORY', 'TASK', 'BUG', 'SUBTASK']),
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).default('MEDIUM'),
  assigneeId: z.string().optional(),
  parentId: z.string().optional(),
  sprintId: z.string().optional(),
  storyPoints: z.number().int().optional(),
  labels: z.array(z.string()).default([])
})

const UpdateIssueSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
  assigneeId: z.string().nullable().optional(),
  sprintId: z.string().nullable().optional(),
  storyPoints: z.number().int().optional(),
  labels: z.array(z.string()).optional(),
  expectedVersion: z.number().int().optional()
}).partial()

function handleError(reply: any, err: unknown) {
  if (err instanceof AppError) {
    return reply.status(err.statusCode).send({
      error: err.message,
      ...(err.details && { details: err.details })
    })
  }
  throw err
}

export async function issueRoutes(app: FastifyInstance) {

  app.post('/projects/:id/issues', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Issues'],
      summary: 'Create a new issue',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['type', 'title'],
        properties: {
          type: { type: 'string', enum: ['EPIC', 'STORY', 'TASK', 'BUG', 'SUBTASK'] },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'], default: 'MEDIUM' },
          assigneeId: { type: 'string' },
          parentId: { type: 'string' },
          sprintId: { type: 'string' },
          storyPoints: { type: 'number' },
          labels: { type: 'array', items: { type: 'string' }, default: [] }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id: projectId } = request.params as { id: string }
      await requireProjectMember(projectId, request.user.id, 'MEMBER')
      const body = CreateIssueSchema.parse(request.body)
      const issue = await createIssue(projectId, request.user.id, body)
      app.io.to(`project:${projectId}`).emit('issue_created', issue)
      return reply.status(201).send(issue)
    } catch (err) { return handleError(reply, err) }
  })

  app.patch('/issues/:id', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Issues'],
      summary: 'Update issue (with optimistic locking for concurrent edits)',
      description: 'Send expectedVersion in body to detect concurrent conflicts (returns 409)',

      params: {
        type: 'object',
        properties: {
          id: { type: 'string' }
        }
      },

      // 🔥 ADD THIS
      body: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          priority: {
            type: 'string',
            enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
          },
          assigneeId: { type: 'string' },
          sprintId: { type: 'string' },
          storyPoints: { type: 'number' },
          labels: {
            type: 'array',
            items: { type: 'string' }
          },
          expectedVersion: { type: 'number' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = UpdateIssueSchema.parse(request.body)
      const { expectedVersion, ...data } = body
      const updated = await updateIssue(id, request.user.id, data, expectedVersion)
      app.io.to(`project:${updated.projectId}`).emit('issue_updated', updated)
      return reply.send(updated)
    } catch (err) { return handleError(reply, err) }
  })

  app.get('/issues/:id', {
    preHandler: [app.authenticate],
    schema: { tags: ['Issues'], summary: 'Get issue details', params: { type: 'object', properties: { id: { type: 'string' } } } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const issue = await prisma.issue.findUnique({
      where: { id },
      include: {
        status: true,
        assignee: { select: { id: true, displayName: true, avatarUrl: true } },
        reporter: { select: { id: true, displayName: true, avatarUrl: true } },
        sprint: true,
        parent: { select: { id: true, issueKey: true, title: true } },
        children: { include: { status: true, assignee: { select: { id: true, displayName: true } } } },
        watchers: { include: { user: { select: { id: true, displayName: true, avatarUrl: true } } } },
        customFieldValues: { include: { field: true } },
        _count: { select: { comments: true } }
      }
    })
    if (!issue) return reply.status(404).send({ error: 'Issue not found' })
    return reply.send(issue)
  })

  app.post('/issues/:id/transitions', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Issues'],
      summary: 'Transition issue status — enforces workflow rules',
      description: 'Returns 422 with allowed transitions if move violates workflow. Returns 422 if required fields missing.',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: { type: 'object', required: ['toStatusId'], properties: { toStatusId: { type: 'string' } } }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { toStatusId } = request.body as { toStatusId: string }
      const result = await transitionIssue(id, request.user.id, toStatusId)
      app.io.to(`project:${result.issue.projectId}`).emit('issue_moved', result)
      return reply.send(result.issue)
    } catch (err) { return handleError(reply, err) }
  })

  app.post('/issues/:id/watch', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Issues'],
      summary: 'Toggle watch on an issue',
      params: { type: 'object', properties: { id: { type: 'string' } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const userId = request.user.id
    const existing = await prisma.issueWatcher.findUnique({ where: { issueId_userId: { issueId: id, userId } } })
    if (existing) {
      await prisma.issueWatcher.delete({ where: { issueId_userId: { issueId: id, userId } } })
      return reply.send({ watching: false })
    }
    await prisma.issueWatcher.create({ data: { issueId: id, userId } })
    return reply.send({ watching: true })
  })

  app.delete('/issues/:id', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Issues'],
      summary: 'Delete an issue',
      params: { type: 'object', properties: { id: { type: 'string' } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const issue = await prisma.issue.findUnique({ where: { id } })
    if (!issue) return reply.status(404).send({ error: 'Issue not found' })
    try {
      await requireProjectMember(issue.projectId, request.user.id, 'MEMBER')
    } catch {
      return reply.status(403).send({ error: 'Forbidden: insufficient project permissions' })
    }
    await prisma.issue.delete({ where: { id } })
    app.io.to(`project:${issue.projectId}`).emit('issue_deleted', { issueId: id })
    return reply.status(204).send()
  })
}
