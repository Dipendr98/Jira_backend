import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

// This function protects routes that need login
// Usage: add preHandler: [app.authenticate] to any route

export function authMiddleware(app: FastifyInstance) {
  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply
  ) {
    try {
      // Verifies the JWT token from the Authorization header
      // Header format: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9..."
      await request.jwtVerify()
    } catch (err) {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid or missing authentication token'
      })
    }
  }
}

// Type augmentation: tells TypeScript about our custom properties
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    io: import('socket.io').Server
  }
}

// Extend the JWT module to type our token payload
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { id: string; email: string; displayName: string }
    user: { id: string; email: string; displayName: string }
  }
}
