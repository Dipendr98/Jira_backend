import { FastifyInstance } from 'fastify'
import { prisma } from '../../config/prisma'
import { logActivity } from '../../utils/helpers'

export async function commentRoutes(app: FastifyInstance) {

  // GET /api/issues/:id/comments - List comments
  app.get('/issues/:id/comments', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Comments'],
      summary: 'List comments on an issue (threaded)',
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
    const { id: issueId } = request.params as { id: string }
    const { cursor, limit = 20 } = request.query as { cursor?: string; limit?: number }

    // Only fetch top-level comments (parentId is null)
    // Replies are nested inside
    const comments = await prisma.comment.findMany({
      where: { issueId, parentId: null },
      take: Number(limit) + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: { id: true, displayName: true, avatarUrl: true } },
        replies: {
          include: {
            author: { select: { id: true, displayName: true, avatarUrl: true } }
          },
          orderBy: { createdAt: 'asc' }
        }
      }
    })

    const hasMore = comments.length > Number(limit)
    const items = hasMore ? comments.slice(0, -1) : comments
    const nextCursor = hasMore ? items[items.length - 1].id : null

    return reply.send({ items, nextCursor, hasMore })
  })

  // POST /api/issues/:id/comments - Add a comment
  app.post('/issues/:id/comments', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Comments'],
      summary: 'Add a comment to an issue',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', minLength: 1 },
          parentId: { type: 'string', description: 'For threaded replies' }
        }
      }
    }
  }, async (request, reply) => {
    const { id: issueId } = request.params as { id: string }
    const { content, parentId } = request.body as { content: string; parentId?: string }

    const issue = await prisma.issue.findUnique({ where: { id: issueId } })
    if (!issue) return reply.status(404).send({ error: 'Issue not found' })

    const comment = await prisma.comment.create({
      data: {
        content,
        issueId,
        authorId: request.user.id,
        parentId
      },
      include: {
        author: { select: { id: true, displayName: true, avatarUrl: true } }
      }
    })

    // Parse @mentions from comment content
    // Regex finds all @username patterns
    const mentions = content.match(/@(\w+)/g) || []
    
    for (const mention of mentions) {
      const username = mention.slice(1) // remove the @
      const mentionedUser = await prisma.user.findFirst({
        where: { displayName: { equals: username, mode: 'insensitive' } }
      })
      if (mentionedUser && mentionedUser.id !== request.user.id) {
        await prisma.notification.create({
          data: {
            userId: mentionedUser.id,
            issueId,
            type: 'MENTIONED',
            message: `${request.user.displayName} mentioned you in "${issue.title}"`
          }
        })
      }
    }

    // Log in activity feed
    await logActivity({
      projectId: issue.projectId,
      issueId,
      userId: request.user.id,
      eventType: 'comment_added',
      newValue: content.substring(0, 100) // truncate for log
    })

    // Broadcast to WebSocket
    app.io.to(`project:${issue.projectId}`).emit('comment_added', {
      issueId,
      comment
    })

    return reply.status(201).send(comment)
  })

  // PATCH /api/comments/:id - Edit a comment
  app.patch('/comments/:id', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Comments'],
      summary: 'Edit a comment (only author can edit)',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['content'],
        properties: { content: { type: 'string' } }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { content } = request.body as { content: string }

    const comment = await prisma.comment.findUnique({ where: { id } })
    if (!comment) return reply.status(404).send({ error: 'Comment not found' })

    // Only the author can edit their own comment
    if (comment.authorId !== request.user.id) {
      return reply.status(403).send({ error: 'You can only edit your own comments' })
    }

    const updated = await prisma.comment.update({
      where: { id },
      data: { content },
      include: { author: { select: { id: true, displayName: true, avatarUrl: true } } }
    })

    return reply.send(updated)
  })

  app.delete('/comments/:id', {
    preHandler: [app.authenticate],
    schema: { 
      tags: ['Comments'], 
      summary: 'Delete a comment',
      params: { type: 'object', properties: { id: { type: 'string' } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const comment = await prisma.comment.findUnique({ where: { id } })
    if (!comment) return reply.status(404).send({ error: 'Comment not found' })
    if (comment.authorId !== request.user.id) {
      return reply.status(403).send({ error: 'You can only delete your own comments' })
    }

    await prisma.comment.delete({ where: { id } })
    return reply.status(204).send()
  })
}
