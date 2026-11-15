import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { addDays, plannerToday, type PersonalProject, type PersonalTask, type PlannerData, type ProjectInput, type TaskInput, type TaskStatus } from '@shared/planner';
import { api } from '../../api';
import { showFeedback } from '../../feedback';
import { PlannerIcon as Icon } from './PlannerIcon';
import './planner.css';
import { TaskToolbar } from './TaskToolbar';
import { TaskBoard } from './TaskBoard';
import { TaskEditor } from './TaskEditor';
import { ProjectToolbar } from './ProjectToolbar';
import { ProjectCollection } from './ProjectCollection';
import { categories, projectStatuses, progress, type ProjectSort } from './project-utils';

const statuses = { todo: '待办', doing: '进行中', waiting: '等待中', done: '已完成' };
const priorities = { high: '高优先级', medium: '中优先级', low: '低优先级' };
const repeats = { none: '不重复', daily: '每天', weekdays: '每个工作日', weekly: '每周' };
const colors = ['violet', 'blue', 'amber', 'green', 'rose'];
const blankProject: ProjectInput = { name: '', description: '', category: 'life', icon: 'folder', color: 'violet', status: 'active', targetDate: null, favorite: false, archived: false };
function dateLabel(date: string | null, today: string, showOverdue = true) {
  if (!date) return '未设日期';
  if (date === today) return '今天';
  if (date === addDays(today, 1)) return '明天';
  const d = new Date(`${date}T12:00:00Z`);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日${showOverdue && date < today ? ' · 逾期' : ''}`;
}
function projectTasks(data: PlannerData, id: string) { return data.tasks.filter(t => t.projectId === id && !t.archived); }
function sortTasks(tasks: PersonalTask[]) {
  const weight = { high: 0, medium: 1, low: 2 };
  return [...tasks].sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || weight[a.priority] - weight[b.priority] || b.createdAt.localeCompare(a.createdAt));
}

export function PlannerPage({ mode }: { mode: 'projects' | 'tasks' }) {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<PlannerData>({ projects: [], tasks: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [projectFilter, setProjectFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [layout, setLayout] = useState<'list' | 'board'>('board');
  const [projectLayout, setProjectLayout] = useState<'grid' | 'list'>('list');
  const [projectSort, setProjectSort] = useState<ProjectSort>('created');
  const [projectStatusFilter, setProjectStatusFilter] = useState('all');
  const [busyProjectIds, setBusyProjectIds] = useState<string[]>([]);
  const [projectEditor, setProjectEditor] = useState<Partial<PersonalProject> | null>(null);
  const [taskEditor, setTaskEditor] = useState<Partial<PersonalTask> | null>(null);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [quickTitle, setQuickTitle] = useState('');
  const [quickBusy, setQuickBusy] = useState(false);
  const today = plannerToday();
  const scope = params.get('scope') || 'all';
  const selectedProject = data.projects.find(p => p.id === projectId);
  const activeProjects = data.projects.filter(p => !p.archived);
  const visibleTasks = data.tasks.filter(t => !t.archived && (!t.projectId || t.projectId === projectId || activeProjects.some(p => p.id === t.projectId)));

  const load = useCallback(async () => {
    setError('');
    try { setData(await api.planner()); } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSearch(''); setProjectFilter('all'); setPriorityFilter('all'); }, [mode, projectId]);
  useEffect(() => {
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  function storeProject(project: PersonalProject) {
    setData(current => ({ ...current, projects: [...current.projects.filter(p => p.id !== project.id), project] }));
  }
  function storeTask(task: PersonalTask) {
    setData(current => ({ ...current, tasks: [task, ...current.tasks.filter(t => t.id !== task.id)] }));
  }
  async function updateProject(project: PersonalProject, patch: Partial<ProjectInput>) {
    if (busyProjectIds.includes(project.id)) return;
    setBusyProjectIds(ids => [...ids, project.id]);
    try { storeProject(await api.updatePersonalProject(project.id, patch)); showFeedback(patch.archived === true ? '项目已归档，可在已归档中恢复' : patch.archived === false ? '项目已恢复' : '项目已更新'); }
    catch (e) { showFeedback((e as Error).message, 'error'); }
    finally { setBusyProjectIds(ids => ids.filter(id => id !== project.id)); }
  }
  async function updateTask(task: PersonalTask, patch: Partial<TaskInput>) {
    if (busyIds.includes(task.id)) return;
    setBusyIds(ids => [...ids, task.id]);
    try { storeTask(await api.updatePersonalTask(task.id, patch)); }
    catch (e) { showFeedback((e as Error).message, 'error'); }
    finally { setBusyIds(ids => ids.filter(id => id !== task.id)); }
  }
  async function complete(task: PersonalTask) {
    if (busyIds.includes(task.id)) return;
    setBusyIds(ids => [...ids, task.id]);
    try {
      const saved = task.status === 'done' ? await api.updatePersonalTask(task.id, { status: 'todo' }) : await api.completePersonalTask(task);
      storeTask(saved);
      showFeedback(task.status === 'done' ? '任务已重新打开' : task.repeat === 'none' ? '完成一件事，向前一步！' : `打卡成功，下次：${dateLabel(saved.dueDate, today)}`);
    } catch (e) { showFeedback((e as Error).message, 'error'); }
    finally { setBusyIds(ids => ids.filter(id => id !== task.id)); }
  }
  function newTask(status: TaskStatus = 'todo') {
    setTaskEditor({ projectId: projectId ?? (projectFilter !== 'all' && projectFilter !== 'inbox' ? projectFilter : null), status, dueDate: ['today', 'week'].includes(scope) ? today : null });
  }
  async function quickAdd(event: FormEvent) {
    event.preventDefault();
    if (!quickTitle.trim() || quickBusy) return;
    setQuickBusy(true);
    try {
      storeTask(await api.createPersonalTask({ title: quickTitle.trim(), projectId: projectId ?? (projectFilter !== 'all' && projectFilter !== 'inbox' ? projectFilter : null), dueDate: ['today', 'week'].includes(scope) ? today : null }));
      if (['done', 'routines', 'overdue'].includes(scope)) setParams({});
      setQuickTitle(''); showFeedback('任务已添加');
    } catch (e) { showFeedback((e as Error).message, 'error'); }
    finally { setQuickBusy(false); }
  }

  const projects = data.projects.filter(p => (scope === 'archived' ? p.archived : !p.archived)
    && (category === 'all' || p.category === category) && (projectStatusFilter === 'all' || p.status === projectStatusFilter) && (scope !== 'favorites' || p.favorite)
    && (scope !== 'completed' || p.status === 'completed')
    && `${p.name} ${p.description}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const pinned = Number(b.favorite) - Number(a.favorite);
      if (pinned) return pinned;
      if (projectSort === 'name') return a.name.localeCompare(b.name, 'zh-CN');
      if (projectSort === 'updated') return b.updatedAt.localeCompare(a.updatedAt);
      if (projectSort === 'progress') return progress(projectTasks(data, b.id)).percent - progress(projectTasks(data, a.id)).percent || a.name.localeCompare(b.name, 'zh-CN');
      return b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name, 'zh-CN');
    });
  let tasks = (scope === 'archived' ? data.tasks.filter(t => t.archived && (!t.projectId || t.projectId === projectId || activeProjects.some(p => p.id === t.projectId))) : visibleTasks)
    .filter(t => (!projectId || t.projectId === projectId) && (projectFilter === 'all' || (projectFilter === 'inbox' ? !t.projectId : t.projectId === projectFilter))
      && (priorityFilter === 'all' || t.priority === priorityFilter)
      && `${t.title} ${t.description}`.toLowerCase().includes(search.toLowerCase()));
  tasks = tasks.filter(t => {
    if (scope === 'done') return t.status === 'done';
    if (scope === 'today') return t.status !== 'done' && t.dueDate && t.dueDate <= today;
    if (scope === 'week') return t.status !== 'done' && t.dueDate && t.dueDate >= today && t.dueDate <= addDays(today, 6);
    if (scope === 'overdue') return t.status !== 'done' && t.dueDate && t.dueDate < today;
    if (scope === 'routines') return t.repeat !== 'none' && t.status !== 'done';
    return true;
  });
  tasks = sortTasks(tasks);
  const isProjects = mode === 'projects' && !projectId;
  const compactTasks = mode === 'tasks';
  const compactRoot = compactTasks || isProjects;
  const isArchivedProject = selectedProject?.archived;
  const detailTasks = projectId ? projectTasks(data, projectId) : [];
  const projectProgress = progress(detailTasks);
  const tasksEditable = scope !== 'archived' && !isArchivedProject;
  const taskGroups = Object.keys(statuses) as TaskStatus[];

  return <div className={`planner${compactTasks ? ' pl-task-workspace' : isProjects ? ' pl-project-workspace' : ''}`}>
    {!compactRoot && <div className="pl-breadcrumb"><Icon name="folder" size={15}/><span>个人空间</span><span>/</span>
      {projectId ? <><Link to="/projects">我的项目</Link><span>/</span><span>{selectedProject?.name ?? '项目详情'}</span></> : <span>{isProjects ? '我的项目' : '我的任务'}</span>}
      <span className="pl-saved"><span/>数据保存在本地服务</span>
    </div>}
    {loading ? <div className="pl-loading" role="status">正在整理你的个人空间…</div> : error ? <div className="pl-error" role="alert"><strong>暂时无法加载个人空间</strong><p>{error}</p><button onClick={() => { setLoading(true); void load(); }}>重新加载</button></div> : projectId && !selectedProject ? <Empty icon="folder" title="没有找到这个项目" text="项目可能已被移动，请返回项目列表。"><Link to="/projects">返回项目</Link></Empty> : <>
      {projectId && selectedProject && <>
        <header className="pl-hero pl-project-hero">
          <div className="pl-hero-copy">
            <div className={`pl-project-title pl-color-${selectedProject.color}`}><span className="pl-project-symbol"><Icon name={selectedProject.icon} size={27}/></span><h2>{selectedProject.name}</h2><span className={`pl-status pl-project-status-${selectedProject.status}`}>{projectStatuses[selectedProject.status]}</span></div>
            {selectedProject.description && <p>{selectedProject.description}</p>}
          </div>
          <div className="pl-hero-actions"><button className="pl-secondary" onClick={() => setProjectEditor(selectedProject)}><Icon name="edit"/>编辑项目</button>
            {isArchivedProject ? <button className="pl-primary" onClick={() => void updateProject(selectedProject, { archived: false })}>恢复项目</button> : <button className="pl-primary" onClick={() => newTask()}><Icon name="plus"/>新建任务</button>}
          </div>
        </header>
        <div className="pl-project-overview">
          <div><span>项目进度 <small>一次性任务</small></span><strong>{projectProgress.percent}<small>%</small></strong><div className="pl-progress"><i style={{ width: `${projectProgress.percent}%` }}/></div></div>
          <div><span>待完成任务</span><strong>{detailTasks.filter(task => task.status !== 'done' && task.repeat === 'none').length}</strong><small>{projectProgress.done} 件已完成</small></div>
          <div><span>重复日常</span><strong>{detailTasks.filter(task => task.repeat !== 'none').length}</strong><small>独立打卡，不计入完成率</small></div>
          <div><span>目标日期</span><strong className="pl-date-value">{dateLabel(selectedProject.targetDate, today)}</strong></div>
        </div>
      </>}

      <section className="pl-content" aria-label={isProjects ? '项目管理' : '任务管理'}>
        {compactTasks ? <TaskToolbar search={search} onSearch={setSearch} scope={scope} onScope={value => setParams(value === 'all' ? {} : { scope: value })} project={projectFilter} onProject={setProjectFilter} priority={priorityFilter} onPriority={setPriorityFilter} projects={activeProjects} view={layout} onView={setLayout} onNew={() => newTask()}/> : isProjects ? <ProjectToolbar search={search} onSearch={setSearch} scope={scope} onScope={value => setParams(value === 'all' ? {} : { scope: value })} category={category} onCategory={setCategory} status={projectStatusFilter} onStatus={setProjectStatusFilter} sort={projectSort} onSort={setProjectSort} view={projectLayout} onView={setProjectLayout} onNew={() => setProjectEditor({})}/> : <>
        <div className="pl-content-heading"><h3>项目任务<span>{tasks.length}</span></h3>
          <div className="pl-view-switch" aria-label="切换视图"><button className={layout === 'list' ? 'selected' : ''} aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><Icon name="list" size={16}/>列表</button><button className={layout === 'board' ? 'selected' : ''} aria-pressed={layout === 'board'} onClick={() => setLayout('board')}><Icon name="board" size={16}/>看板</button></div>
        </div>
        <div className="pl-tabs" role="tablist" aria-label="任务范围">{[['all', '全部任务'], ['today', '今日计划'], ['week', '未来 7 天'], ['routines', '重复日常'], ['done', '已完成'], ['archived', '已归档']].map(([key, label]) => <button role="tab" aria-selected={scope === key} key={key} className={scope === key ? 'selected' : ''} onClick={() => setParams(key === 'all' ? {} : { scope: key })}>{label}</button>)}</div>
        <div className="pl-toolbar">
          <label className="pl-search"><Icon name="search" size={17}/><input aria-label="搜索任务" placeholder="搜索任务…" value={search} onChange={event => setSearch(event.target.value)}/>{search && <button aria-label="清空搜索" onClick={() => setSearch('')}><Icon name="close" size={13}/></button>}</label>
          <select aria-label="筛选优先级" value={priorityFilter} onChange={event => setPriorityFilter(event.target.value)}><option value="all">全部优先级</option>{Object.entries(priorities).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        </div>
        </>}
        {isArchivedProject ? <div className="pl-archive-notice"><Icon name="archive"/>这个项目已归档，任务被妥善保留。恢复项目后可以继续管理。</div> : null}
        {isProjects ? <>
          {projects.length > 0 ? <ProjectCollection projects={projects} tasks={data.tasks} today={today} view={projectLayout} busyIds={busyProjectIds} onUpdate={(project, patch) => void updateProject(project, patch)} onEdit={setProjectEditor}/>
            : <Empty icon="folder" title="暂无项目" text={search || category !== 'all' || projectStatusFilter !== 'all' ? '当前筛选下没有项目，试着调整条件。' : scope === 'archived' ? '归档的项目会保留在这里，可以随时恢复。' : scope === 'favorites' ? '点击项目旁的星标，将常用项目放在这里。' : '点击新建项目，开始整理任务。'}/>}
        </> : <>
          {tasksEditable && layout === 'list' && <form className="pl-quick-add" onSubmit={quickAdd}><Icon name="plus"/><input aria-label="快速添加任务" placeholder="记下一件要做的事，按 Enter 添加…" value={quickTitle} onChange={e => setQuickTitle(e.target.value)} maxLength={200}/><button type="submit" disabled={quickBusy || !quickTitle.trim()}>{quickBusy ? '添加中…' : '添加任务'}</button></form>}
          {layout === 'board' && scope !== 'archived' ? <TaskBoard tasks={tasks} projects={data.projects} today={today} editable={!!tasksEditable} busyIds={busyIds} onNew={newTask} onOpen={setTaskEditor} onComplete={task => void complete(task)} onMove={(task, status) => status === 'done' ? void complete(task) : void updateTask(task, { status })}/>
          : tasks.length > 0 ? <div className="pl-task-list">{taskGroups.filter(status => tasks.some(t => t.status === status)).map(status => <section className="pl-task-group" key={status}><h4><span className={`pl-state-dot ${status}`}/>{statuses[status]}<span>{tasks.filter(t => t.status === status).length}</span></h4>{tasks.filter(t => t.status === status).map(task => <div className={`pl-task-row ${task.status === 'done' ? 'is-done' : ''}`} key={task.id}><button className={`pl-check ${task.status === 'done' ? 'checked' : ''}`} aria-label={`${task.status === 'done' ? '重新打开' : '完成'}：${task.title}`} disabled={!tasksEditable || busyIds.includes(task.id)} onClick={() => void complete(task)}>{task.status === 'done' && <Icon name="check" size={12}/>}</button><button className="pl-task-title" onClick={() => setTaskEditor(task)}>{task.title}{task.checklist.length > 0 && <small>{task.checklist.filter(c => c.done).length}/{task.checklist.length}</small>}</button><TaskMeta task={task} project={data.projects.find(p => p.id === task.projectId)} today={today}/>{scope === 'archived' ? <button className="pl-text-button" onClick={() => void updateTask(task, { archived: false })}>恢复</button> : <select className="pl-inline-status" aria-label={`${task.title}的状态`} value={task.status} disabled={busyIds.includes(task.id) || !tasksEditable} onChange={e => e.target.value === 'done' ? void complete(task) : void updateTask(task, { status: e.target.value as TaskStatus })}>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>}</div>)}</section>)}</div>
          : <Empty icon={scope === 'done' ? 'check' : scope === 'routines' ? 'repeat' : 'tasks'} title={scope === 'today' ? '今天没有待办任务' : scope === 'done' ? '暂无已完成任务' : scope === 'routines' ? '暂无重复任务' : '暂无任务'} text={search || projectFilter !== 'all' || priorityFilter !== 'all' ? '当前筛选下没有任务，试着调整条件。' : scope === 'routines' ? '新建任务时设置重复频率，比如每天练琴 30 分钟。' : scope === 'archived' ? '归档的任务会保留在这里。' : '点击新建任务，或调整筛选条件。'}/>
          }
        </>}
      </section>
    </>}
    {projectEditor && <ProjectEditor initial={projectEditor} onClose={() => setProjectEditor(null)} onSave={async input => { const saved = projectEditor.id ? await api.updatePersonalProject(projectEditor.id, input) : await api.createPersonalProject(input); storeProject(saved); if (!projectEditor.id) { setParams({}); setSearch(''); setCategory('all'); setProjectStatusFilter('all'); } setProjectEditor(null); showFeedback(projectEditor.id ? '项目已保存' : '新项目已创建，开始第一步吧'); }} onArchive={projectEditor.id ? async () => { const saved = await api.updatePersonalProject(projectEditor.id!, { archived: !projectEditor.archived }); storeProject(saved); setProjectEditor(null); showFeedback(saved.archived ? '项目已归档，任务已保留' : '项目已恢复'); if (projectId && saved.archived) navigate('/projects'); } : undefined}/>}
    {taskEditor && <TaskEditor initial={taskEditor} projects={activeProjects} readOnly={!!taskEditor.projectId && !!data.projects.find(p => p.id === taskEditor.projectId)?.archived} onClose={() => setTaskEditor(null)} onSave={async input => { const saved = taskEditor.id ? await api.updatePersonalTask(taskEditor.id, input) : await api.createPersonalTask(input); storeTask(saved); if (!taskEditor.id) { setParams({}); setSearch(''); setProjectFilter('all'); setPriorityFilter('all'); } setTaskEditor(null); showFeedback('任务已保存'); }} onArchive={taskEditor.id ? async () => { const saved = await api.updatePersonalTask(taskEditor.id!, { archived: !taskEditor.archived }); storeTask(saved); setTaskEditor(null); showFeedback(saved.archived ? '任务已归档，可随时恢复' : '任务已恢复'); } : undefined}/>}
  </div>;
}

