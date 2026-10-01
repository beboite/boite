import { strings } from './strings';
import { familyOf, type ToolPart } from './tool-groups';

/** Select a diagnostic for an already failed call, never infer its status from output text. */
export function toolErrorPreview(part: ToolPart): string {
  if (part.status !== 'error' && part.status !== 'denied') return '';
  const lines = (part.output ?? '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/[\r\n]+/).map(line => line.trim()).filter(Boolean);
  if (familyOf(part) !== 'command' || part.status === 'denied') return lines[0] ?? '';
  // Prefer the failing test or merge conflict to a runner banner or source excerpt.
  return lines.find(line => /^(?:\(fail\)|FAIL\b|CONFLICT\b)/i.test(line))
    ?? lines.find(line => /^(?:(?:fatal|error)(?:\s+[\w-]+)?:|[\w.]+Error:)/i.test(line))
    ?? lines.find(line => /^\d+\s+(?:fail(?:ed)?|errors?)\b/i.test(line) && !/^0\s/.test(line))
    ?? strings.chat.toolCommandFailed;
}
