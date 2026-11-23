import { useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { useNativePrompt } from '../../components/NativePromptProvider';

export function useUnsavedChanges(dirty: boolean) {
  const blocker = useBlocker(dirty);
  const { confirm } = useNativePrompt();
  const asking = useRef(false);
  useEffect(() => {
    if (blocker.state !== 'blocked' || asking.current) return;
    asking.current = true;
    void confirm('有未保存的修改，确定放弃并离开？').then(leave => {
      asking.current = false;
      if (leave) blocker.proceed(); else blocker.reset();
    });
  }, [blocker, confirm]);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
