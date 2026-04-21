import { prisma } from '../config/prisma'
import { AppError } from './errors'

const ROLE_RANK: Record<string, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3
}

export async function requireProjectMember(
  projectId: string,
  userId: string,
  minRole: 'VIEWER' | 'MEMBER' | 'ADMIN' | 'OWNER' = 'MEMBER'
): Promise<void> {
  const member = await prisma.projectMember.findUnique({
    where: { userId_projectId: { userId, projectId } }
  })
  if (!member || (ROLE_RANK[member.role] ?? -1) < ROLE_RANK[minRole]) {
    throw new AppError('Forbidden: insufficient project permissions', 403)
  }
}
