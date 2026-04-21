import { FastifyInstance } from 'fastify'
import { prisma } from '../../config/prisma'

export async function notificationRoutes(app: FastifyInstance) {

  // GET /api/notifications - Get user's notifications
  app.get('/notifications', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Notifications'],
      summary: 'Get notifications for current user',
      querystring: {
        type: 'object',
        properties: {
          unreadOnly: { type: 'boolean', default: false },
          limit: { type: 'number', default: 20 },
          cursor: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { unreadOnly = false, limit = 20, cursor } = request.query as {
      unreadOnly?: boolean
      limit?: number
      cursor?: string
    }

    const notifications = await prisma.notification.findMany({
      where: {
        userId: request.user.id,
        ...(unreadOnly && { isRead: false })
      },
      take: Number(limit) + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { createdAt: 'desc' },
      include: {
        issue: { select: { id: true, issueKey: true, title: true } }
      }
    })

    const hasMore = notifications.length > Number(limit)
    const items = hasMore ? notifications.slice(0, -1) : notifications
    const nextCursor = hasMore ? items[items.length - 1].id : null
    const unreadCount = await prisma.notification.count({
      where: { userId: request.user.id, isRead: false }
    })

    return reply.send({ items, nextCursor, hasMore, unreadCount })
  })

  // PATCH /api/notifications/:id/read - Mark as read
  app.patch('/notifications/:id/read', {
    preHandler: [app.authenticate],
    schema: { 
      tags: ['Notifications'], 
      summary: 'Mark notification as read',
      params: { type: 'object', properties: { id: { type: 'string' } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    await prisma.notification.update({
      where: { id, userId: request.user.id },
      data: { isRead: true }
    })
    return reply.send({ success: true })
  })

  // PATCH /api/notifications/read-all - Mark all as read
  app.patch('/notifications/read-all', {
    preHandler: [app.authenticate],
    schema: { tags: ['Notifications'], summary: 'Mark all notifications as read' }
  }, async (request, reply) => {
    await prisma.notification.updateMany({
      where: { userId: request.user.id, isRead: false },
      data: { isRead: true }
    })
    return reply.send({ success: true })
  })
}
