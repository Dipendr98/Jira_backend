import { PrismaClient } from '@prisma/client'

// Singleton pattern: only ONE database connection throughout the app
// This is important - creating a new PrismaClient every request would be wasteful

declare global {
  var __prisma: PrismaClient | undefined
}

export const prisma =
  global.__prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' 
      ? ['query', 'error', 'warn']  // Show SQL queries in dev
      : ['error']
  })

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma
}
