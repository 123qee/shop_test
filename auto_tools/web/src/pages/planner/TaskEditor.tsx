import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { addDays, plannerToday, type PersonalProject, type PersonalTask, type TaskInput } from '@shared/planner';
import { PlannerIcon as Icon } from './PlannerIcon';

const statuses = { todo: '待办', doing: '进行中', waiting: '等待中', done: '已完成' };
const priorities = { high: '高优先级', medium: '中优先级', low: '低优先级' };
const repeats = { none: '不重复', daily: '每天', weekdays: '每个工作日', weekly: '每周' };
const blankTask: TaskInput = { title: '', description: '', projectId: null, status: 'todo', priority: 'medium', dueDate: null, repeat: 'none', checklist: [], archived: false };

interface TaskEditorProps {
  initial: Partial<PersonalTask>; projects: PersonalProject[]; readOnly: boolean;
  onClose: () => void; onSave: (input: TaskInput) => Promise<void>; onArchive?: () => Promise<void>;
}

export function TaskEditor({ initial, projects, readOnly, onClose, onSave, onArchive }: TaskEditorProps) {
  const [form, setForm] = useState<TaskInput>({ ...blankTask, ...initial });
  const [newStep, setNewStep] = useState('');
  const [showSteps, setShowSteps] = useState(!!initial.checklist?.length);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const stepsId = useId();
  const today = plannerToday();
  const selectedProject = projects.find(project => project.id === form.projectId);
  const dateLabel = !form.dueDate ? '截止日期' : form.dueDate === today ? '今天' : form.dueDate === addDays(today, 1) ? '明天' : form.dueDate.slice(5).replace('-', '/');

  useEffect(() => {
    const dialog = dialogRef.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    if (!readOnly) titleRef.current?.focus();
    return () => { dialog.close(); previous?.focus(); };
  }, []);

  function changeDate(value: string) { setForm(current => ({ ...current, dueDate: value || null })); }
  function addStep() {
    if (!newStep.trim() || form.checklist.length >= 100) return;
    setForm(current => ({ ...current, checklist: [...current.checklist, { id: crypto.randomUUID(), title: newStep.trim(), done: false }] }));
    setNewStep('');
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || readOnly || !form.title.trim()) return;
    if (form.repeat !== 'none' && !form.dueDate) { setError('请为重复任务设置执行日期'); return; }
    setBusy(true); setError('');
    try {
      const { title, description, projectId, status, priority, dueDate, repeat, checklist, archived } = form;
      await onSave({ title: title.trim(), description, projectId, status, priority, dueDate, repeat, checklist: newStep.trim() && checklist.length < 100 ? [...checklist, { id: crypto.randomUUID(), title: newStep.trim(), done: false }] : checklist, archived });
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function archive() {
    if (!onArchive || busy) return;
    setBusy(true); setError('');
    try { await onArchive(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }

  return <dialog ref={dialogRef} className={`planner pl-task-composer${expanded ? ' is-expanded' : ''}`} aria-labelledby={headingId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClick={event => {
    if (event.target !== event.currentTarget || busy) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }}>
    <header className="pl-composer-header">
      <div><span>{selectedProject?.name ?? '个人任务'}</span><span className="pl-composer-separator">›</span><h2 id={headingId}>{initial.id ? '编辑任务' : '新建任务'}</h2></div>
      <div className="pl-composer-window-actions"><button type="button" className="pl-icon-button" disabled={busy} aria-label={expanded ? '还原弹窗' : '放大弹窗'} aria-pressed={expanded} onClick={() => setExpanded(value => !value)}><Icon name={expanded ? 'collapse' : 'expand'} size={16}/></button><button type="button" className="pl-icon-button" disabled={busy} aria-label="关闭任务编辑器" onClick={onClose}><Icon name="close" size={17}/></button></div>
    </header>
    <form className="pl-composer-form" onSubmit={save} onKeyDown={event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy && !readOnly) event.currentTarget.requestSubmit(); }
    }}>
      <fieldset className="pl-composer-body" disabled={busy || readOnly}>
        <input ref={titleRef} className="pl-composer-title" aria-label="任务标题" required maxLength={200} placeholder="任务标题" value={form.title} onChange={event => setForm(current => ({ ...current, title: event.target.value }))}/>
        <textarea className="pl-composer-description" aria-label="任务描述" maxLength={20000} placeholder="添加描述…" value={form.description} onChange={event => setForm(current => ({ ...current, description: event.target.value }))}/>
        {showSteps && <section className="pl-composer-steps" id={stepsId} aria-label="子步骤">
          <header><span>子步骤</span><small>{form.checklist.filter(step => step.done).length} / {form.checklist.length}</small></header>
          {form.checklist.map(step => <div className="pl-composer-step" key={step.id}><input type="checkbox" aria-label={`完成步骤：${step.title}`} checked={step.done} onChange={event => { const done = event.target.checked; setForm(current => ({ ...current, checklist: current.checklist.map(item => item.id === step.id ? { ...item, done } : item) })); }}/><input aria-label="步骤名称" required maxLength={200} value={step.title} onChange={event => { const title = event.target.value; setForm(current => ({ ...current, checklist: current.checklist.map(item => item.id === step.id ? { ...item, title } : item) })); }}/><button type="button" className="pl-icon-button" aria-label={`移除步骤：${step.title}`} onClick={() => setForm(current => ({ ...current, checklist: current.checklist.filter(item => item.id !== step.id) }))}><Icon name="close" size={13}/></button></div>)}
          {form.checklist.length < 100 && <div className="pl-composer-add-step"><Icon name="plus" size={14}/><input aria-label="添加子步骤" maxLength={200} placeholder="添加一个小步骤…" value={newStep} onChange={event => setNewStep(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) { event.preventDefault(); addStep(); } }}/><button type="button" disabled={!newStep.trim()} onClick={addStep}>添加</button></div>}
        </section>}
      </fieldset>
      <fieldset className="pl-composer-properties" disabled={busy || readOnly}>
        <label className="pl-composer-chip"><span className={`pl-state-dot ${form.status}`}/><select aria-label="状态" value={form.status} onChange={event => setForm(current => ({ ...current, status: event.target.value as TaskInput['status'] }))}>{Object.entries(statuses).filter(([key]) => key !== 'done' || form.repeat === 'none').map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="pl-composer-chip"><Icon name="list" size={14}/><select aria-label="优先级" value={form.priority} onChange={event => setForm(current => ({ ...current, priority: event.target.value as TaskInput['priority'] }))}>{Object.entries(priorities).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="pl-composer-chip pl-composer-project"><Icon name="folder" size={14}/><select aria-label="所属项目" value={form.projectId ?? ''} onChange={event => setForm(current => ({ ...current, projectId: event.target.value || null }))}><option value="">无项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <Popover.Root><Popover.Trigger asChild><button className={`pl-composer-chip${form.dueDate ? ' is-set' : ''}`} type="button" disabled={busy || readOnly} aria-label="设置任务日期"><Icon name="calendar" size={14}/>{dateLabel}</button></Popover.Trigger><Popover.Content className="planner pl-composer-date-panel" align="start" side="top" sideOffset={8} collisionPadding={16} aria-label="设置任务日期">
          <label>{form.repeat === 'none' ? '截止日期' : '下次执行日期'}<input type="date" aria-label={form.repeat === 'none' ? '截止日期' : '下次执行日期'} value={form.dueDate ?? ''} onChange={event => changeDate(event.target.value)} onBlur={event => changeDate(event.currentTarget.value)}/></label>
          <div className="pl-composer-date-shortcuts"><Popover.Close asChild><button type="button" onClick={() => changeDate(today)}>今天</button></Popover.Close><Popover.Close asChild><button type="button" onClick={() => changeDate(addDays(today, 1))}>明天</button></Popover.Close><Popover.Close asChild><button type="button" disabled={form.repeat !== 'none'} onClick={() => changeDate('')}>清除日期</button></Popover.Close></div>
          <Popover.Close asChild><button type="button" className="pl-composer-date-done">确定</button></Popover.Close>
        </Popover.Content></Popover.Root>
        <label className="pl-composer-chip"><Icon name="repeat" size={14}/><select aria-label="重复频率" value={form.repeat} onChange={event => { const repeat = event.target.value as TaskInput['repeat']; setForm(current => ({ ...current, repeat, dueDate: repeat === 'none' ? current.dueDate : current.dueDate ?? today, status: repeat !== 'none' && current.status === 'done' ? 'todo' : current.status })); }}>{Object.entries(repeats).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <button className={`pl-composer-chip${showSteps ? ' is-set' : ''}`} type="button" aria-expanded={showSteps} aria-controls={stepsId} onClick={() => setShowSteps(value => !value)}><Icon name="tasks" size={14}/>子步骤{form.checklist.length > 0 && <small>{form.checklist.length}</small>}</button>
      </fieldset>
      {form.repeat !== 'none' && <p className="pl-composer-note"><Icon name="repeat" size={12}/>完成后自动安排下一次，子步骤会重置。{initial.completionCount ? `已累计打卡 ${initial.completionCount} 次。` : ''}</p>}
      {readOnly && <p className="pl-composer-error">请先恢复所属项目，再编辑任务。</p>}
      {error && <p className="pl-composer-error" role="alert">{error}</p>}
      <footer className="pl-composer-footer">
        {onArchive && !readOnly && <button type="button" className="pl-composer-archive" disabled={busy} onClick={() => void archive()}><Icon name="archive" size={14}/>{initial.archived ? '恢复任务' : '归档任务'}</button>}
        <span/>
        <button type="button" className="pl-composer-cancel" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="pl-composer-submit" disabled={busy || readOnly || !form.title.trim()}>{busy ? '保存中…' : initial.id ? '保存任务' : '创建任务'}<kbd>⌘ ↵</kbd></button>
      </footer>
    </form>
  </dialog>;
}
