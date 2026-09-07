/**
 * Certain-secret detector applied at ingress, over the public pattern file.
 *
 * TECHNICAL-DESIGN §4.6, §5.5.
 */

export { CERTAIN_SECRET_KINDS, PATTERNS_VERSION, scanText } from './patterns';
export type { CertainSecretKind, SecretMatch } from './patterns';
