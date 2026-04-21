// Run with: npm run db:seed
// Creates 2 users, 1 project, sprints, and sample issues

import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding database...')

  // 1. Create Users
  const password = await bcrypt.hash('password123', 10)

  const alice = await prisma.user.upsert({
    where: { email: 'alice@example.com' },
    update: {},
    create: { email: 'alice@example.com', password, displayName: 'Alice Johnson' }
  })

  const bob = await prisma.user.upsert({
    where: { email: 'bob@example.com' },
    update: {},
    create: { email: 'bob@example.com', password, displayName: 'Bob Chen' }
  })

  console.log('✅ Users created:', alice.email, bob.email)

  // 2. Create Project
  const project = await prisma.project.upsert({
    where: { key: 'DEMO' },
    update: {},
    create: {
      key: 'DEMO',
      name: 'Demo Project',
      description: 'Sample project for testing the API'
    }
  })

  // 3. Add members
  await prisma.projectMember.upsert({
    where: { userId_projectId: { userId: alice.id, projectId: project.id } },
    update: {},
    create: { userId: alice.id, projectId: project.id, role: 'OWNER' }
  })

  await prisma.projectMember.upsert({
    where: { userId_projectId: { userId: bob.id, projectId: project.id } },
    update: {},
    create: { userId: bob.id, projectId: project.id, role: 'MEMBER' }
  })

  // 4. Create workflow statuses
  const todoStatus = await prisma.workflowStatus.upsert({
    where: { projectId_name: { projectId: project.id, name: 'To Do' } },
    update: {},
    create: { projectId: project.id, name: 'To Do', color: '#94a3b8', position: 0, isDefault: true }
  })

  const inProgressStatus = await prisma.workflowStatus.upsert({
    where: { projectId_name: { projectId: project.id, name: 'In Progress' } },
    update: {},
    create: { projectId: project.id, name: 'In Progress', color: '#3b82f6', position: 1 }
  })

  const inReviewStatus = await prisma.workflowStatus.upsert({
    where: { projectId_name: { projectId: project.id, name: 'In Review' } },
    update: {},
    create: { projectId: project.id, name: 'In Review', color: '#f59e0b', position: 2 }
  })

  const doneStatus = await prisma.workflowStatus.upsert({
    where: { projectId_name: { projectId: project.id, name: 'Done' } },
    update: {},
    create: { projectId: project.id, name: 'Done', color: '#22c55e', position: 3 }
  })

  // 5. Create transitions
  const transitionPairs = [
    [todoStatus.id, inProgressStatus.id],
    [inProgressStatus.id, inReviewStatus.id],
    [inProgressStatus.id, todoStatus.id],
    [inReviewStatus.id, doneStatus.id],
    [inReviewStatus.id, inProgressStatus.id],
  ]

  for (const [from, to] of transitionPairs) {
    await prisma.statusTransition.upsert({
      where: { fromStatusId_toStatusId: { fromStatusId: from, toStatusId: to } },
      update: {},
      create: { fromStatusId: from, toStatusId: to }
    })
  }

  console.log('✅ Workflow configured')

  // 6. Create Sprint
  let sprint = await prisma.sprint.findFirst({
    where: { projectId: project.id, name: 'Sprint 1' }
  })
  if (!sprint) {
    sprint = await prisma.sprint.create({
      data: {
        projectId: project.id,
        name: 'Sprint 1',
        goal: 'Setup core authentication and project structure',
        status: 'ACTIVE',
        startDate: new Date(),
        endDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      }
    })
  }

  console.log('✅ Sprint created')

  const issueUpsert = async (issueKey: string, data: any) =>
    prisma.issue.upsert({
      where: { issueKey },
      update: {},
      create: { issueKey, ...data }
    })

  const epic = await issueUpsert('DEMO-1', {
    projectId: project.id, reporterId: alice.id,
    type: 'EPIC', title: 'User Authentication System',
    description: 'Complete auth system including OAuth, JWT, and password reset',
    statusId: inProgressStatus.id, priority: 'HIGH',
    storyPoints: 21, labels: ['auth', 'backend'], sprintId: sprint.id
  })

  const story1 = await issueUpsert('DEMO-2', {
    projectId: project.id, reporterId: alice.id, assigneeId: bob.id,
    type: 'STORY', title: 'Add user login via email/password',
    description: 'Implement JWT-based login endpoint with bcrypt password hashing',
    statusId: doneStatus.id, priority: 'HIGH',
    storyPoints: 5, parentId: epic.id, sprintId: sprint.id, labels: ['auth']
  })

  const story2 = await issueUpsert('DEMO-3', {
    projectId: project.id, reporterId: alice.id, assigneeId: alice.id,
    type: 'STORY', title: 'Add user authentication via OAuth',
    description: 'Implement OAuth 2.0 login flow with Google provider',
    statusId: inProgressStatus.id, priority: 'HIGH',
    storyPoints: 8, parentId: epic.id, sprintId: sprint.id, labels: ['auth', 'oauth']
  })

  const bug = await issueUpsert('DEMO-4', {
    projectId: project.id, reporterId: bob.id, assigneeId: alice.id,
    type: 'BUG', title: 'JWT token not expiring correctly',
    description: 'Tokens issued before server restart remain valid after restart',
    statusId: todoStatus.id, priority: 'CRITICAL',
    storyPoints: 3, sprintId: sprint.id, labels: ['bug', 'auth', 'security']
  })

  // 8. Add a comment
  await prisma.comment.create({
    data: {
      issueId: story2.id,
      authorId: alice.id,
      content: 'Working on the Google OAuth flow. @Bob can you review the callback handler once I push?'
    }
  })

  // 9. Add activity logs
  await prisma.activityLog.createMany({
    data: [
      {
        projectId: project.id,
        issueId: story1.id,
        userId: bob.id,
        eventType: 'status_changed',
        oldValue: 'To Do',
        newValue: 'Done'
      },
      {
        projectId: project.id,
        issueId: story2.id,
        userId: alice.id,
        eventType: 'issue_created',
        newValue: story2.title
      }
    ]
  })

  console.log('✅ Issues and activity created')
  console.log('\n🎉 Seed complete!')
  console.log('─────────────────────────────────')
  console.log('Login credentials:')
  console.log('  Email:    alice@example.com')
  console.log('  Password: password123')
  console.log('')
  console.log('  Email:    bob@example.com')
  console.log('  Password: password123')
  console.log('─────────────────────────────────\n')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
