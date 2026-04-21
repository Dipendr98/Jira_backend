import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { Server } from 'socket.io'
import dotenv from 'dotenv'

// Load .env file
dotenv.config()

// Import routes
import { projectRoutes } from './modules/projects/projects.routes'
import { issueRoutes } from './modules/issues/issues.routes'
import { sprintRoutes } from './modules/sprints/sprints.routes'
import { commentRoutes } from './modules/comments/comments.routes'
import { searchRoutes } from './modules/search/search.routes'
import { notificationRoutes } from './modules/notifications/notifications.routes'
import { userRoutes } from './modules/users/users.routes'
import { workflowRoutes } from './modules/workflow/workflow.routes'
import { customFieldRoutes } from './modules/customfields/customfields.routes'
import { setupSocketIO } from './websocket/socket'
import { authMiddleware } from './middleware/auth'

async function buildApp() {
  const isProduction = process.env.NODE_ENV === 'production'

  const app = Fastify({
    logger: isProduction
      ? true
      : {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true }
          }
        }
  })

  // Plugins
  await app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  })

  await app.register(jwt, {
    secret: process.env.JWT_SECRET || 'fallback-secret-change-this'
  })

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Project Management API',
        description: 'Jira-like project management backend',
        version: '1.0.0'
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT'
          }
        }
      },
      security: [{ bearerAuth: [] }]
    }
  })

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list' }
  })

  // Auth decorator
  app.decorate('authenticate', authMiddleware(app))

  // Routes
  await app.register(userRoutes, { prefix: '/api' })
  await app.register(projectRoutes, { prefix: '/api' })
  await app.register(issueRoutes, { prefix: '/api' })
  await app.register(sprintRoutes, { prefix: '/api' })
  await app.register(commentRoutes, { prefix: '/api' })
  await app.register(searchRoutes, { prefix: '/api' })
  await app.register(notificationRoutes, { prefix: '/api' })
  await app.register(workflowRoutes, { prefix: '/api' })
  await app.register(customFieldRoutes, { prefix: '/api' })

  // Health check
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() }
  })
  
  // Debug DB URL because Prisma Studio is empty
  app.get('/api/debug-db', async () => {
    return { db: process.env.DATABASE_URL }
  })

  return app
}

async function main() {
  const app = await buildApp()

  const port = Number(process.env.PORT) || 3000

  try {
    // ✅ Attach Socket.IO BEFORE starting server
    const io = new Server(app.server, {
      cors: { origin: '*', methods: ['GET', 'POST'] }
    })

    // ✅ Decorate BEFORE listen (important)
    app.decorate('io', io)

    setupSocketIO(io)

    // ✅ Start server
    await app.listen({ port, host: '0.0.0.0' })

    console.log(`\n🚀 Server running at http://localhost:${port}`)
    console.log(`📚 API Docs at http://localhost:${port}/docs`)
    console.log(`🔌 WebSocket ready on port ${port}\n`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

main()

export { buildApp }