function Empty({ icon, title, text, children }: { icon: string; title: string; text: string; children?: ReactNode }) {
  return <div className="pl-empty"><span><Icon name={icon} size={27}/></span><h3>{title}</h3><p>{text}</p>{children}</div>;
}
function TaskMeta({ task, project, today }: { task: PersonalTask; project?: PersonalProject; today: string }) {
  return <div className="pl-task-meta">{project && <Link className={`pl-project-tag pl-color-${project.color}`} to={`/projects/${project.id}`}><Icon name={project.icon} size={12}/>{project.name}</Link>}{task.repeat !== 'none' && <span className="pl-repeat-tag" title={`累计打卡 ${task.completionCount} 次`}><Icon name="repeat" size={12}/>{repeats[task.repeat]}</span>}<span className={`pl-due ${task.dueDate && task.dueDate < today && task.status !== 'done' ? 'overdue' : task.dueDate === today ? 'today' : ''}`}><Icon name="calendar" size={13}/>{dateLabel(task.dueDate, today, task.status !== 'done')}</span><span className={`pl-priority-dot ${task.priority}`} title={priorities[task.priority]} aria-label={priorities[task.priority]}/></div>;
}

function Modal({ title, subtitle, children, onClose }: { title: string; subtitle: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { const dialog = ref.current!; const previous = document.activeElement as HTMLElement | null; dialog.showModal(); dialog.querySelector<HTMLInputElement>('input:not([type=checkbox])')?.focus(); return () => { dialog.close(); previous?.focus(); }; }, []);
  return <dialog ref={ref} aria-labelledby={titleId} className="pl-modal planner" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) { const rect = e.currentTarget.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose(); } }}><header><div><h2 id={titleId}>{title}</h2><p>{subtitle}</p></div><button type="button" className="pl-icon-button" onClick={onClose} aria-label="关闭编辑器"><Icon name="close" size={20}/></button></header>{children}</dialog>;
}
function ProjectEditor({ initial, onClose, onSave, onArchive }: { initial: Partial<PersonalProject>; onClose: () => void; onSave: (input: ProjectInput) => Promise<void>; onArchive?: () => Promise<void> }) {
  const [form, setForm] = useState<ProjectInput>({ ...blankProject, ...initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { const { name, description, category, icon, color, status, targetDate, favorite, archived } = form; await onSave({ name, description, category, icon, color, status, targetDate, favorite, archived }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <Modal title={initial.id ? '编辑项目' : '开启一个新项目'} subtitle="为一个目标，或一种生活，留一个专属空间。" onClose={onClose}><form onSubmit={save} className="pl-editor-form"><div className="pl-identity"><span className={`pl-project-symbol pl-color-${form.color}`}><Icon name={form.icon} size={29}/></span><div><label>项目图标</label><div className="pl-icon-options">{['folder', 'shop', 'piano', 'leaf', 'sun'].map(icon => <button type="button" className={form.icon === icon ? 'selected' : ''} aria-label={`图标：${icon}`} aria-pressed={form.icon === icon} onClick={() => setForm({ ...form, icon })} key={icon}><Icon name={icon} size={18}/></button>)}</div></div></div>
    <label>项目名称 <span>*</span><input autoFocus required maxLength={100} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="比如：美客多平台、钢琴日常"/></label>
    <label>项目描述<textarea rows={3} maxLength={10000} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="想通过这个项目做到什么？"/></label>
    <div className="pl-form-grid"><label>分类<select value={form.category} onChange={e => setForm({ ...form, category: e.target.value as ProjectInput['category'] })}>{Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>状态<select value={form.status} onChange={e => setForm({ ...form, status: e.target.value as ProjectInput['status'] })}>{Object.entries(projectStatuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
    <div className="pl-form-grid"><label>目标日期 <small>可选</small><input type="date" value={form.targetDate ?? ''} onChange={e => setForm({ ...form, targetDate: e.target.value || null })} onBlur={e => { const targetDate = e.currentTarget.value || null; setForm(current => ({ ...current, targetDate })); }}/></label><div><label>主题颜色</label><div className="pl-color-options">{colors.map(color => <button key={color} type="button" className={`pl-color-${color} ${form.color === color ? 'selected' : ''}`} aria-label={`颜色：${color}`} aria-pressed={form.color === color} onClick={() => setForm({ ...form, color })}>{form.color === color && <Icon name="check" size={15}/>}</button>)}</div></div></div>
    {error && <p role="alert" className="pl-form-error">{error}</p>}<footer className="pl-form-footer">{onArchive && <button type="button" className="pl-text-button" disabled={busy} onClick={async () => { setBusy(true); try { await onArchive(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><Icon name="archive" size={15}/>{initial.archived ? '恢复项目' : '归档项目'}</button>}<span/><button type="button" className="pl-secondary" onClick={onClose}>取消</button><button type="submit" className="pl-primary" disabled={busy || !form.name.trim()}>{busy ? '保存中…' : initial.id ? '保存项目' : '创建项目'}</button></footer>
  </form></Modal>;
}

