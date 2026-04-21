import { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { prisma } from '../../config/prisma'
import { z } from 'zod'

// Zod schemas validate incoming request data
const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  displayName: z.string().min(2)
})

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string()
})

export async function userRoutes(app: FastifyInstance) {
  
  // POST /api/auth/register
  app.post('/auth/register', {
    schema: {
      tags: ['Auth'],
      summary: 'Register a new user',
      body: {
        type: 'object',
        required: ['email', 'password', 'displayName'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 6 },
          displayName: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const body = RegisterSchema.parse(request.body)

    // Check if email already exists
    const existing = await prisma.user.findUnique({
      where: { email: body.email }
    })
    if (existing) {
      return reply.status(409).send({ error: 'Email already registered' })
    }

    // Hash password before storing (never store plain text!)
    const hashedPassword = await bcrypt.hash(body.password, 10)

    const user = await prisma.user.create({
      data: {
        email: body.email,
        password: hashedPassword,
        displayName: body.displayName
      },
      select: { id: true, email: true, displayName: true, createdAt: true }
    })

    // Generate JWT token
    const token = app.jwt.sign({
      id: user.id,
      email: user.email,
      displayName: user.displayName
    })

    return reply.status(201).send({ user, token })
  })

  // POST /api/auth/login
  app.post('/auth/login', {
    schema: {
      tags: ['Auth'],
      summary: 'Login and get JWT token',
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string' },
          password: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const body = LoginSchema.parse(request.body)

    const user = await prisma.user.findUnique({
      where: { email: body.email }
    })

    if (!user) {
      return reply.status(401).send({ error: 'Invalid credentials' })
    }

    // Compare submitted password with stored hash
    const isValid = await bcrypt.compare(body.password, user.password)
    if (!isValid) {
      return reply.status(401).send({ error: 'Invalid credentials' })
    }

    const token = app.jwt.sign({
      id: user.id,
      email: user.email,
      displayName: user.displayName
    })

    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName
      },
      token
    })
  })

  // GET /api/me - get current logged-in user profile
  app.get('/me', {
    preHandler: [app.authenticate],
    schema: { tags: ['Auth'], summary: 'Get current user profile' }
  }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        id: true, email: true, displayName: true,
        avatarUrl: true, createdAt: true,
        projectMembers: {
          include: { project: { select: { id: true, key: true, name: true } } }
        }
      }
    })
    return reply.send(user)
  })
}
