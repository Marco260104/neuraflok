import { expect, it } from 'vitest';
import {
  hasEmptyProjectPlanDecisionArguments,
  projectPlanContext,
  projectPlanDecisionFromTool,
  projectPlanRevisionFromTool
} from '../backend/domains/providers/project-plan-flow.js';
import { scopeProjectPlanTool } from '../backend/domains/providers/project-plan-tools.js';

it('uses model workflow signals instead of matching approval phrases', () => {
  expect(projectPlanDecisionFromTool('approve_project_plan')).toBe('approved');
  expect(projectPlanDecisionFromTool('cancel_project_plan')).toBe('cancel');
  expect(projectPlanDecisionFromTool('revise_project_plan')).toBe('revise');
  expect(projectPlanDecisionFromTool('apply_patch')).toBeNull();
  expect(hasEmptyProjectPlanDecisionArguments('{}')).toBe(true);
  expect(hasEmptyProjectPlanDecisionArguments('{"approved":true}')).toBe(false);
  expect(hasEmptyProjectPlanDecisionArguments('not json')).toBe(false);
  expect(projectPlanRevisionFromTool('{"plan":"Revised plan"}')).toBe('Revised plan');
  expect(projectPlanRevisionFromTool('{"plan":""}')).toBeNull();
  expect(projectPlanRevisionFromTool('{"plan":"Revised plan","other":true}')).toBeNull();
  const review = projectPlanContext({ request: 'Update the route.', plan: 'Read route files, edit, verify.' }, 'review');
  expect(review).toContain('Judge the latest user-authored message by its meaning');
  expect(review).toContain('call approve_project_plan by itself');
  expect(review).toContain('Questions and uncertainty are not approval');
  expect(review).not.toContain('Sí, hazlo');
  expect(review).not.toContain('Aprobar');
});

it('keeps plan reads inside the selected project and scopes unqualified searches there', () => {
  expect(scopeProjectPlanTool('read', { paths: ['/work/shop/src/index.ts'] }, '/work/shop')).toEqual({
    ok: true, args: { paths: ['/work/shop/src/index.ts'] }
  });
  expect(scopeProjectPlanTool('read', { paths: ['/work/shop/../secrets.txt'] }, '/work/shop')).toEqual({ ok: false });
  expect(scopeProjectPlanTool('read', { paths: ['C:/private/secrets.txt'] }, '/work/shop')).toEqual({ ok: false });
  expect(scopeProjectPlanTool('find', { query: 'route' }, '/work/shop')).toEqual({
    ok: true, args: { query: 'route', path: '/work/shop' }
  });
  expect(scopeProjectPlanTool('find', { query: 'route', path: '/work/shopper' }, '/work/shop')).toEqual({ ok: false });
  expect(scopeProjectPlanTool('exec_command', { cmd: 'dir' }, '/work/shop')).toEqual({ ok: false });
});

it('keeps prior approved work visible while distinguishing a new plan from review and approval', () => {
  const state = { request: 'Update the route.', plan: 'Read route files, edit the handler, then verify.' };
  expect(projectPlanContext(state, 'review')).toContain('latest user-authored message');
  expect(projectPlanContext(state, 'review')).toContain('not the app-wide access setting');
  expect(projectPlanContext(state, 'review')).toContain('revise_project_plan');
  expect(projectPlanContext(state, 'review')).toContain(state.plan);
  expect(projectPlanContext(state, 'approved')).toContain('The user explicitly approved this plan.');
  expect(projectPlanContext(state, 'approved')).toContain('The earlier planning gate is cleared');
  expect(projectPlanContext(state, 'draft')).toContain('Do not edit or create files');
});
