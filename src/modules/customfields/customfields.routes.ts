import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../config/prisma'
import { requireProjectMember } from '../../utils/rbac'
import { AppError } from '../../utils/errors'

const CreateFieldSchema = z.object({
  name: z.string().min(1),
  fieldType: z.enum(['TEXT', 'NUMBER', 'DROPDOWN', 'DATE']),
  options: z.array(z.string()).optional(),
  required: z.boolean().default(false)
})

const SetFieldValueSchema = z.object({
  value: z.string()
})

function handleError(reply: any, err: unknown) {
  if (err instanceof AppError) {
    return reply.status(err.statusCode).send({ error: err.message, ...(err.details && { details: err.details }) })
  }
  throw err
}

export async function customFieldRoutes(app: FastifyInstance) {

  // POST /api/projects/:id/fields — define a custom field
  app.post('/projects/:id/fields', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Custom Fields'],
      summary: 'Define a custom field for a project',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['name', 'fieldType'],
        properties: {
          name: { type: 'string' },
          fieldType: { type: 'string', enum: ['TEXT', 'NUMBER', 'DROPDOWN', 'DATE'] },
          options: { type: 'array', items: { type: 'string' }, description: 'Required for DROPDOWN type' },
          required: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id: projectId } = request.params as { id: string }
      await requireProjectMember(projectId, request.user.id, 'ADMIN')
      const body = CreateFieldSchema.parse(request.body)

      if (body.fieldType === 'DROPDOWN' && (!body.options || body.options.length === 0)) {
        throw new AppError('DROPDOWN fields require at least one option', 400)
      }

      const field = await prisma.customFieldDefinition.create({
        data: {
          projectId,
          name: body.name,
          fieldType: body.fieldType,
          options: body.options ? JSON.stringify(body.options) : null,
          required: body.required
        }
      })

      return reply.status(201).send(field)
    } catch (err) { return handleError(reply, err) }
  })

  // GET /api/projects/:id/fields — list custom field definitions
  app.get('/projects/:id/fields', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Custom Fields'],
      summary: 'List custom field definitions for a project',
      params: { type: 'object', properties: { id: { type: 'string' } } }
    }
  }, async (request, reply) => {
    try {
      const { id: projectId } = request.params as { id: string }
      await requireProjectMember(projectId, request.user.id, 'VIEWER')

      const fields = await prisma.customFieldDefinition.findMany({
        where: { projectId },
        orderBy: { name: 'asc' }
      })

      return reply.send(fields.map(f => ({
        ...f,
        options: f.options ? JSON.parse(f.options) : null
      })))
    } catch (err) { return handleError(reply, err) }
  })

  // DELETE /api/fields/:id — remove a custom field definition
  app.delete('/fields/:id', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Custom Fields'],
      summary: 'Delete a custom field definition',
      params: { type: 'object', properties: { id: { type: 'string' } } }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const field = await prisma.customFieldDefinition.findUnique({ where: { id } })
      if (!field) return reply.status(404).send({ error: 'Custom field not found' })

      await requireProjectMember(field.projectId, request.user.id, 'ADMIN')
      await prisma.customFieldDefinition.delete({ where: { id } })
      return reply.status(204).send()
    } catch (err) { return handleError(reply, err) }
  })

  // PATCH /api/issues/:issueId/fields/:fieldId — set a custom field value on an issue
  app.patch('/issues/:issueId/fields/:fieldId', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Custom Fields'],
      summary: 'Set a custom field value on an issue',
      params: {
        type: 'object',
        properties: {
          issueId: { type: 'string' },
          fieldId: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        required: ['value'],
        properties: { value: { type: 'string' } }
      }
    }
  }, async (request, reply) => {
    try {
      const { issueId, fieldId } = request.params as { issueId: string; fieldId: string }
      const { value } = SetFieldValueSchema.parse(request.body)

      const issue = await prisma.issue.findUnique({ where: { id: issueId } })
      if (!issue) throw new AppError('Issue not found', 404)

      const field = await prisma.customFieldDefinition.findUnique({ where: { id: fieldId } })
      if (!field) throw new AppError('Custom field not found', 404)
      if (field.projectId !== issue.projectId) throw new AppError('Field does not belong to this issue\'s project', 400)

      await requireProjectMember(issue.projectId, request.user.id, 'MEMBER')

      // Validate DROPDOWN values
      if (field.fieldType === 'DROPDOWN' && field.options) {
        const allowed: string[] = JSON.parse(field.options)
        if (!allowed.includes(value)) {
          throw new AppError(`Invalid value. Allowed: ${allowed.join(', ')}`, 400, { allowed })
        }
      }

      // Upsert: create or update the value
      const result = await prisma.customFieldValue.upsert({
        where: { issueId_fieldId: { issueId, fieldId } },
        create: { issueId, fieldId, value },
        update: { value },
        include: { field: true }
      })

      return reply.send(result)
    } catch (err) { return handleError(reply, err) }
  })

  // GET /api/issues/:issueId/fields — get all custom field values for an issue
  app.get('/issues/:issueId/fields', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Custom Fields'],
      summary: 'Get all custom field values for an issue',
      params: { type: 'object', properties: { issueId: { type: 'string' } } }
    }
  }, async (request, reply) => {
    try {
      const { issueId } = request.params as { issueId: string }
      const issue = await prisma.issue.findUnique({ where: { id: issueId } })
      if (!issue) throw new AppError('Issue not found', 404)

      await requireProjectMember(issue.projectId, request.user.id, 'VIEWER')

      const values = await prisma.customFieldValue.findMany({
        where: { issueId },
        include: { field: true }
      })

      return reply.send(values.map(v => ({
        ...v,
        field: {
          ...v.field,
          options: v.field.options ? JSON.parse(v.field.options) : null
        }
      })))
    } catch (err) { return handleError(reply, err) }
  })
}
