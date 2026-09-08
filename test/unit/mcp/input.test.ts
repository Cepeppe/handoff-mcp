/**
 * Shape inference and the input type guards (TECHNICAL-DESIGN §4.7.1, DD-07).
 *
 * The three shapes are the only thing standing between an agent's flat object and the
 * pipeline, so the table below is written as "this input means that call, or it is
 * ambiguous and here is why". Every ambiguous case asserts the code and the catalogue's
 * fix text as well, because that sentence is the whole repair instruction the agent gets.
 */
import { describe, expect, it } from 'vitest';

import { ERROR_TEXTS } from '../../../src/mcp/generated/contract';
import {
  inferShape,
  parseRunbooksQuery,
  parseVerifyInput,
  DETAIL_MAX_LENGTH,
  DETAIL_MIN_LENGTH,
  QUERY_MAX_LENGTH,
  REGISTERED_HANDOFF_ID_PATTERNS,
  REPLY_MAX_LENGTH,
  type CallShape,
} from '../../../src/mcp/input';
import { HANDOFF_ID_RE, newHandoffId } from '../../../src/ids';

const ID = 'hf_7k3m9p2q4r';
const OTHER_ID = 'hf_2b9x4d7fkq';
const SPEC = { spec_version: 1 };

/** The shape, or a failure that names the problem sentence so a test can read it. */
function shapeOf(input: unknown): CallShape {
  const inferred = inferShape(input);
  if (!inferred.ok) {
    throw new Error(`expected a shape, got: ${String(inferred.error.problems[0]?.problem)}`);
  }
  return inferred.shape;
}

/** The single problem of a `SHAPE_AMBIGUOUS`, with the code and fix already asserted. */
function ambiguity(input: unknown): { path: string; problem: string } {
  const inferred = inferShape(input);
  if (inferred.ok) throw new Error('expected SHAPE_AMBIGUOUS');
  expect(inferred.error.code).toBe('SHAPE_AMBIGUOUS');
  expect(inferred.error.message).toBe(ERROR_TEXTS.SHAPE_AMBIGUOUS.message);
  expect(inferred.error.problems).toHaveLength(1);
  const problem = inferred.error.problems[0];
  if (problem === undefined) throw new Error('no problem');
  expect(problem.fix).toBe(ERROR_TEXTS.SHAPE_AMBIGUOUS.fix);
  return { path: problem.path, problem: problem.problem };
}

describe('the id shape the input schema declares', () => {
  it('is the one src/ids.ts generates, on all three fields that carry an id', () => {
    for (const pattern of REGISTERED_HANDOFF_ID_PATTERNS) {
      expect(pattern.source).toBe(HANDOFF_ID_RE.source);
      expect(pattern.test(newHandoffId())).toBe(true);
    }
    expect(REGISTERED_HANDOFF_ID_PATTERNS).toHaveLength(3);
  });
});

describe('the three shapes', () => {
  it('reads an open call, with and without its two optional fields', () => {
    expect(shapeOf({ spec: SPEC })).toEqual({
      kind: 'open',
      spec: SPEC,
      requestId: undefined,
      ignoreRunbook: false,
    });
    expect(shapeOf({ spec: SPEC, request_id: ID, ignore_runbook: true })).toEqual({
      kind: 'open',
      spec: SPEC,
      requestId: ID,
      ignoreRunbook: true,
    });
  });

  it('reads a continue call, with and without replacement steps', () => {
    expect(shapeOf({ handoff_id: ID, reply: 'the button is called Add destination' })).toEqual({
      kind: 'continue',
      handoffId: ID,
      reply: 'the button is called Add destination',
      replacementSteps: undefined,
    });
    const steps = [{ text: 'Start from the error page.' }];
    expect(shapeOf({ handoff_id: ID, reply: 'fixed', replacement_steps: steps })).toEqual({
      kind: 'continue',
      handoffId: ID,
      reply: 'fixed',
      replacementSteps: steps,
    });
  });

  it('reads a resume call', () => {
    expect(shapeOf({ resume: ID })).toEqual({ kind: 'resume', handoffId: ID });
  });

  it('does not confuse the spec with the control fields (TOOL-02)', () => {
    // A spec carrying `handoff_id` inside it is S2's business, not this module's: the
    // call is still a well-formed open, and validateSpec is what refuses the spec.
    expect(shapeOf({ spec: { ...SPEC, handoff_id: ID } }).kind).toBe('open');
  });
});

