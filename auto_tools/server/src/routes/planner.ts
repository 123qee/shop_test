import { Router } from 'express';
import { z } from 'zod';
import { taskStatuses, projectStatuses, projectCategories, repeatRules } from '../../../shared/planner.js';
import { asyncHandler } from '../middleware/error.js';
import { PlannerError, plannerService } from '../services/planner-service.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, '日期无效').nullable();
const projectSchema = z.object({
  name: z.string().trim().min(1, '请输入项目名称').max(100), description: z.string().max(10000).default(''),
  category: z.enum(projectCategories).default('life'), icon: z.string().max(16).default('folder'),
  color: z.enum(['violet', 'blue', 'amber', 'green', 'rose']).default('violet'),
  status: z.enum(projectStatuses).default('active'), targetDate: date.default(null),
  favorite: z.boolean().default(false), archived: z.boolean().default(false),
}).strict();
const taskSchema = z.object({
  title: z.string().trim().min(1, '请输入任务名称').max(200), description: z.string().max(20000).default(''),
  projectId: z.string().uuid().nullable().default(null), status: z.enum(taskStatuses).default('todo'),
  priority: z.enum(['high', 'medium', 'low']).default('medium'), dueDate: date.default(null),
  repeat: z.enum(repeatRules).default('none'), archived: z.boolean().default(false),
  checklist: z.array(z.object({ id: z.string().min(1).max(100), title: z.string().trim().min(1).max(200), done: z.boolean() })).max(100).default([]),
}).strict();

export const plannerRouter = Router();
plannerRouter.get('/planner', asyncHandler(async (_req, res) => res.json(plannerService.list())));
plannerRouter.post('/planner/projects', asyncHandler(async (req, res) => res.status(201).json(plannerService.createProject(projectSchema.parse(req.body)))));
plannerRouter.patch('/planner/projects/:id', asyncHandler(async (req, res) => res.json(plannerService.updateProject(req.params.id, projectSchema.partial().parse(req.body)))));
plannerRouter.post('/planner/tasks', asyncHandler(async (req, res) => res.status(201).json(plannerService.createTask(taskSchema.parse(req.body)))));
plannerRouter.patch('/planner/tasks/:id', asyncHandler(async (req, res) => res.json(plannerService.updateTask(req.params.id, taskSchema.partial().parse(req.body)))));
plannerRouter.post('/planner/tasks/:id/complete', asyncHandler(async (req, res) => {
  const body = z.object({ expectedDueDate: date }).strict().parse(req.body);
  res.json(plannerService.completeTask(req.params.id, body.expectedDueDate));
}));
plannerRouter.use((error: unknown, _req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
  if (error instanceof PlannerError) { res.status(error.status).json({ error: error.message }); return; }
  next(error);
});
