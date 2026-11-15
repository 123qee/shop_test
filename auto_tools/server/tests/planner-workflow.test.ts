import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { addDays, nextOccurrence, plannerToday } from '../../shared/planner';

test('日历日期与重复任务跨月、跨周及逾期处理', () => {
  assert.equal(plannerToday(new Date('2026-10-19T17:00:00Z')), '2026-10-20');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(nextOccurrence('2026-10-23', 'weekdays', '2026-10-23'), '2026-10-26');
  assert.equal(nextOccurrence('2026-10-19', 'daily', '2026-10-23'), '2026-10-24');
  assert.equal(nextOccurrence('2026-10-05', 'weekly', '2026-10-20'), '2026-10-26');
  assert.equal(nextOccurrence('2026-12-31', 'daily', '2026-12-31'), '2027-01-01');
});

test('个人项目与任务 API 完整流程及独立存储', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-tools-planner-'));
  process.env.DB_PATH = join(dir, 'test.db');
  const { createApp } = await import('../src/app');
  const { getDb } = await import('../src/db');
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/planner`;
  async function request(path = '', method = 'GET', body?: unknown) {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  }
  try {
    assert.deepEqual((await request()).data, { projects: [], tasks: [] });
    const project = (await request('/projects', 'POST', { name: '钢琴日常', category: 'growth', icon: 'piano' })).data;
    let task: any;
    await t.test('项目和子步骤保存，部分更新不清空已有属性', async () => {
      const result = await request('/tasks', 'POST', { title: '练琴 30 分钟', projectId: project.id, priority: 'high', description: '先慢练', checklist: [{ id: 'scale', title: '音阶', done: true }] });
      assert.equal(result.status, 201); task = result.data;
      const updated = (await request(`/tasks/${task.id}`, 'PATCH', { status: 'doing' })).data;
      assert.equal(updated.description, '先慢练'); assert.equal(updated.priority, 'high'); assert.equal(updated.checklist[0].done, true);
      assert.equal((await request()).data.tasks[0].status, 'doing');
    });
    await t.test('重复任务只打卡一次，日期前进且步骤重置，重试不重复完成', async () => {
      const today = plannerToday();
      await request(`/tasks/${task.id}`, 'PATCH', { repeat: 'daily', dueDate: today });
      const result = await request(`/tasks/${task.id}/complete`, 'POST', { expectedDueDate: today });
      assert.equal(result.status, 200); assert.equal(result.data.dueDate, addDays(today, 1));
      assert.equal(result.data.status, 'todo'); assert.equal(result.data.completionCount, 1); assert.equal(result.data.checklist[0].done, false);
      assert.equal((await request(`/tasks/${task.id}/complete`, 'POST', { expectedDueDate: today })).status, 409);
      assert.equal((await request()).data.tasks[0].completionCount, 1);
      assert.equal((getDb().prepare('SELECT count(*) n FROM personal_task_completions').get() as any).n, 1);
      await request(`/tasks/${task.id}`, 'PATCH', { dueDate: today });
      assert.equal((await request(`/tasks/${task.id}/complete`, 'POST', { expectedDueDate: today })).status, 409);
      await request(`/tasks/${task.id}`, 'PATCH', { dueDate: addDays(today, 1) });
    });
    await t.test('一次性任务可完成和重新打开，独立任务可以不归属项目', async () => {
      const todo = (await request('/tasks', 'POST', { title: '整理乐谱' })).data;
      assert.equal(todo.projectId, null);
      assert.equal((await request(`/tasks/${todo.id}/complete`, 'POST', { expectedDueDate: null })).data.status, 'done');
      assert.equal((await request(`/tasks/${todo.id}`, 'PATCH', { status: 'todo' })).data.completedAt, null);
    });
    await t.test('项目和任务归档可恢复，归档项目不能误打卡', async () => {
      assert.equal((await request(`/projects/${project.id}`, 'PATCH', { archived: true })).data.archived, true);
      assert.equal((await request(`/tasks/${task.id}/complete`, 'POST', { expectedDueDate: addDays(plannerToday(), 1) })).status, 400);
      assert.equal((await request(`/tasks/${task.id}`, 'PATCH', { archived: true })).status, 200);
      await request(`/projects/${project.id}`, 'PATCH', { archived: false });
      await request(`/tasks/${task.id}`, 'PATCH', { archived: false });
      const snapshot = (await request()).data;
      assert.equal(snapshot.projects[0].archived, false); assert.equal(snapshot.tasks.find((row: any) => row.id === task.id).archived, false);
      assert.equal((getDb().prepare('SELECT count(*) n FROM products').get() as any).n, 0);
    });
    await t.test('拒绝无效日期、空标题、悬空项目及缺日期重复任务', async () => {
      assert.equal((await request('/tasks', 'POST', { title: ' ' })).status, 400);
      assert.equal((await request('/tasks', 'POST', { title: '无效日期', dueDate: '2026-02-30' })).status, 400);
      assert.equal((await request('/tasks', 'POST', { title: '未配置日期', repeat: 'daily' })).status, 400);
      assert.equal((await request('/tasks', 'POST', { title: '不存在的项目', projectId: '11111111-1111-4111-8111-111111111111' })).status, 404);
      assert.equal((await request('/tasks', 'POST', { title: '直接完成重复', repeat: 'daily', dueDate: plannerToday(), status: 'done' })).status, 400);
      assert.equal((await request('/tasks/missing', 'PATCH', { status: 'doing' })).status, 404);
    });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); getDb().close(); rmSync(dir, { recursive: true, force: true }); }
});
