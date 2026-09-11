/**
 * Socket path and named-pipe name, token file, process ancestor chain.
 *
 * TECHNICAL-DESIGN §5.8.
 */

export {
  ANCESTOR_TIMEOUT_MS,
  MAX_ANCESTOR_DEPTH,
  POWERSHELL_ARGS,
  POWERSHELL_COMMAND,
  PS_ARGS,
  PS_COMMAND,
  WINDOWS_ANCESTOR_TIMEOUT_MS,
  ancestorChain,
  parseProcStatus,
  parseProcessTable,
  resolveProcessIdentity,
} from './ancestors';
export type {
  AncestorOptions,
  CommandRunner,
  ProcessAncestor,
  ProcessIdentity,
  ProcessTableEntry,
} from './ancestors';
export {
  PIPE_PREFIX,
  PIPE_SUFFIX_LENGTH,
  RUNBOOKS_FOLDER_NAME,
  SOCKET_FILE_NAME,
  SOCKET_POINTER_FILE_NAME,
  SUN_PATH_MAX_BYTES,
  TOKEN_FILE_NAME,
  endpointTarget,
  exceedsSunPath,
  homeDir,
  pipeName,
  pipeSuffix,
  resolveEndpoint,
  runbooksDir,
  socketPath,
  socketPointerPath,
  tokenPath,
} from './paths';
export type { Endpoint, EndpointOptions } from './paths';
export { TOKEN_MODE, TOKEN_PATTERN, TokenFile } from './token';
export type { TokenFileOptions, TokenProblem, TokenRead, WarnSink } from './token';
