// Service Layer: all business logic lives here, NOT in routes
// Routes just handle HTTP parsing and call these functions
// This is the pattern Swiggy expects: Route → Service → DB

import { prisma } from '../../config/prisma'
import { logActivity, notifyWatchers } from '../../utils/helpers'
import { AppError } from '../../utils/errors'

// ── Create Issue ──────────────────────────────────────────────────
export async function createIssue(
  projectId: string,
  userId: string,
  data: {
    type: 'EPIC' | 'STORY' | 'TASK' | 'BUG' | 'SUBTASK'
    title: string
    description?: string
    priority?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
    assigneeId?: string
    parentId?: string
    sprintId?: string
    storyPoints?: number
    labels?: string[]
  }
) {
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) throw new AppError('Project not found', 404)

  const defaultStatus = await prisma.workflowStatus.findFirst({
    where: { projectId, isDefault: true }
  })
  if (!defaultStatus) throw new AppError('Project has no default workflow status', 400)

  // 🔥 SAFE ISSUE KEY GENERATION (NO RACE CONDITION)
  const issue = await prisma.$transaction(async (tx: any) => {
    const updatedProject = await tx.project.update({
      where: { id: projectId },
      data: {
        issueSequence: { increment: 1 }
      }
    })

    const issueKey = `${project.key}-${updatedProject.issueSequence}`

    return tx.issue.create({
      data: {
        issueKey,
        projectId,
        statusId: defaultStatus.id,
        reporterId: userId,
        type: data.type,
        title: data.title,
        description: data.description,
        priority: data.priority || 'MEDIUM',
        assigneeId: data.assigneeId,
        parentId: data.parentId,
        sprintId: data.sprintId,
        storyPoints: data.storyPoints,
        labels: data.labels || []
      },
      include: {
        status: true,
        assignee: {
          select: { id: true, displayName: true, avatarUrl: true }
        },
        reporter: {
          select: { id: true, displayName: true }
        }
      }
    })
  })

  // Activity log
  await logActivity({
    projectId,
    issueId: issue.id,
    userId,
    eventType: 'issue_created',
    newValue: issue.title
  })

  // Notification if assigned
  if (data.assigneeId && data.assigneeId !== userId) {
    await prisma.notification.create({
      data: {
        userId: data.assigneeId,
        issueId: issue.id,
        type: 'ASSIGNED',
        message: `You were assigned to "${issue.title}"`
      }
    })
  }

  return issue
}

// ── Update Issue (with optimistic locking) ───────────────────────
// Optimistic locking: client sends the updatedAt timestamp it last saw.
// If the DB has a newer timestamp, someone else edited in between → reject.
// This handles: "Two users update the same issue simultaneously"
export async function updateIssue(
  issueId: string,
  userId: string,
  data: Partial<{
    title: string
    description: string
    priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
    assigneeId: string | null
    sprintId: string | null
    storyPoints: number
    labels: string[]
  }>,
  expectedVersion?: number // the client's last-known updatedAt
) {
  const existing = await prisma.issue.findUnique({
    where: { id: issueId },
    include: { status: true }
  })
  if (!existing) throw new AppError('Issue not found', 404)

  // ── Optimistic Locking Check ──────────────────────────────────
  // If the client provided an expectedUpdatedAt timestamp, verify it matches
  // what's in the DB. If it doesn't → conflict → reject with 409
  // Track what actually changed for the activity log
  const changes: Array<{ field: string; oldValue: string; newValue: string }> = []

  if (data.assigneeId !== undefined && data.assigneeId !== existing.assigneeId) {
    changes.push({
      field: 'assignee',
      oldValue: existing.assigneeId || 'unassigned',
      newValue: data.assigneeId || 'unassigned'
    })
  }
  if (data.priority && data.priority !== existing.priority) {
    changes.push({ field: 'priority', oldValue: existing.priority, newValue: data.priority })
  }
  if (data.title && data.title !== existing.title) {
    changes.push({ field: 'title', oldValue: existing.title, newValue: data.title })
  }
  if (data.storyPoints !== undefined && data.storyPoints !== existing.storyPoints) {
    changes.push({
      field: 'story_points',
      oldValue: String(existing.storyPoints ?? 0),
      newValue: String(data.storyPoints)
    })
  }

  if (expectedVersion !== undefined && expectedVersion !== existing.version) {
    throw new AppError(
      'Conflict: This issue was updated by someone else. Please refresh and try again.',
      409,
      {
        yourVersion: expectedVersion,
        currentVersion: existing.version
      }
    )
  }

  const updateResult = await prisma.issue.updateMany({
    where: {
      id: issueId,
      version: existing.version
    },
    data: {
      ...data,
      version: { increment: 1 }
    }
  })

  if (updateResult.count === 0) {
    throw new AppError(
      'Conflict: This issue was updated by someone else. Please refresh and try again.',
      409
    )
  }

  const updated = await prisma.issue.findUnique({
    where: { id: issueId },
    include: {
      status: true,
      assignee: { select: { id: true, displayName: true, avatarUrl: true } },
      reporter: { select: { id: true, displayName: true } },
      sprint: { select: { id: true, name: true } }
    }
  })

  if (!updated) throw new AppError('Issue not found after update', 404)
  // Log each field change separately in the audit trail
  for (const change of changes) {
    await logActivity({
      projectId: existing.projectId,
      issueId,
      userId,
      eventType: `${change.field}_changed`,
      oldValue: change.oldValue,
      newValue: change.newValue
    })
  }

  await notifyWatchers(issueId, 'ISSUE_UPDATED', `Issue "${updated.title}" was updated`, userId)

  return updated
}

