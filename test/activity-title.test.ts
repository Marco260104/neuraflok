import { describe, expect, it } from 'vitest';
import { localizeActivityTitle } from '../frontend/features/chat/activity-title.js';
import { translate } from '../frontend/shared/localization/catalog.js';
import { commandActivityTitle } from '../backend/domains/sessions/history/summary-command-intent.js';
import { locatedTitle } from '../backend/domains/sessions/history/summary-format.js';

const es = (source: string, args: readonly unknown[] = []) => translate('es', source, args);

describe('located activity titles', () => {
  it('names a file in its parent folder', () => {
    expect(locatedTitle('Read', '/workspace/src/a.ts')).toBe('Read a.ts in src');
    expect(locatedTitle('Edited', 'C:\\Users\\example\\app.ts')).toBe('Edited app.ts in example');
  });
});

describe('command activity titles', () => {
  it('never echoes the raw argv', () => {
    expect(commandActivityTitle('npm run verify')).toBe('Ran the verify script');
    expect(commandActivityTitle('npm test')).toBe('Ran tests');
    expect(commandActivityTitle('Get-Process -Name node')).toBe('Listed processes');
    expect(commandActivityTitle('cat src/chat.ts')).toBe('Read chat.ts in src');
    expect(commandActivityTitle('Get-ChildItem -Recurse -Filter *.log')).toBe('Listed files');
    expect(commandActivityTitle('rg TODO src/lib')).toBe('Searched lib in src');
    expect(commandActivityTitle('rg TODO backend')).toBe('Searched files');
    expect(commandActivityTitle('git status')).toBe('Checked git status');
    expect(commandActivityTitle('sleep 100')).toBe('Ran a command');
  });
});

describe('localized activity titles', () => {
  it('says which file and folder in Spanish', () => {
    expect(localizeActivityTitle('Read a.ts in src', es)).toBe('Vio a.ts de src');
    expect(localizeActivityTitle('Reading a.ts in src', es)).toBe('Viendo a.ts de src');
    expect(localizeActivityTitle('Edited chat.ts in frontend', es)).toBe('Editó chat.ts de frontend');
    expect(localizeActivityTitle('Listed files in src', es)).toBe('Listó archivos de src');
    expect(localizeActivityTitle('Ran tests', es)).toBe('Ejecutó las pruebas');
    expect(localizeActivityTitle('Ran the verify script', es)).toBe('Ejecutó el script verify');
    expect(localizeActivityTitle('Could not edit a.ts in src', es)).toBe('No pudo editar a.ts de src');
  });

  it('keeps English as the source language', () => {
    const en = (source: string, args: readonly unknown[] = []) => translate('en', source, args);
    expect(localizeActivityTitle('Read a.ts in src', en)).toBe('Read a.ts in src');
    expect(localizeActivityTitle('Ran tests', en)).toBe('Ran tests');
  });
});
