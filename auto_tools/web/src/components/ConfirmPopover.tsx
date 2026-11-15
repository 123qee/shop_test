import { useState, type ReactElement } from 'react';
import * as Popover from '@radix-ui/react-popover';

type ConfirmPopoverProps = {
  children: ReactElement;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  disabled?: boolean;
  onConfirm: () => Promise<void> | void;
};

export function ConfirmPopover({
  children,
  title,
  description,
  confirmText = '确认删除',
  cancelText = '取消',
  disabled = false,
  onConfirm,
}: ConfirmPopoverProps) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function confirm() {
    setConfirming(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={(next) => !confirming && setOpen(next)}>
      <Popover.Trigger asChild disabled={disabled}>
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="confirm-popover"
          side="left"
          align="center"
          sideOffset={8}
          collisionPadding={12}
          aria-label={title}
        >
          <div className="confirm-popover-content">
            <span className="confirm-popover-icon" aria-hidden="true">!</span>
            <div>
              <strong>{title}</strong>
              {description && <p>{description}</p>}
            </div>
          </div>
          <div className="confirm-popover-actions">
            <Popover.Close asChild>
              <button type="button" className="ghost" disabled={confirming}>{cancelText}</button>
            </Popover.Close>
            <button type="button" className="confirm-popover-danger" onClick={() => void confirm()} disabled={confirming}>
              {confirming ? '删除中…' : confirmText}
            </button>
          </div>
          <Popover.Arrow className="confirm-popover-arrow" width={10} height={5} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
