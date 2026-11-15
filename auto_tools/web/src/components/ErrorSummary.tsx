import { useMemo, useState } from 'react';
import { summarizeError } from '../error-summary';

export function ErrorSummary({ message }: { message: string }) {
  const { summary, count, expandable } = useMemo(() => summarizeError(message), [message]);
  const [expanded, setExpanded] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState('');

  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
      setCopyFeedback('已复制');
    } catch {
      setCopyFeedback('复制失败，请选中下方文字复制');
    }
  }

  return <div className="error-summary" onClick={(event) => event.stopPropagation()}>
    <p className="error-summary-text">{summary || message}</p>
    {expandable && <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>查看完整报错{count > 1 ? `（${count} 条）` : ''}</summary>
      {expanded && <div className="error-summary-detail">
        <button type="button" className="ghost" onClick={() => void copy()}>复制完整报错</button>
        {copyFeedback && <small role="status">{copyFeedback}</small>}
        <pre tabIndex={0} aria-label="完整报错">{message}</pre>
      </div>}
    </details>}
  </div>;
}
