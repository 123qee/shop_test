import { createContext, useCallback, useContext, useRef, useState, type FormEvent, type ReactNode } from 'react';

type DialogRequest =
  | { kind: 'confirm'; message: string; resolve: (value: boolean) => void }
  | { kind: 'input'; message: string; value: string; resolve: (value: string | null) => void };

type NativePromptApi = {
  confirm: (message: string) => Promise<boolean>;
  prompt: (message: string, defaultValue?: string) => Promise<string | null>;
};

const NativePromptContext = createContext<NativePromptApi | null>(null);

export function useNativePrompt() {
  const value = useContext(NativePromptContext);
  if (!value) throw new Error('useNativePrompt must be used inside NativePromptProvider');
  return value;
}

export function NativePromptProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const requestRef = useRef<DialogRequest | null>(null);

  const confirm = useCallback((message: string) =>
    new Promise<boolean>((resolve) => {
      const next: DialogRequest = { kind: 'confirm', message, resolve };
      const current = requestRef.current;
      if (current?.kind === 'confirm') current.resolve(false);
      else if (current) current.resolve(null);
      requestRef.current = next;
      setRequest(next);
    }), []);

  const prompt = useCallback((message: string, defaultValue = '') =>
    new Promise<string | null>((resolve) => {
      const next: DialogRequest = { kind: 'input', message, value: defaultValue, resolve };
      const current = requestRef.current;
      if (current?.kind === 'confirm') current.resolve(false);
      else if (current) current.resolve(null);
      requestRef.current = next;
      setRequest(next);
    }), []);

  function settle(value: boolean | string | null) {
    const current = requestRef.current;
    if (!current) return;
    requestRef.current = null;
    setRequest(null);
    if (current.kind === 'confirm') current.resolve(value === true);
    else current.resolve(typeof value === 'string' ? value : null);
  }

  function submitInput(event: FormEvent) {
    event.preventDefault();
    if (request?.kind === 'input') settle(request.value);
  }

  return (
    <NativePromptContext.Provider value={{ confirm, prompt }}>
      {children}
      {request && (
        <div className="native-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) settle(request.kind === 'confirm' ? false : null); }}>
          <section className="native-dialog" role="dialog" aria-modal="true" aria-labelledby="native-dialog-title" onKeyDown={(event) => { if (event.key === 'Escape') settle(request.kind === 'confirm' ? false : null); }}>
            <header className="native-dialog-head">
              <span className="native-dialog-mark" aria-hidden="true">{request.kind === 'confirm' ? '?' : '✎'}</span>
              <div><h2 id="native-dialog-title">{request.kind === 'confirm' ? '请确认操作' : '填写名称'}</h2><p>{request.message}</p></div>
              <button type="button" className="native-dialog-close" aria-label="关闭" onClick={() => settle(request.kind === 'confirm' ? false : null)}>×</button>
            </header>
            {request.kind === 'input' ? (
              <form className="native-dialog-body" onSubmit={submitInput}>
                <input autoFocus value={request.value} onChange={(event) => setRequest({ ...request, value: event.target.value })} />
                <footer className="native-dialog-actions">
                  <button type="button" className="ghost" onClick={() => settle(null)}>取消</button>
                  <button type="submit">确定</button>
                </footer>
              </form>
            ) : (
              <footer className="native-dialog-actions">
                <button type="button" className="ghost" onClick={() => settle(false)}>取消</button>
                <button type="button" onClick={() => settle(true)}>确定</button>
              </footer>
            )}
          </section>
        </div>
      )}
    </NativePromptContext.Provider>
  );
}
