/**
 * Whether an image block of a tool result reaches the model (T-081; Appendix B A-07 read for
 * Kilo Code; §4.7.4).
 *
 * The probe's `image_probe` returns one small square of a single colour, drawn at random from
 * six, and records which one it painted; the model is asked to name it. Kilo, like OpenCode,
 * hands the image to whichever model the session runs, so the answer is about the pair: this
 * scenario runs on a free model of the Kilo Gateway that reads images (`KILO_IMAGE_MODEL`), and
 * asserts that the answer agrees with `images_in_results` of the kilo-code row. On the
 * Gateway's free auto-router, which is listed with `attachment: false`, the text of the result
 * still arrives and the model says it sees no image (measured), the harmless direction PRIN-10
 * asks for.
 */
import { check } from '../../classify.ts';
import { firstObservation, type CanaryRun } from '../../runner.ts';
import { wellFormed } from '../../scenarios/scenario.ts';
import { kiloRow, serverRegistered, type KiloScenario } from './scenario.ts';
import { KILO_IMAGE_MODEL } from './workspace.ts';

const PROMPT = [
  'Call the tool image_probe of the MCP server handoff exactly once.',
  'Its result contains an image that is one solid colour.',
  'Reply with only the name of that colour in lower case,',
  'or with NO IMAGE if you cannot see an image.',
].join(' ');

function painted(run: CanaryRun): string | undefined {
  const colour = firstObservation(run, 'image_probe')?.['colour'];
  return typeof colour === 'string' ? colour : undefined;
}

function reply(run: CanaryRun): string {
  return (run.result?.result ?? '').trim().toLowerCase();
}

function namedTheColour(run: CanaryRun): boolean {
  const colour = painted(run);
  return colour !== undefined && reply(run).includes(colour);
}

export const kiloImageScenario: KiloScenario = {
  id: 'kilo-code-image',
  title: 'an image block in a tool result reaches the model as the table says',
  covers: ['A-07'],
  options: { prompt: PROMPT, model: KILO_IMAGE_MODEL },

  check(run) {
    const expected = kiloRow().images_in_results === true;
    return [
      wellFormed(run),
      serverRegistered(run),
      check(
        'model',
        'the agent calls image_probe once, as the prompt asked',
        'model',
        painted(run) !== undefined,
        `tool uses ${JSON.stringify(run.toolUses.map((use) => use.name))}`,
      ),
      check(
        'A-07',
        `the model ${expected ? 'names' : 'cannot name'} the colour, as images_in_results ` +
          `= ${String(expected)} says`,
        'model',
        namedTheColour(run) === expected,
        `painted ${String(painted(run))}, reply "${reply(run).slice(0, 40)}"`,
      ),
    ];
  },

  facts(run) {
    return {
      painted: painted(run) ?? null,
      reply: reply(run).slice(0, 40),
      image_reached_model: namedTheColour(run),
    };
  },
};
