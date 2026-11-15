export type FeedbackTone = 'success' | 'info' | 'error';

export interface FeedbackDetail {
  message: string;
  tone: FeedbackTone;
  id: number;
}

export const APP_FEEDBACK_EVENT = 'auto-tools:feedback';

export function showFeedback(message: string, tone: FeedbackTone = 'success') {
  window.dispatchEvent(new CustomEvent<FeedbackDetail>(APP_FEEDBACK_EVENT, {
    detail: { message, tone, id: Date.now() },
  }));
}
