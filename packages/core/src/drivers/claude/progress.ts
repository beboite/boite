import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TurnContext } from '../types.ts';

/** Sidechain text stays private; the SDK's bounded task summaries are progress metadata. */
export function claudeProgress(ctx: TurnContext, message: SDKMessage): void {
  if (message.type === 'tool_progress') {
    ctx.reportProgress?.(message.subagent_retry ? 'retrying' : 'tool', message.tool_name);
    return;
  }
  if (message.type !== 'system') return;
  switch (message.subtype) {
    case 'status':
      ctx.reportProgress?.(message.status === 'compacting' ? 'compacting' : 'working');
      break;
    case 'thinking_tokens':
      ctx.reportProgress?.('thinking');
      break;
    case 'api_retry':
      ctx.log('warn', `claude: API retry ${message.attempt}/${message.max_retries} in ${message.retry_delay_ms} ms: ${message.error}`);
      ctx.reportProgress?.('retrying', `${message.attempt}/${message.max_retries}`);
      break;
    case 'task_progress':
      ctx.reportProgress?.('tool', message.summary ?? message.last_tool_name ?? message.description);
      break;
  }
}
