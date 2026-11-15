/** Personal planning is separate from marketplace publishing jobs. Dates are calendar dates. */
export const taskStatuses = ['todo', 'doing', 'waiting', 'done'] as const;
export const projectStatuses = ['active', 'paused', 'completed'] as const;
export const projectCategories = ['business', 'growth', 'life'] as const;
export const repeatRules = ['none', 'daily', 'weekdays', 'weekly'] as const;
export type TaskStatus = typeof taskStatuses[number];
export type ProjectStatus = typeof projectStatuses[number];
export type ProjectCategory = typeof projectCategories[number];
export type RepeatRule = typeof repeatRules[number];
export interface ChecklistItem { id: string; title: string; done: boolean }
export interface PersonalProject {
  id: string; name: string; description: string; category: ProjectCategory;
  icon: string; color: string; status: ProjectStatus; targetDate: string | null;
  favorite: boolean; archived: boolean; createdAt: string; updatedAt: string;
}
export interface PersonalTask {
  id: string; title: string; description: string; projectId: string | null;
  status: TaskStatus; priority: 'high' | 'medium' | 'low'; dueDate: string | null;
  repeat: RepeatRule; checklist: ChecklistItem[]; archived: boolean;
  completedAt: string | null; completionCount: number; createdAt: string; updatedAt: string;
}
export type ProjectInput = Omit<PersonalProject, 'id' | 'createdAt' | 'updatedAt'>;
export type TaskInput = Omit<PersonalTask, 'id' | 'createdAt' | 'updatedAt' | 'completedAt' | 'completionCount'>;
export interface PlannerData { projects: PersonalProject[]; tasks: PersonalTask[] }

export function plannerToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
/** Complete overdue routines once; skip missed occurrences instead of creating a backlog. */
export function nextOccurrence(dueDate: string, rule: Exclude<RepeatRule, 'none'>, today: string): string {
  let next = addDays(dueDate, rule === 'weekly' ? 7 : 1);
  while (next <= today || (rule === 'weekdays' && [0, 6].includes(new Date(`${next}T12:00:00Z`).getUTCDay()))) {
    next = addDays(next, rule === 'weekly' ? 7 : 1);
  }
  return next;
}
