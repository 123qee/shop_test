import * as Popover from '@radix-ui/react-popover';
import { PlannerIcon as Icon } from './PlannerIcon';
import { categories, projectStatuses, type ProjectSort } from './project-utils';

interface ProjectToolbarProps {
  search: string; onSearch: (value: string) => void;
  scope: string; onScope: (value: string) => void;
  category: string; onCategory: (value: string) => void;
  status: string; onStatus: (value: string) => void;
  sort: ProjectSort; onSort: (value: ProjectSort) => void;
  view: 'list' | 'grid'; onView: (value: 'list' | 'grid') => void;
  onNew: () => void;
}

export function ProjectToolbar(props: ProjectToolbarProps) {
  const { search, onSearch, scope, onScope, category, onCategory, status, onStatus, sort, onSort, view, onView, onNew } = props;
  const count = Number(category !== 'all') + Number(status !== 'all') + Number(scope === 'completed');
  function clear() { onCategory('all'); onStatus('all'); if (scope === 'completed') onScope('all'); }
  return <>
    <div className="pl-task-toolbar pl-project-toolbar" aria-label="项目工具栏">
      <label className="pl-search"><Icon name="search" size={16}/><input aria-label="搜索项目" placeholder="搜索项目…" value={search} onChange={event => onSearch(event.target.value)}/>{search && <button type="button" aria-label="清空搜索" onClick={() => onSearch('')}><Icon name="close" size={13}/></button>}</label>
      <div className="pl-task-scopes" role="tablist" aria-label="项目范围">{[['all', '全部'], ['favorites', '已星标'], ['archived', '已归档']].map(([key, label]) => <button key={key} role="tab" aria-selected={scope === key} onClick={() => onScope(key)}>{label}</button>)}</div>
      <span className="pl-task-toolbar-spacer"/>
      <Popover.Root><Popover.Trigger asChild><button type="button" className={`pl-task-tool-button${count ? ' has-filter' : ''}`}><Icon name="filter" size={15}/>筛选{count > 0 && <b>{count}</b>}</button></Popover.Trigger><Popover.Portal><Popover.Content className="planner pl-task-filter-panel" align="end" sideOffset={7} collisionPadding={12} aria-label="筛选项目">
        <header><strong>筛选项目</strong><button type="button" className="pl-text-button" onClick={clear}>重置</button></header>
        <label>分类<select aria-label="项目分类" value={category} onChange={event => onCategory(event.target.value)}><option value="all">全部分类</option>{Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>状态<select aria-label="筛选项目状态" value={status} onChange={event => onStatus(event.target.value)}><option value="all">全部状态</option>{Object.entries(projectStatuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <footer><Popover.Close asChild><button className="pl-secondary" type="button">完成</button></Popover.Close></footer>
      </Popover.Content></Popover.Portal></Popover.Root>
      <label className="pl-task-view pl-project-sort"><Icon name="list" size={15}/><select aria-label="项目排序" value={sort} onChange={event => onSort(event.target.value as ProjectSort)}><option value="created">最近创建</option><option value="updated">最近更新</option><option value="name">项目名称</option><option value="progress">完成进度</option></select></label>
      <label className="pl-task-view"><Icon name={view === 'list' ? 'list' : 'grid'} size={15}/><select aria-label="项目视图" value={view} onChange={event => onView(event.target.value as 'list' | 'grid')}><option value="list">表格</option><option value="grid">卡片</option></select></label>
      <button type="button" className="pl-task-tool-button pl-project-new" onClick={onNew}><Icon name="plus" size={16}/>新建项目</button>
    </div>
    {count > 0 && <div className="pl-task-filter-chips" aria-label="已应用筛选">
      {category !== 'all' && <button onClick={() => onCategory('all')}>{categories[category as keyof typeof categories]}<Icon name="close" size={11}/></button>}
      {status !== 'all' && <button onClick={() => onStatus('all')}>{projectStatuses[status as keyof typeof projectStatuses]}<Icon name="close" size={11}/></button>}
      {scope === 'completed' && <button onClick={() => onScope('all')}>已完成<Icon name="close" size={11}/></button>}
      <button className="pl-clear-filters" onClick={clear}>清除筛选</button>
    </div>}
  </>;
}
