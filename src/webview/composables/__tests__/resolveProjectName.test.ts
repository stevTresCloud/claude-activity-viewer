/* ================================================================
 * resolveProjectName.test.ts — Tests del resolver de projectId→name.
 *
 * Repro del bug visible en smoke E2E: al hacer click en un proyecto
 * solo-disco del dropdown (sin agentes vivos), la vista quedaba
 * vacía porque el computed `projectName` solo buscaba en
 * `store.projects` y caía a null.
 * ================================================================ */

import { describe, expect, it } from 'vitest';
import { resolveProjectName } from '../resolveProjectName';

const STORE_PROJECTS = [
  { id: 'p-claude-orchestrator', name: 'claude-orchestrator' },
  { id: 'p-hello-world-ext', name: 'hello-world-ext' },
];

describe('resolveProjectName', () => {
  it('returns null for empty/null selectedId (vista All projects)', () => {
    expect(resolveProjectName(null, STORE_PROJECTS)).toBe(null);
    expect(resolveProjectName('', STORE_PROJECTS)).toBe(null);
  });

  it('returns store name when id matches a project with live agents', () => {
    expect(resolveProjectName('p-claude-orchestrator', STORE_PROJECTS)).toBe(
      'claude-orchestrator',
    );
  });

  it('falls back to p-<name> prefix when id is not in store (proyecto solo-disco)', () => {
    // El proyecto NO está en store.projects pero sí en el dropdown
    // (porque el scanner lo descubrió en disco). Sin el fallback,
    // SingleProjectView quedaría vacía — el bug que vimos en smoke.
    expect(resolveProjectName('p-ecuadorian-hr18', STORE_PROJECTS)).toBe(
      'ecuadorian-hr18',
    );
  });

  it('preserves project names with dashes', () => {
    // Convención: id = 'p-' + name. Los proyectos con guiones (muy
    // comunes en repos) deben round-trip-ear bien.
    expect(resolveProjectName('p-my-cool-proj', STORE_PROJECTS)).toBe(
      'my-cool-proj',
    );
  });

  it('returns null for malformed id without p- prefix', () => {
    // Caso degenerado: si llega un id sin el prefijo conocido, no
    // adivinamos — devolver null hace que la vista muestre estado
    // vacío en lugar de un proyecto fantasma.
    expect(resolveProjectName('weird-id', STORE_PROJECTS)).toBe(null);
  });

  it('prefers store match over prefix fallback (no name collision)', () => {
    // Sanity: si por alguna razón el id está en el store, el
    // fallback no debería pisarlo (importante si en algún momento
    // se cambia el formato del id sin migrar el prefix).
    const projects = [{ id: 'p-foo', name: 'Real Foo Name' }];
    expect(resolveProjectName('p-foo', projects)).toBe('Real Foo Name');
  });
});