describe('what is not exactly one shape', () => {
  it('refuses a call that names none', () => {
    expect(ambiguity({})).toEqual({
      path: '',
      problem: 'The call carries none of spec, reply or resume, so it names no shape.',
    });
    expect(ambiguity({ ignore_runbook: true }).problem).toContain('names no shape');
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['spec and reply', { spec: SPEC, reply: 'x' }, 'The call carries spec and reply'],
    ['spec and resume', { spec: SPEC, resume: ID }, 'The call carries spec and resume'],
    [
      'all three',
      { spec: SPEC, reply: 'x', resume: ID },
      'The call carries spec, reply and resume',
    ],
  ])('refuses %s', (_name, input, expected) => {
    const { path, problem } = ambiguity(input);
    expect(path).toBe('');
    expect(problem).toBe(`${expected}, so it names more than one shape.`);
  });

  it('refuses a field borrowed from another shape', () => {
    expect(ambiguity({ spec: SPEC, handoff_id: ID }).problem).toBe(
      'The open shape does not take handoff_id.',
    );
    expect(ambiguity({ resume: ID, ignore_runbook: true }).problem).toBe(
      'The resume shape does not take ignore_runbook.',
    );
    expect(ambiguity({ resume: ID, ignore_runbook: true, request_id: ID }).problem).toBe(
      'The resume shape does not take ignore_runbook and request_id.',
    );
  });

  it('refuses a field the input schema does not declare', () => {
    expect(ambiguity({ spec: SPEC, handoffId: ID }).problem).toBe(
      'The open shape does not take handoffId.',
    );
  });

  it('refuses a reply without its handoff_id', () => {
    expect(ambiguity({ reply: 'x' })).toEqual({
      path: 'handoff_id',
      problem: 'The continue shape needs handoff_id next to reply.',
    });
  });

  it.each<[string, Record<string, unknown>, string, string]>([
    [
      'a request_id that is not an id',
      { spec: SPEC, request_id: 'hf_nope' },
      'request_id',
      'request_id is not a handoff id.',
    ],
    [
      'an ignore_runbook that is not a boolean',
      { spec: SPEC, ignore_runbook: 'yes' },
      'ignore_runbook',
      'ignore_runbook is not a boolean.',
    ],
    [
      'a handoff_id that is not an id',
      { handoff_id: 'hf_', reply: 'x' },
      'handoff_id',
      'handoff_id is not a handoff id.',
    ],
    ['a resume that is not an id', { resume: 42 }, 'resume', 'resume is not a handoff id.'],
    [
      'replacement_steps that are not an array',
      { handoff_id: ID, reply: 'x', replacement_steps: {} },
      'replacement_steps',
      'replacement_steps is not an array of steps.',
    ],
  ])('refuses %s', (_name, input, path, problem) => {
    expect(ambiguity(input)).toEqual({ path, problem });
  });

  it('refuses a reply outside the bounds the registered schema declares', () => {
    const bounds = `reply is not a string of 1 to ${String(REPLY_MAX_LENGTH)} characters.`;
    expect(ambiguity({ handoff_id: ID, reply: '' })).toEqual({ path: 'reply', problem: bounds });
    expect(ambiguity({ handoff_id: ID, reply: 'x'.repeat(REPLY_MAX_LENGTH + 1) }).problem).toBe(
      bounds,
    );
    expect(shapeOf({ handoff_id: ID, reply: 'x'.repeat(REPLY_MAX_LENGTH) }).kind).toBe('continue');
  });

  it.each<[string, unknown]>([
    ['no arguments at all', undefined],
    ['null', null],
    ['an array', [{ resume: OTHER_ID }]],
    ['a string', 'resume'],
  ])('refuses %s', (_name, input) => {
    expect(ambiguity(input).problem).toBe('The tool arguments are not a JSON object.');
  });

  it('treats an explicit null as a shape that was meant and got wrong', () => {
    // `{"resume": null}` names the resume shape and fails on the id, rather than being
    // read as an empty object that names no shape at all.
    expect(ambiguity({ resume: null })).toEqual({
      path: 'resume',
      problem: 'resume is not a handoff id.',
    });
    // An explicit `undefined` is the JSON-less way of saying "absent", and is treated so.
    expect(shapeOf({ spec: SPEC, request_id: undefined })).toEqual({
      kind: 'open',
      spec: SPEC,
      requestId: undefined,
      ignoreRunbook: false,
    });
  });
});

