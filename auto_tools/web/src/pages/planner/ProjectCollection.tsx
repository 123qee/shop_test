import { Link, useNavigate } from 'react-router-dom';
import * as Popover from '@radix-ui/react-popover';
import type { PersonalProject, PersonalTask, ProjectInput } from '@shared/planner';
import { PlannerIcon as Icon } from './PlannerIcon';
import { categories, projectStatuses, progress, projectDate } from './project-utils';

interface ProjectCollectionProps {
  projects: PersonalProject[]; tasks: PersonalTask[]; today: string; view: 'list' | 'grid'; busyIds: string[];
  onUpdate: (project: PersonalProject, patch: Partial<ProjectInput>) => void;
  onEdit: (project: PersonalProject) => void;
}

function ProjectActions({ project, busy, onEdit, onUpdate }: { project: PersonalProject; busy: boolean; onEdit: () => void; onUpdate: (patch: Partial<ProjectInput>) => void }) {
  return <Popover.Root><Popover.Trigger asChild><button type="button" className="pl-project-more" disabled={busy} aria-label={`项目操作：${project.name}`}><Icon name="more" size={17}/></button></Popover.Trigger><Popover.Portal><Popover.Content className="planner pl-project-menu" align="end" sideOffset={5} collisionPadding={12} aria-label="项目操作">
    <Popover.Close asChild><button type="button" onClick={onEdit}><Icon name="edit" size={14}/>编辑项目</button></Popover.Close>
    <Popover.Close asChild><button type="button" onClick={() => onUpdate({ favorite: !project.favorite })}><Icon name="star" size={14}/>{project.favorite ? '取消星标' : '添加星标'}</button></Popover.Close>
    <Popover.Close asChild><button type="button" onClick={() => onUpdate({ archived: !project.archived })}><Icon name="archive" size={14}/>{project.archived ? '恢复项目' : '归档项目'}</button></Popover.Close>
  </Popover.Content></Popover.Portal></Popover.Root>;
}

export function ProjectCollection({ projects, tasks, today, view, busyIds, onUpdate, onEdit }: ProjectCollectionProps) {
  const navigate = useNavigate();
  function contents(project: PersonalProject) {
    const items = tasks.filter(task => task.projectId === project.id && !task.archived);
    return { ...progress(items), routines: items.filter(task => task.repeat !== 'none').length };
  }
  function star(project: PersonalProject, busy: boolean) {
    return <button type="button" className={`pl-project-favorite${project.favorite ? ' on' : ''}`} aria-label={`${project.favorite ? '取消星标' : '星标'}${project.name}`} aria-pressed={project.favorite} disabled={busy} onClick={() => onUpdate(project, { favorite: !project.favorite })}><Icon name="star" size={14}/></button>;
  }
  function status(project: PersonalProject, busy: boolean) {
    return <label className={`pl-project-inline-state pl-project-status-${project.status}`}><span/><select aria-label={`${project.name}的状态`} value={project.status} disabled={busy || project.archived} onChange={event => onUpdate(project, { status: event.target.value as ProjectInput['status'] })}>{Object.entries(projectStatuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>;
  }
  if (view === 'grid') return <div className="pl-compact-project-grid">{projects.map(project => {
    const summary = contents(project);
    const busy = busyIds.includes(project.id);
    return <article key={project.id} className={`pl-compact-project-card pl-color-${project.color}`}>
      <div className="pl-compact-project-top"><span className="pl-project-small-icon"><Icon name={project.icon} size={19}/></span><span>{categories[project.category]}</span><div>{star(project, busy)}<ProjectActions project={project} busy={busy} onEdit={() => onEdit(project)} onUpdate={patch => onUpdate(project, patch)}/></div></div>
      <Link className="pl-compact-project-name" to={`/projects/${project.id}`}>{project.name}</Link>
      {project.description && <p>{project.description}</p>}
      <div className="pl-compact-project-progress"><span>{summary.total ? `${summary.done} / ${summary.total} 件任务` : '暂无任务'}</span>{summary.routines > 0 && <span><Icon name="repeat" size={12}/>{summary.routines} 个日常</span>}<b>{summary.total > 0 ? `${summary.percent}%` : ''}</b></div>
      <div className="pl-progress"><i style={{ width: `${summary.percent}%` }}/></div>
      <footer>{status(project, busy)}<span><Icon name="calendar" size={12}/>{projectDate(project.targetDate, today)}</span>{project.archived && <button type="button" className="pl-text-button" disabled={busy} onClick={() => onUpdate(project, { archived: false })}>恢复</button>}</footer>
    </article>;
  })}</div>;
  return <div className="pl-project-table-wrap"><table className="pl-project-table" aria-label="项目列表"><thead><tr><th>名称</th><th>状态</th><th>分类</th><th>进度</th><th>目标日期</th><th>更新时间</th><th><span className="pl-visually-hidden">操作</span></th></tr></thead><tbody>{projects.map(project => {
    const summary = contents(project);
    const busy = busyIds.includes(project.id);
    return <tr key={project.id} onClick={event => { if (!(event.target as HTMLElement).closest('a,button,select,input,label')) navigate(`/projects/${project.id}`); }}>
      <td><div className="pl-project-name-cell"><Link to={`/projects/${project.id}`} title={project.description || project.name}><Icon name={project.icon} size={17}/><span>{project.name}</span></Link>{star(project, busy)}</div></td>
      <td>{status(project, busy)}</td>
      <td><span className="pl-project-table-category">{categories[project.category]}</span></td>
      <td><div className="pl-project-table-progress" title={summary.total ? `${summary.percent}% · 只计算一次性任务` : '还没有一次性任务'}><span className="pl-table-progress-track"><i style={{ width: `${summary.percent}%` }}/></span><span>{summary.total ? `${summary.done} / ${summary.total}` : '—'}</span>{summary.routines > 0 && <small title={`${summary.routines} 个重复日常`}><Icon name="repeat" size={11}/>{summary.routines}</small>}</div></td>
      <td><span className={project.targetDate && project.targetDate < today && project.status !== 'completed' ? 'pl-project-date-overdue' : ''}>{projectDate(project.targetDate, today)}</span></td>
      <td><time dateTime={project.updatedAt} title={new Date(project.updatedAt).toLocaleString('zh-CN')}>{projectDate(project.updatedAt, today)}</time></td>
      <td><div className="pl-project-row-actions">{project.archived && <button type="button" className="pl-text-button" disabled={busy} onClick={() => onUpdate(project, { archived: false })}>恢复</button>}<ProjectActions project={project} busy={busy} onEdit={() => onEdit(project)} onUpdate={patch => onUpdate(project, patch)}/></div></td>
    </tr>;
  })}</tbody></table></div>;
}
