import { describe, expect, test } from 'bun:test';
import { apiErrorReason, errorSentence } from '../src/drivers/claude/mapping.ts';

describe('claude API error reasons', () => {
  test('a code the CLI cannot name gives the text it wrote', () => {
    expect(apiErrorReason('unknown', [{ type: 'text', text: 'API Error: upstream stream interrupted' }])).toBe('API Error: upstream stream interrupted');
    expect(apiErrorReason('unknown', 'API Error: upstream stream interrupted\n')).toBe('API Error: upstream stream interrupted');
  });

  test('an error without text falls back to a sentence, never "with unknown"', () => {
    expect(apiErrorReason('unknown', [])).toBe('Claude stopped on an API error and gave no reason.');
    expect(apiErrorReason('unknown', undefined)).toBe('Claude stopped on an API error and gave no reason.');
    expect(apiErrorReason('cloud_credential_error', [{ type: 'text', text: '  ' }])).toBe('Claude stopped on an API error (cloud_credential_error).');
    expect(apiErrorReason('server_error', [])).toBe('Claude returned a server error.');
  });

  test('a known code keeps its sentence and adds the text', () => {
    expect(apiErrorReason('server_error', [{ type: 'text', text: 'API Error: upstream stream interrupted' }])).toBe(
      'Claude returned a server error. API Error: upstream stream interrupted',
    );
    expect(apiErrorReason('rate_limit', [{ type: 'text', text: 'This Claude account has hit its rate limit.' }])).toBe('This Claude account has hit its rate limit.');
    expect(errorSentence('overloaded')).toBe('Claude is overloaded and refused the request.');
  });
});
