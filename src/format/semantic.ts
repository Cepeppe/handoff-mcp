/**
 * Semantic rules S1-S6 (TECHNICAL-DESIGN §4.2, §5.4).
 *
 * What the schema cannot express: the version check that runs before it (S1), control
 * fields that belong to the tool input and not to the spec (S2), value keys a step cites
 * without declaring (S3), runbook placeholders left in a text (S4), URL schemes outside the
 * closed list (S5) and strings that are empty once trimmed (S6). S7, the certain-secret
 * scan, is never an error and belongs to the ingress detector (§5.5, T-014).
 *
 * Two of these rules overlap with the schema: a control field is also an unknown field, and
 * a bad scheme also breaks the `url` pattern. The renderer of the ajv errors calls the same
 * builders below, so the agent reads one sentence either way and the pipeline drops the
 * duplicate.
 *
 * The `fix` of each problem is the text the design prints in the S1-S6 table; `problem`
 * names what is wrong at that path. Neither ever carries a spec value: the only fragments
 * echoed are field names, value key names, a placeholder name that looks like a value name,
 * and a URL scheme, all of which the design's own texts require (§4.7.5, R-19).
 */
import { catalogueFix, type HandoffError, type Problem } from './errors';
import { childPath } from './paths';
import {
  ALLOWED_URL_SCHEMES,
  SUPPORTED_SPEC_VERSION,
  URL_PATTERN,
  VALUE_NAME_PATTERN,
} from './schema';

/**
 * The control fields of `handoff_to_user` (TOOL-02): they live in the tool input, around
 * the nested `spec`, never inside it. A unit test checks this list against the input schema
 * of the generated tool contract.
 */
export const CONTROL_FIELDS: readonly string[] = [
  'handoff_id',
  'resume',
  'request_id',
  'reply',
  'replacement_steps',
  'ignore_runbook',
];

const urlPattern = new RegExp(URL_PATTERN);
const valueNamePattern = new RegExp(VALUE_NAME_PATTERN);

/** A placeholder is `{{` anything `}}`; the shortest match wins so `{{a}}{{b}}` is two. */
const PLACEHOLDER = /\{\{([\s\S]*?)\}\}/g;

/** The scheme of a URL, if it has one at all. */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]{0,31}):/;

/** True for a JSON object; arrays and null are not. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value as a list, or null when it is not one. */
function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

/** S1. A spec from the future gets one clear answer, before the schema sees it. */
export function versionCheck(input: unknown): HandoffError | null {
  const version = isRecord(input) ? input['spec_version'] : undefined;
  if (typeof version !== 'number' || !(version > SUPPORTED_SPEC_VERSION)) return null;
  return {
    code: 'SPEC_VERSION_UNSUPPORTED',
    message: 'This server does not support that spec_version.',
    problems: [
      {
        path: 'spec_version',
        problem: `This server supports spec_version ≤ ${String(SUPPORTED_SPEC_VERSION)}.`,
        fix: catalogueFix('SPEC_VERSION_UNSUPPORTED'),
      },
    ],
  };
}

/** S2. */
export function controlFieldProblem(field: string): Problem {
  return {
    path: field,
    problem: `\`${field}\` is a control field of the tool input, not a field of the spec.`,
    fix: 'Control fields belong outside `spec`, at the top level of the tool input.',
  };
}

/** S3. `container` is the display path of the list the key was cited in. */
export function unknownValueKeyProblem(
  path: string,
  key: string,
  container: string,
  knownKeys: readonly string[],
): Problem {
  const known = knownKeys.length === 0 ? '(none)' : knownKeys.join(', ');
  return {
    path,
    problem: `\`${key}\` is not a key of values.`,
    fix: `Unknown value key \`${key}\` in ${container}; declare it in \`values\` or remove it. Known keys: ${known}.`,
  };
}

/** S4. The placeholder name is echoed only when it looks like a value name. */
export function placeholderProblem(path: string, name: string): Problem {
  const shown = valueNamePattern.test(name) ? `{{${name}}}` : '{{…}}';
  return {
    path,
    problem: 'A runbook placeholder was never replaced.',
    fix: `Placeholder \`${shown}\` found in ${path}. Placeholders exist only in runbooks; replace it with the real value or move it to \`values\`.`,
  };
}

/** S5. */
export function urlSchemeProblem(path: string, url: string): Problem {
  const scheme = SCHEME.exec(url)?.[1];
  const allowed = `Allowed: ${ALLOWED_URL_SCHEMES.join(', ')}. Show other links as plain text in the step.`;
  return {
    path,
    problem:
      scheme === undefined
        ? `\`${path}\` has no scheme.`
        : `\`${path}\` uses a scheme outside the closed list.`,
    fix:
      scheme === undefined
        ? `No scheme found. ${allowed}`
        : `Scheme \`${scheme}\` is not allowed. ${allowed}`,
  };
}

