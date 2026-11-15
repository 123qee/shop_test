import { useState } from 'react';
import { Link } from 'react-router-dom';
import * as Popover from '@radix-ui/react-popover';
import type { PersonalProject, PersonalTask, TaskStatus } from '@shared/planner';
import { addDays } from '@shared/planner';
import { PlannerIcon as Icon } from './PlannerIcon';

const statuses: Record<TaskStatus, string> = { todo: '待办', doing: '进行中', waiting: '等待中', done: '已完成' };
const priorities = { high: '高优先级', medium: '中优先级', low: '低优先级' };
function updatedLabel(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  if (minutes < 1) return '刚刚更新';
  if (minutes < 60) return `${minutes} 分钟前更新`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前更新`;
  return `${Math.floor(minutes / 1440)} 天前更新`;
}
function dueLabel(value: string, today: string, completed: boolean) {
  if (value === today) return '今天';
  if (value === addDays(today, 1)) return '明天';
  const date = new Date(`${value}T12:00:00Z`);
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日${value < today && !completed ? ' · 逾期' : ''}`;
}

interface TaskBoardProps {
  tasks: PersonalTask[]; projects: PersonalProject[]; today: string; editable: boolean; busyIds: string[];
  onNew: (status: TaskStatus) => void; onOpen: (task: PersonalTask) => void;
  onComplete: (task: PersonalTask) => void; onMove: (task: PersonalTask, status: TaskStatus) => void;
}

export function TaskBoard({ tasks, projects, today, editable, busyIds, onNew, onOpen, onComplete, onMove }: TaskBoardProps) {
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  return <div className="pl-board pl-simple-board" aria-label="任务看板">
    {(Object.keys(statuses) as TaskStatus[]).map(status => {
      const columnTasks = tasks.filter(task => task.status === status);
      return <section key={status} aria-label={`${statuses[status]}任务`} className={`pl-column pl-column-${status}${dragOver === status ? ' is-drag-over' : ''}`}
        onDragOver={event => { if (editable) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOver(status); } }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(null); }}
        onDrop={event => { event.preventDefault(); setDragOver(null); const task = tasks.find(item => item.id === event.dataTransfer.getData('text/plain')); if (task && task.status !== status && editable && !busyIds.includes(task.id)) onMove(task, status); }}>
        <header className="pl-column-head"><span className={`pl-state-dot ${status}`}/><h4>{statuses[status]}</h4><b>{columnTasks.length}</b>{editable && status !== 'done' && <button type="button" aria-label={`在${statuses[status]}中添加任务`} onClick={() => onNew(status)}><Icon name="plus" size={17}/></button>}</header>
        <div className="pl-column-body">
          {columnTasks.map(task => {
            const project = projects.find(p => p.id === task.projectId);
            const busy = busyIds.includes(task.id);
            return <article className={`pl-task-card${busy ? ' is-busy' : ''}`} key={task.id} draggable={editable && !busy}
              onDragStart={event => { event.dataTransfer.setData('text/plain', task.id); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDragOver(null)}>
              <div className="pl-task-card-top">
                <span className={`pl-board-priority ${task.priority}`}><svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="1" y="9" width="3" height="6" rx=".7"/><rect x="6" y="5" width="3" height="10" rx=".7"/><rect x="11" y="1" width="3" height="14" rx=".7"/></svg>{priorities[task.priority]}</span>
                <div className="pl-board-card-actions">
                  <button type="button" className={`pl-check${task.status === 'done' ? ' checked' : ''}`} aria-label={`${task.status === 'done' ? '重新打开' : '完成'}：${task.title}`} disabled={!editable || busy} onClick={() => onComplete(task)}>{task.status === 'done' && <Icon name="check" size={12}/>}</button>
                  {editable && <Popover.Root><Popover.Trigger asChild><button className="pl-board-more" type="button" disabled={busy} aria-label={`更改状态：${task.title}`}><Icon name="more" size={16}/></button></Popover.Trigger><Popover.Portal><Popover.Content className="planner pl-board-status-menu" align="end" sideOffset={5} collisionPadding={12} aria-label="更改任务状态"><small>移动到</small>{(Object.keys(statuses) as TaskStatus[]).map(next => <Popover.Close asChild key={next}><button type="button" disabled={next === task.status} onClick={() => onMove(task, next)}><span className={`pl-state-dot ${next}`}/>{statuses[next]}{next === task.status && <Icon name="check" size={13}/>}</button></Popover.Close>)}</Popover.Content></Popover.Portal></Popover.Root>}
                </div>
              </div>
              <button type="button" className="pl-task-title pl-board-open" onClick={() => onOpen(task)}>{task.title}</button>
              {project && <div className="pl-board-project"><Link className={`pl-project-tag pl-color-${project.color}`} to={`/projects/${project.id}`}><Icon name={project.icon} size={13}/>{project.name}</Link></div>}
              <footer className="pl-board-card-footer"><div>{task.dueDate && <span className={`pl-due${task.dueDate < today && task.status !== 'done' ? ' overdue' : ''}`}><Icon name="calendar" size={12}/>{dueLabel(task.dueDate, today, task.status === 'done')}</span>}{task.repeat !== 'none' && <span title="重复任务" aria-label="重复任务"><Icon name="repeat" size={12}/></span>}{task.checklist.length > 0 && <span><Icon name="tasks" size={12}/>{task.checklist.filter(step => step.done).length}/{task.checklist.length}</span>}</div><time dateTime={task.updatedAt}>{updatedLabel(task.updatedAt)}</time></footer>
            </article>;
          })}
          {!columnTasks.length && <div className="pl-column-empty">无任务</div>}
        </div>
      </section>;
    })}
  </div>;
}
