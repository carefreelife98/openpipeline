import { describe, it, expect } from 'vitest';

import { validateStatePath } from '../src/path-validator.js';

describe('validateStatePath', () => {
  describe('valid paths', () => {
    it('accepts a single identifier segment', () => {
      expect(validateStatePath('outputs')).toEqual({ valid: true });
    });

    it('accepts dotted identifier segments', () => {
      expect(validateStatePath('outputs.nodeA.field')).toEqual({ valid: true });
    });

    it('accepts bracket index segments', () => {
      expect(validateStatePath('outputs[0]')).toEqual({ valid: true });
    });

    it('accepts the dot-bracket variant some UIs emit', () => {
      expect(validateStatePath('outputs.items.[3]')).toEqual({ valid: true });
    });

    it('accepts UUID-with-dashes segments', () => {
      expect(validateStatePath('outputs.a1b2c3d4-e5f6-7890-abcd-ef1234567890.out')).toEqual({
        valid: true,
      });
    });
  });

  describe('length guard', () => {
    it('rejects an empty path', () => {
      expect(validateStatePath('')).toEqual({ valid: false, error: 'INVALID_LENGTH' });
    });

    it('rejects a path longer than 256 chars', () => {
      const long = 'outputs.' + 'a'.repeat(260);
      expect(validateStatePath(long)).toEqual({ valid: false, error: 'INVALID_LENGTH' });
    });
  });

  describe('grammar guard', () => {
    it('rejects a leading-digit first segment', () => {
      expect(validateStatePath('0outputs.field')).toEqual({
        valid: false,
        error: 'INVALID_GRAMMAR',
      });
    });

    it('rejects a leading dot', () => {
      expect(validateStatePath('.outputs')).toEqual({ valid: false, error: 'INVALID_GRAMMAR' });
    });

    it('rejects spaces', () => {
      expect(validateStatePath('outputs .field')).toEqual({
        valid: false,
        error: 'INVALID_GRAMMAR',
      });
    });

    it('rejects an unclosed bracket', () => {
      expect(validateStatePath('outputs[0')).toEqual({ valid: false, error: 'INVALID_GRAMMAR' });
    });
  });

  describe('depth guard', () => {
    it('accepts exactly 16 segments', () => {
      const path = Array.from({ length: 16 }, (_, i) => (i === 0 ? 'a' : `s${String(i)}`)).join(
        '.'
      );
      expect(validateStatePath(path)).toEqual({ valid: true });
    });

    it('rejects 17 segments', () => {
      const path = Array.from({ length: 17 }, (_, i) => (i === 0 ? 'a' : `s${String(i)}`)).join(
        '.'
      );
      expect(validateStatePath(path)).toEqual({ valid: false, error: 'INVALID_DEPTH' });
    });
  });

  describe('prototype-pollution guard', () => {
    it('rejects __proto__ anywhere in the path', () => {
      expect(validateStatePath('outputs.__proto__.polluted')).toEqual({
        valid: false,
        error: 'FORBIDDEN_SEGMENT:__proto__',
      });
    });

    it('rejects constructor', () => {
      expect(validateStatePath('outputs.constructor')).toEqual({
        valid: false,
        error: 'FORBIDDEN_SEGMENT:constructor',
      });
    });

    it('rejects prototype', () => {
      expect(validateStatePath('outputs.prototype.x')).toEqual({
        valid: false,
        error: 'FORBIDDEN_SEGMENT:prototype',
      });
    });
  });
});