/** S6. */
export function emptyFieldProblem(path: string): Problem {
  return {
    path,
    problem: `\`${path}\` is empty after trimming.`,
    fix: `Field ${path} is empty.`,
  };
}

/** S6 on one string. */
function emptyProblems(path: string, text: string): Problem[] {
  return text.trim() === '' ? [emptyFieldProblem(path)] : [];
}

/** S4 on one string. */
function placeholderProblems(path: string, text: string): Problem[] {
  const problems: Problem[] = [];
  for (const match of text.matchAll(PLACEHOLDER))
    problems.push(placeholderProblem(path, match[1] ?? ''));
  return problems;
}

/** S5 on one string, skipped when the schema pattern is satisfied. */
function urlProblems(path: string, url: string): Problem[] {
  return urlPattern.test(url) ? [] : [urlSchemeProblem(path, url)];
}

/** S4 and S6, the pair every free text of a spec gets. */
function textProblems(path: string, text: string): Problem[] {
  return [...placeholderProblems(path, text), ...emptyProblems(path, text)];
}

/**
 * S3-S6 over a list of steps, reported under `root`.
 *
 * `root` is `steps` for a spec and `replacement_steps` for the steps of a continue call, so
 * the path an agent reads is the path it sent.
 */
export function stepProblems(
  steps: unknown,
  knownValueKeys: readonly string[],
  root: string,
): Problem[] {
  const list = asArray(steps);
  if (list === null) return [];
  const problems: Problem[] = [];
  list.forEach((step, index) => {
    // A step that is not an object is reported by the schema (SPEC-03); there is nothing
    // here to walk.
    if (!isRecord(step)) return;
    const at = childPath(root, index);

    const text = step['text'];
    if (typeof text === 'string') problems.push(...textProblems(childPath(at, 'text'), text));

    const url = step['url'];
    if (typeof url === 'string') {
      const path = childPath(at, 'url');
      problems.push(...urlProblems(path, url), ...emptyProblems(path, url));
    }

    const cited = asArray(step['values']);
    const container = childPath(at, 'values');
    if (cited !== null) {
      cited.forEach((key, position) => {
        if (typeof key !== 'string' || knownValueKeys.includes(key)) return;
        problems.push(
          unknownValueKeyProblem(childPath(container, position), key, container, knownValueKeys),
        );
      });
    }

    const warning = step['warning'];
    if (typeof warning === 'string') {
      problems.push(...textProblems(childPath(at, 'warning'), warning));
    }
  });
  return problems;
}

/**
 * S2-S6 over a whole spec, in the field order of the schema, so that the problems read
 * down the document.
 *
 * The spec may be anything an agent sent: every field is inspected before it is used, and
 * whatever is structurally wrong has already been reported by the schema.
 */
export function semanticProblems(spec: Record<string, unknown>): Problem[] {
  const problems: Problem[] = [];

  for (const field of CONTROL_FIELDS) {
    if (field in spec) problems.push(controlFieldProblem(field));
  }

  for (const field of ['goal', 'where']) {
    const value = spec[field];
    if (typeof value === 'string') problems.push(...textProblems(field, value));
  }

  const url = spec['url'];
  if (typeof url === 'string')
    problems.push(...urlProblems('url', url), ...emptyProblems('url', url));

  const whyHuman = spec['why_human'];
  if (typeof whyHuman === 'string') problems.push(...textProblems('why_human', whyHuman));

  const values = spec['values'];
  const knownValueKeys = isRecord(values) ? Object.keys(values) : [];
  if (isRecord(values)) {
    for (const [key, value] of Object.entries(values)) {
      const path = childPath('values', key);
      if (typeof value === 'string') {
        problems.push(...textProblems(path, value));
        continue;
      }
      const items = asArray(value);
      if (items === null) continue;
      items.forEach((item, index) => {
        if (typeof item === 'string') problems.push(...textProblems(childPath(path, index), item));
      });
    }
  }

  const secrets = spec['secrets'];
  if (isRecord(secrets)) {
    for (const [name, destination] of Object.entries(secrets)) {
      if (typeof destination === 'string') {
        problems.push(...emptyProblems(childPath('secrets', name), destination));
      }
    }
  }

  problems.push(...stepProblems(spec['steps'], knownValueKeys, 'steps'));

  const verify = spec['verify'];
  if (typeof verify === 'string') problems.push(...textProblems('verify', verify));

  const lang = spec['lang'];
  if (typeof lang === 'string') problems.push(...emptyProblems('lang', lang));

  return problems;
}