describe('the handoff_runbooks query', () => {
  it('reads the two required inputs and the optional language', () => {
    expect(parseRunbooksQuery({ where: 'Stripe', goal: 'webhook' })).toEqual({
      ok: true,
      query: { where: 'Stripe', goal: 'webhook' },
    });
    expect(parseRunbooksQuery({ where: 'Stripe', goal: 'webhook', lang: 'it' })).toEqual({
      ok: true,
      query: { where: 'Stripe', goal: 'webhook', lang: 'it' },
    });
  });

  it.each<[string, unknown, string]>([
    [
      'a missing where',
      { goal: 'x' },
      `where must be a string of 1 to ${String(QUERY_MAX_LENGTH)} characters`,
    ],
    [
      'both missing',
      {},
      `where and goal must be a string of 1 to ${String(QUERY_MAX_LENGTH)} characters`,
    ],
    [
      'an empty goal',
      { where: 'x', goal: '' },
      `goal must be a string of 1 to ${String(QUERY_MAX_LENGTH)} characters`,
    ],
    [
      'a lang that is not a tag',
      { where: 'x', goal: 'y', lang: 'Italiano' },
      'lang is not a BCP-47 language tag',
    ],
    [
      'a field it does not have',
      { where: 'x', goal: 'y', limit: 3 },
      'handoff_runbooks has no field limit',
    ],
    ['arguments that are not an object', 'x', 'the arguments are not a JSON object'],
  ])('refuses %s', (_name, input, problem) => {
    expect(parseRunbooksQuery(input)).toEqual({ ok: false, problem });
  });

  it('refuses a where longer than the registered maximum', () => {
    const long = { where: 'x'.repeat(QUERY_MAX_LENGTH + 1), goal: 'y' };
    expect(parseRunbooksQuery(long).ok).toBe(false);
    expect(parseRunbooksQuery({ ...long, where: 'x'.repeat(QUERY_MAX_LENGTH) }).ok).toBe(true);
  });
});

/**
 * `handoff_verify` has one shape (§4.7.2), so arguments that do not fit its registered schema
 * are a protocol violation and not one of the catalogue's errors — the same rule
 * `handoff_runbooks` follows. `NO_VERIFY_IN_SPEC` and `HANDOFF_NOT_FOUND` are answers *about*
 * a handoff and stay in the catalogue; a `verify` that is not an object is about nothing.
 */
describe('parseVerifyInput', () => {
  it('reads the three values of a report', () => {
    expect(parseVerifyInput({ handoff_id: ID, verify: { ok: true, detail: 'it works' } })).toEqual({
      ok: true,
      input: { handoffId: ID, ok: true, detail: 'it works' },
    });
  });

  it.each([true, false, null])('accepts ok = %s, which is the honest answer set', (ok) => {
    const parsed = parseVerifyInput({ handoff_id: ID, verify: { ok, detail: 'what I ran' } });
    expect(parsed).toMatchObject({ ok: true, input: { ok } });
  });

  it.each([
    ['arguments that are not an object', 'x', 'the arguments are not a JSON object'],
    [
      'an id that is not one',
      { handoff_id: 'hf_short', verify: { ok: true, detail: 'x' } },
      'handoff_id is not a handoff id',
    ],
    ['no verify at all', { handoff_id: ID }, 'verify is not an object'],
    [
      'an ok that is not one of the three',
      { handoff_id: ID, verify: { ok: 'yes', detail: 'x' } },
      'verify.ok is not true, false or null',
    ],
    [
      'an empty detail',
      { handoff_id: ID, verify: { ok: true, detail: '' } },
      `verify.detail must be a string of ${String(DETAIL_MIN_LENGTH)} to ${String(DETAIL_MAX_LENGTH)} characters`,
    ],
    [
      'a field the tool does not have',
      { handoff_id: ID, verify: { ok: true, detail: 'x' }, late: true },
      'handoff_verify has no field late',
    ],
    [
      'a field verify does not have',
      { handoff_id: ID, verify: { ok: true, detail: 'x', at: 'now' } },
      'verify has no field at',
    ],
  ])('refuses %s', (_name, input, problem) => {
    expect(parseVerifyInput(input)).toEqual({ ok: false, problem });
  });

  it('holds the detail to the bound the registered schema declares', () => {
    const long = {
      handoff_id: ID,
      verify: { ok: true, detail: 'x'.repeat(DETAIL_MAX_LENGTH + 1) },
    };
    expect(parseVerifyInput(long).ok).toBe(false);
    expect(
      parseVerifyInput({
        handoff_id: ID,
        verify: { ok: true, detail: 'x'.repeat(DETAIL_MAX_LENGTH) },
      }).ok,
    ).toBe(true);
  });

  it('never echoes a detail back, because a detail can quote anything (R-19)', () => {
    const parsed = parseVerifyInput({
      handoff_id: ID,
      verify: { ok: true, detail: 'sk_live_0123456789abcdefgh reached the endpoint' },
      stray: 1,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).not.toContain('sk_live');
  });
});
