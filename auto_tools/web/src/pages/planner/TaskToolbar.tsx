import * as Popover from '@radix-ui/react-popover';
import type { PersonalProject } from '@shared/planner';
import { PlannerIcon as Icon } from './PlannerIcon';

const scopes: Record<string, string> = { all: '全部任务', today: '今天（含逾期）', week: '未来 7 天', overdue: '已逾期', routines: '重复日常', done: '已完成', archived: '已归档' };
const priorities: Record<string, string> = { high: '高优先级', medium: '中优先级', low: '低优先级' };

interface TaskToolbarProps {
  search: string; onSearch: (value: string) => void;
  scope: string; onScope: (value: string) => void;
  project: string; onProject: (value: string) => void;
  priority: string; onPriority: (value: string) => void;
  projects: PersonalProject[];
  view: 'list' | 'board'; onView: (value: 'list' | 'board') => void;
  onNew: () => void;
}

export function TaskToolbar(props: TaskToolbarProps) {
  const { search, onSearch, scope, onScope, project, onProject, priority, onPriority, projects, view, onView, onNew } = props;
  const extraScope = !['all', 'today', 'week'].includes(scope);
  const count = Number(project !== 'all') + Number(priority !== 'all') + Number(extraScope);
  function clear() { onProject('all'); onPriority('all'); onScope('all'); }
  return <>
    <div className="pl-task-toolbar" aria-label="任务工具栏">
      <label className="pl-search"><Icon name="search" size={16}/><input aria-label="搜索任务" placeholder="搜索任务…" value={search} onChange={e => onSearch(e.target.value)}/>{search && <button type="button" aria-label="清空搜索" onClick={() => onSearch('')}><Icon name="close" size={13}/></button>}</label>
      <div className="pl-task-scopes" role="tablist" aria-label="任务范围">{[['all', '全部'], ['today', '今天'], ['week', '未来 7 天']].map(([key, label]) => <button key={key} role="tab" aria-selected={scope === key} onClick={() => onScope(key)}>{label}</button>)}</div>
      <span className="pl-task-toolbar-spacer"/>
      <Popover.Root>
        <Popover.Trigger asChild><button type="button" className={`pl-task-tool-button${count ? ' has-filter' : ''}`}><Icon name="filter" size={15}/>筛选{count > 0 && <b>{count}</b>}</button></Popover.Trigger>
        <Popover.Portal><Popover.Content className="planner pl-task-filter-panel" align="end" sideOffset={7} collisionPadding={12} aria-label="筛选任务">
          <header><strong>筛选任务</strong><button type="button" className="pl-text-button" onClick={clear}>重置</button></header>
          <label>所属项目<select aria-label="筛选所属项目" value={project} onChange={e => onProject(e.target.value)}><option value="all">全部项目</option><option value="inbox">未归属项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label>优先级<select aria-label="筛选优先级" value={priority} onChange={e => onPriority(e.target.value)}><option value="all">全部优先级</option>{Object.entries(priorities).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label>任务范围<select aria-label="筛选任务范围" value={scope} onChange={e => onScope(e.target.value)}>{Object.entries(scopes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <footer><Popover.Close asChild><button className="pl-secondary" type="button">完成</button></Popover.Close></footer>
        </Popover.Content></Popover.Portal>
      </Popover.Root>
      <label className="pl-task-view"><Icon name={scope === 'archived' ? 'list' : view} size={15}/><select aria-label="任务视图" value={scope === 'archived' ? 'list' : view} disabled={scope === 'archived'} onChange={e => onView(e.target.value as 'list' | 'board')}><option value="board">看板</option><option value="list">列表</option></select></label>
      <button type="button" className="pl-task-tool-button pl-task-new" onClick={onNew}><Icon name="plus" size={16}/>新建任务</button>
    </div>
    {count > 0 && <div className="pl-task-filter-chips" aria-label="已应用筛选">
      {project !== 'all' && <button onClick={() => onProject('all')}>{project === 'inbox' ? '未归属项目' : projects.find(p => p.id === project)?.name ?? '所属项目'}<Icon name="close" size={11}/></button>}
      {priority !== 'all' && <button onClick={() => onPriority('all')}>{priorities[priority]}<Icon name="close" size={11}/></button>}
      {extraScope && <button onClick={() => onScope('all')}>{scopes[scope]}<Icon name="close" size={11}/></button>}
      <button className="pl-clear-filters" onClick={clear}>清除筛选</button>
    </div>}
  </>;
}
