/**
 * The error catalogue (TECHNICAL-DESIGN §4.7.5).
 *
 * The texts live in `schemas/tool-contract.v1.md` and reach the code through the generated
 * contract; this suite checks that every code of the catalogue can be built, that nothing
 * is restated here, and that the wire shape is the one the document describes.
 */
import { describe, expect, it } from 'vitest';

import {
  catalogueError,
  catalogueFix,
  errorJson,
  handoffError,
  toErrorPayload,
} from '../../../src/format';
import { ERROR_CODES, ERROR_TEXTS } from '../../../src/mcp/generated/contract';

describe('catalogueError', () => {
  it.each(ERROR_CODES.filter((code) => code !== 'SPEC_INVALID'))(
    'builds %s from the generated contract',
    (code) => {
      const error = catalogueError(code, 'handoff_id');
      expect(error.code).toBe(code);
      expect(error.message).toBe(ERROR_TEXTS[code].message);
      expect(error.problems).toEqual([
        { path: 'handoff_id', problem: ERROR_TEXTS[code].message, fix: ERROR_TEXTS[code].fix },
      ]);
    },
  );

  it('has no path when the error is about the call rather than a field', () => {
    expect(catalogueError('SHAPE_AMBIGUOUS').problems[0]?.path).toBe('');
  });

  it('refuses SPEC_INVALID, whose fix is written per problem', () => {
    expect(() => catalogueError('SPEC_INVALID')).toThrow('per problem');
    expect(() => catalogueFix('SPEC_INVALID')).toThrow('per problem');
  });
});

describe('the wire shape', () => {
  it('nests the error under a single key', () => {
    const error = handoffError('SPEC_INVALID', [{ path: 'goal', problem: 'p', fix: 'f' }]);
    expect(toErrorPayload(error)).toEqual({
      error: {
        code: 'SPEC_INVALID',
        message: 'The handoff spec is not valid.',
        problems: [{ path: 'goal', problem: 'p', fix: 'f' }],
      },
    });
  });

  it('prints as readable JSON', () => {
    const json = errorJson(catalogueError('HANDOFF_NOT_FOUND', 'handoff_id'));
    expect(JSON.parse(json)).toEqual(
      toErrorPayload(catalogueError('HANDOFF_NOT_FOUND', 'handoff_id')),
    );
    expect(json.split('\n').length).toBeGreaterThan(1);
  });
});
