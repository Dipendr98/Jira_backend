import { prisma } from '../config/prisma'

// ── Activity Logger ───────────────────────────────────────────────
// Call this after every significant change to create an audit trail

interface LogActivityParams {
  projectId: string
  issueId?: string
  userId: string
  eventType: string
  oldValue?: string
  newValue?: string
  metadata?: object
}

export async function logActivity(params: LogActivityParams) {
  await prisma.activityLog.create({
    data: {
      projectId: params.projectId,
      issueId: params.issueId,
      userId: params.userId,
      eventType: params.eventType,
      oldValue: params.oldValue,
      newValue: params.newValue,
      metadata: params.metadata ? JSON.stringify(params.metadata) : undefined
    }
  })
}

// ── Watcher Notifier ─────────────────────────────────────────────
// Sends a notification to everyone watching an issue

export async function notifyWatchers(
  issueId: string,
  type: 'STATUS_CHANGED' | 'ISSUE_UPDATED' | 'COMMENT_ADDED' | 'ASSIGNED' | 'MENTIONED',
  message: string,
  excludeUserId?: string
) {
  const watchers = await prisma.issueWatcher.findMany({
    where: { issueId },
    select: { userId: true }
  })

  const notifications = watchers
    .filter(w => w.userId !== excludeUserId)
    .map(w => ({
      userId: w.userId,
      issueId,
      type,
      message
    }))

  if (notifications.length > 0) {
    await prisma.notification.createMany({ data: notifications })
  }
}

// ── Pagination Helper ─────────────────────────────────────────────
// Reusable cursor-based pagination

export function buildPaginationResponse<T extends { id: string }>(
  items: T[],
  limit: number
) {
  const hasMore = items.length > limit
  const data = hasMore ? items.slice(0, -1) : items
  const nextCursor = hasMore ? data[data.length - 1].id : null

  return { items: data, nextCursor, hasMore }
}
