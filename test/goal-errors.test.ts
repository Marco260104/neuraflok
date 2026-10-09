import { describe, expect, it } from 'vitest';
import { goalErrorKey, goalErrorMessage } from '../contracts/goal-errors.js';
import de from '../frontend/locales/de.json';
import es from '../frontend/locales/es.json';
import ko from '../frontend/locales/ko.json';
import zhCN from '../frontend/locales/zh-CN.json';
import zhTW from '../frontend/locales/zh-TW.json';
import ja from '../frontend/locales/ja.json';
import tr from '../frontend/locales/tr.json';
import fr from '../frontend/locales/fr.json';
import ptBR from '../frontend/locales/pt-BR.json';
import ptPT from '../frontend/locales/pt-PT.json';

describe('Goal failure explanations', () => {
  it('explains missing local tool evidence without disabling Loop', () => {
    const message = goalErrorMessage('loop_mcp_call_missing');
    expect(message).toContain('The selected provider may be waiting for input');
    expect(message).toContain('the connection may have been lost');
    expect(message).toContain('Check the provider page');
    expect(message).toContain('Loop remains enabled');
    expect(message).not.toMatch(/ChatGPT|tunnel/i);
    expect(goalErrorMessage('goal_reply_not_pending')).not.toContain('No local tool call');
  });

  it('distinguishes oversized input from oversized helper output, including wrapped failures', () => {
    expect(goalErrorMessage('request_failed: goal_context_too_large')).toContain('Shorten the task');
    expect(goalErrorMessage('reply_too_long')).toContain('helper wrote a continuation');
    expect(goalErrorMessage('stream_record_too_long')).not.toContain('Shorten the task');
    expect(goalErrorMessage('request_failed: fetch failed')).not.toContain('too long');
  });

  it('retains native delivery and recognized protocol causes through bounded request wrappers', () => {
    expect(goalErrorMessage('request_failed: goal_browser_send_failed: Temporary Chat was not confirmed.'))
      .toBe('The helper prompt could not be delivered. Temporary Chat was not confirmed.');
    expect(goalErrorMessage('request_failed: request_failed: invalid_goal_decision_json')).toContain('unusable continuation');
    expect(goalErrorMessage('request_failed: stream_record_too_long')).toContain('oversized response');
    expect(goalErrorMessage('request_failed: goal_browser_send_failed: ' + 'x'.repeat(400)))
      .toBe('The helper prompt could not be delivered. ' + 'x'.repeat(200));
    const generic = goalErrorMessage('request_failed');
    expect(goalErrorMessage('request_failed: unexpected_private_cause')).toBe(generic);
    expect(goalErrorMessage('request_failed: fetch failed')).toBe(generic);
    expect(goalErrorMessage('request_failed: '.repeat(10) + 'no_api_key')).toBe(generic);
  });

  it('explains known provider failures without echoing arbitrary provider diagnostics', () => {
    expect(goalErrorMessage('auth_rejected: private provider detail')).toContain('Check its API key');
    expect(goalErrorMessage('auth_rejected: private provider detail')).not.toContain('private provider detail');
    expect(goalErrorMessage('rate_limited: limit')).toContain('rate-limiting');
    expect(goalErrorMessage('http_503: upstream unavailable')).toContain('HTTP 503');
    expect(goalErrorMessage('invalid_goal_decision_json')).toContain('Nothing was sent');
  });

  it('keeps uncertain delivery distinct from a safe retry and preserves readable errors', () => {
    expect(goalErrorMessage('goal_browser_send_unconfirmed')).toContain('avoid sending it twice');
    expect(goalErrorMessage('goal_browser_send_failed')).toContain('could not be delivered');
    expect(goalErrorMessage('Enter a task of at most 16000 characters')).toBe('Enter a task of at most 16000 characters');
    expect(goalErrorMessage('future_goal_error')).toContain('Check the app diagnostics');
  });

  it('keeps every fixed Goal explanation localizable in every renderer catalog', () => {
    const catalogs: Record<string, Record<string, string>> = { de, es, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, tr, fr, 'pt-BR': ptBR, 'pt-PT': ptPT };
    const codes = [
      'loop_mcp_call_missing', 'goal_reply_not_pending', 'goal_context_too_large', 'reply_too_long',
      'stream_record_too_long', 'response_body_too_large', 'no_api_key', 'auth_rejected', 'out_of_credit',
      'unknown_model', 'invalid_provider', 'rate_limited', 'timeout_or_cancelled', 'request_failed',
      'goal_browser_busy', 'goal_browser_cancelled', 'goal_browser_send_failed', 'goal_browser_send_unconfirmed',
      'goal_owned_elsewhere', 'goal_final_not_confirmed', 'astra_finish_only', 'goal_disabled', 'goal_worker_chat',
      'conversation_superseded', 'chat_blocked', 'session_not_recorded', 'no_conversation', 'no_objective',
      'nothing_to_open_with', 'loop_stop_refused', 'goal_marker_missing', 'goal_reply_not_durable',
      'goal_ack_not_durable', 'goal_switch_not_durable', 'goal_objective_not_durable',
      'invalid_goal_decision_json', 'provider_completion_error'
    ];
    const fixed = new Set(codes.map(code => goalErrorMessage(code)));
    const parameterized = [
      'The helper prompt could not be delivered. {0}',
      'The continuation provider rejected the request (HTTP {0}). Check its status and the configured model or endpoint.',
      'The continuation could not proceed. Check the app diagnostics for details ({0}).'
    ];
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const source of [...fixed, ...parameterized]) {
        expect(Object.hasOwn(catalog, source), `${locale}: ${source}`).toBe(true);
      }
      expect(catalog[goalErrorMessage('loop_mcp_call_missing')], locale).not.toMatch(/ChatGPT|tunnel/i);
    }
  });

  it('leaves explanations with dynamic detail untranslated rather than dropping the detail', () => {
    expect(goalErrorKey('request_failed: goal_browser_send_failed: Temporary Chat was not confirmed.')).toBeNull();
    expect(goalErrorKey('http_503')).toBeNull();
    expect(goalErrorKey('invalid_goal_decision_json')).toBeNull();
    expect(goalErrorKey('something_unknown')).toBeNull();
  });
});
