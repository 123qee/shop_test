import { plannerToday, type PersonalTask } from '@shared/planner';

export const categories = { business: '跨境电商', growth: '兴趣成长', life: '日常生活' };
export const projectStatuses = { active: '进行中', paused: '已暂停', completed: '已完成' };
export type ProjectSort = 'created' | 'updated' | 'name' | 'progress';

/** Routines are counted separately so that ongoing habits do not dilute project progress. */
export function progress(tasks: PersonalTask[]) {
  const total = tasks.filter(task => task.repeat === 'none');
  const done = total.filter(task => task.status === 'done').length;
  return { total: total.length, done, percent: total.length ? Math.round(done / total.length * 100) : 0 };
}

export function projectDate(value: string | null, today: string) {
  if (!value) return '—';
  const date = value.includes('T') ? plannerToday(new Date(value)) : value;
  if (date === today) return '今天';
  return date.replace(/^\d{4}-/, '').replace('-', '/');
}
