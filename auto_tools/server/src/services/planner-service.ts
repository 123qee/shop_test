import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import { nextOccurrence, plannerToday, type PersonalProject, type PersonalTask, type PlannerData, type ProjectInput, type TaskInput } from '../../../shared/planner.js';

export class PlannerError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export class PlannerService {
  constructor(private database: () => Database.Database = getDb) {}

  list(): PlannerData {
    const db = this.database();
    return {
      projects: (db.prepare('SELECT data FROM personal_projects ORDER BY created_at').all() as { data: string }[]).map(row => JSON.parse(row.data)),
      tasks: (db.prepare('SELECT data FROM personal_tasks ORDER BY created_at DESC').all() as { data: string }[]).map(row => JSON.parse(row.data)),
    };
  }

  private project(id: string): PersonalProject {
    const row = this.database().prepare('SELECT data FROM personal_projects WHERE id = ?').get(id) as { data: string } | undefined;
    if (!row) throw new PlannerError('项目不存在', 404);
    return JSON.parse(row.data);
  }
  private task(id: string): PersonalTask {
    const row = this.database().prepare('SELECT data FROM personal_tasks WHERE id = ?').get(id) as { data: string } | undefined;
    if (!row) throw new PlannerError('任务不存在', 404);
    return JSON.parse(row.data);
  }
  private writeTask(task: PersonalTask) {
    this.database().prepare('UPDATE personal_tasks SET project_id = ?, data = ? WHERE id = ?').run(task.projectId, JSON.stringify(task), task.id);
    return task;
  }
  private checkTask(input: TaskInput) {
    if (input.projectId && this.project(input.projectId).archived) throw new PlannerError('请先恢复项目，再添加或修改任务');
    if (input.repeat !== 'none' && !input.dueDate) throw new PlannerError('重复任务需要设置首次执行日期');
    if (input.repeat !== 'none' && input.status === 'done') throw new PlannerError('重复任务请通过完成按钮打卡，系统会安排下一次');
  }
  createProject(input: ProjectInput): PersonalProject {
    const now = new Date().toISOString();
    const project = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    this.database().prepare('INSERT INTO personal_projects (id, data, created_at) VALUES (?, ?, ?)').run(project.id, JSON.stringify(project), now);
    return project;
  }
  updateProject(id: string, patch: Partial<ProjectInput>): PersonalProject {
    const project = { ...this.project(id), ...patch, updatedAt: new Date().toISOString() };
    this.database().prepare('UPDATE personal_projects SET data = ? WHERE id = ?').run(JSON.stringify(project), id);
    return project;
  }
  createTask(input: TaskInput): PersonalTask {
    this.checkTask(input);
    const now = new Date().toISOString();
    const task = { ...input, id: randomUUID(), createdAt: now, updatedAt: now, completedAt: input.status === 'done' ? now : null, completionCount: 0 };
    this.database().prepare('INSERT INTO personal_tasks (id, project_id, data, created_at) VALUES (?, ?, ?, ?)').run(task.id, task.projectId, JSON.stringify(task), now);
    return task;
  }
  updateTask(id: string, patch: Partial<TaskInput>): PersonalTask {
    const current = this.task(id);
    const task = { ...current, ...patch, updatedAt: new Date().toISOString() };
    // Archiving/restoring remains possible when the parent project is archived.
    if (Object.keys(patch).some(key => key !== 'archived')) this.checkTask(task);
    task.completedAt = task.status === 'done' ? current.completedAt ?? task.updatedAt : null;
    return this.writeTask(task);
  }
  completeTask(id: string, expectedDueDate: string | null): PersonalTask {
    return this.database().transaction(() => {
      const task = this.task(id);
      if (task.archived || (task.projectId && this.project(task.projectId).archived)) throw new PlannerError('请先恢复已归档的任务或项目');
      if (task.status === 'done') return task;
      if (task.dueDate !== expectedDueDate) throw new PlannerError('任务日期已变更，请刷新后重试', 409);
      const now = new Date().toISOString();
      if (task.repeat !== 'none') {
        if (!task.dueDate) throw new PlannerError('重复任务缺少日期');
        if (this.database().prepare('SELECT id FROM personal_task_completions WHERE task_id = ? AND occurrence_date = ?').get(id, task.dueDate)) {
          throw new PlannerError('这一天已经打过卡，请调整到新的执行日期', 409);
        }
        this.database().prepare('INSERT INTO personal_task_completions (id, task_id, occurrence_date, completed_at) VALUES (?, ?, ?, ?)')
          .run(randomUUID(), id, task.dueDate, now);
        task.dueDate = nextOccurrence(task.dueDate, task.repeat, plannerToday());
        task.status = 'todo';
        task.completionCount += 1;
        task.checklist = task.checklist.map(item => ({ ...item, done: false }));
      } else task.status = 'done';
      task.completedAt = now;
      task.updatedAt = now;
      return this.writeTask(task);
    })();
  }
}
export const plannerService = new PlannerService();