// ── Transition Issue Status (Workflow Engine) ────────────────────
export async function transitionIssue(issueId: string, userId: string, toStatusId: string) {
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    include: { status: true }
  })
  if (!issue) throw new AppError('Issue not found', 404)

  // ── Workflow Validation Hook 1: Check transition is allowed ───
  const transitionAllowed = await prisma.statusTransition.findFirst({
    where: { fromStatusId: issue.statusId, toStatusId }
  })

  if (!transitionAllowed) {
    const allowedTransitions = await prisma.statusTransition.findMany({
      where: { fromStatusId: issue.statusId },
      include: { toStatus: { select: { id: true, name: true } } }
    })
    throw new AppError(
      `Workflow violation: Cannot move from "${issue.status.name}" to requested status`,
      422,
      {
        currentStatus: issue.status.name,
        allowedTransitions: allowedTransitions.map((t: any) => ({
          toStatusId: t.toStatusId,
          toStatusName: t.toStatus.name
        }))
      }
    )
  }

  // ── Workflow Validation Hook 2: Required fields check ─────────
  // e.g. moving to "In Review" requires an assignee
  const toStatus = await prisma.workflowStatus.findUnique({ where: { id: toStatusId } })
  if (toStatus?.name === 'In Review' && !issue.assigneeId) {
    throw new AppError(
      'Validation failed: Issue must have an assignee before moving to "In Review"',
      422,
      { requiredField: 'assigneeId' }
    )
  }

  // ── Auto Actions on Transition ────────────────────────────────
  // If the transition has an autoAction defined, execute it
  if (transitionAllowed.autoAction) {
    try {
      const action = JSON.parse(transitionAllowed.autoAction)
      // e.g. { "type": "notify_assignee", "message": "Ready for review" }
      if (action.type === 'notify_assignee' && issue.assigneeId) {
        await prisma.notification.create({
          data: {
            userId: issue.assigneeId,
            issueId,
            type: 'STATUS_CHANGED',
            message: action.message || `Issue "${issue.title}" status changed`
          }
        })
      }
    } catch {
      // Invalid JSON in autoAction — skip silently, don't fail the transition
    }
  }

  const updated = await prisma.issue.update({
    where: { id: issueId },
    data: { statusId: toStatusId },
    include: {
      status: true,
      assignee: { select: { id: true, displayName: true } }
    }
  })

  await logActivity({
    projectId: issue.projectId,
    issueId,
    userId,
    eventType: 'status_changed',
    oldValue: issue.status.name,
    newValue: toStatus?.name || toStatusId
  })

  await notifyWatchers(
    issueId,
    'STATUS_CHANGED',
    `"${issue.title}" moved to ${toStatus?.name}`,
    userId
  )

  return { issue: updated, fromStatus: issue.status.name, toStatus: toStatus?.name }
}

export { AppError }
