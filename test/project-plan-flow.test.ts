import { expect, it } from 'vitest';
import { projectPlanAction, projectPlanContext } from '../backend/domains/providers/project-plan-flow.js';
import { scopeProjectPlanTool } from '../backend/domains/providers/project-plan-tools.js';

it('requires a clear stand-alone plan approval or cancellation', () => {
  expect(projectPlanAction('Aprobar')).toBe('approved');
  expect(projectPlanAction('Yes, proceed.')).toBe('approved');
  expect(projectPlanAction('Cancelar plan')).toBe('cancel');
  expect(projectPlanAction('Aprobado, pero cambia primero el alcance')).toBeNull();
  expect(projectPlanAction('Please update the plan')).toBeNull();
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
  expect(projectPlanContext(state, 'review')).toContain('The user has not approved this plan.');
  expect(projectPlanContext(state, 'review')).toContain(state.plan);
  expect(projectPlanContext(state, 'approved')).toContain('The user explicitly approved this plan.');
  expect(projectPlanContext(state, 'draft')).toContain('Do not edit or create files');
});
