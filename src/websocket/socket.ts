import { Server, Socket } from 'socket.io'
import { prisma } from '../config/prisma'

// Tracks who is currently viewing what
// Format: { "project:abc123": Set<userId>, "issue:xyz789": Set<userId> }
const presenceMap = new Map<string, Set<string>>()

export function setupSocketIO(io: Server) {
  
  io.on('connection', (socket: Socket) => {
    const userId = socket.handshake.auth.userId as string
    console.log(`🔌 Client connected: ${socket.id} (user: ${userId})`)

    // ── Room Joining ──────────────────────────────────────────────
    // Clients call this to subscribe to a project's updates
    socket.on('join_project', (projectId: string) => {
      const room = `project:${projectId}`
      socket.join(room)
      
      // Track presence
      if (!presenceMap.has(room)) presenceMap.set(room, new Set())
      presenceMap.get(room)!.add(userId)

      // Tell everyone in this project who is online
      io.to(room).emit('presence_updated', {
        room,
        onlineUsers: Array.from(presenceMap.get(room) || [])
      })

      console.log(`👥 User ${userId} joined project room: ${projectId}`)
    })

    socket.on('leave_project', (projectId: string) => {
      const room = `project:${projectId}`
      socket.leave(room)
      presenceMap.get(room)?.delete(userId)
      
      io.to(room).emit('presence_updated', {
        room,
        onlineUsers: Array.from(presenceMap.get(room) || [])
      })
    })

    // Track who is viewing a specific issue
    socket.on('view_issue', (issueId: string) => {
      const room = `issue:${issueId}`
      socket.join(room)
      
      if (!presenceMap.has(room)) presenceMap.set(room, new Set())
      presenceMap.get(room)!.add(userId)

      io.to(room).emit('issue_viewers', {
        issueId,
        viewers: Array.from(presenceMap.get(room) || [])
      })
    })

    socket.on('leave_issue', (issueId: string) => {
      const room = `issue:${issueId}`
      socket.leave(room)
      presenceMap.get(room)?.delete(userId)
      
      io.to(room).emit('issue_viewers', {
        issueId,
        viewers: Array.from(presenceMap.get(room) || [])
      })
    })

    // ── Missed Event Replay ───────────────────────────────────────
    // Client sends { projectId, since: ISO timestamp } after reconnect.
    // We replay all activity log entries created after that timestamp.
    socket.on('request_replay', async (data: { projectId: string; since: string }) => {
      console.log(`📡 Replay requested for project ${data.projectId} since ${data.since}`)
      socket.emit('replay_start', { projectId: data.projectId })
      try {
        const missed = await prisma.activityLog.findMany({
          where: {
            projectId: data.projectId,
            createdAt: { gt: new Date(data.since) }
          },
          orderBy: { createdAt: 'asc' },
          include: {
            user: { select: { id: true, displayName: true } },
            issue: { select: { id: true, issueKey: true, title: true } }
          }
        })
        for (const event of missed) {
          socket.emit('activity_replay', event)
        }
      } catch (err) {
        console.error('Replay query failed:', err)
      }
      socket.emit('replay_end', { projectId: data.projectId })
    })

    // ── Disconnect ────────────────────────────────────────────────
    socket.on('disconnect', () => {
      // Remove user from ALL presence rooms they were in
      for (const [room, users] of presenceMap.entries()) {
        if (users.has(userId)) {
          users.delete(userId)
          io.to(room).emit('presence_updated', {
            room,
            onlineUsers: Array.from(users)
          })
        }
      }
      console.log(`❌ Client disconnected: ${socket.id}`)
    })
  })
}

// ── Event Types (for documentation) ─────────────────────────────
// These are all the events the server can emit to clients:
//
// issue_created    → { issue }
// issue_updated    → { issue }
// issue_moved      → { issue, fromStatus, toStatus }
// issue_deleted    → { issueId }
// comment_added    → { issueId, comment }
// sprint_updated   → { sprintId, status }
// presence_updated → { room, onlineUsers }
// issue_viewers    → { issueId, viewers }
