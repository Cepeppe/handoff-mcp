/**
 * The server's view of the channel to the app (TECHNICAL-DESIGN §5.2 step 4, §5.8, §6).
 *
 * The tool pipeline needs one fact about the channel and nothing else: whether the app is
 * reachable right now. That fact decides the whole degraded half of the design — an open
 * without a channel is `text_mode` (§5.9, SRV-14), a continue or a resume without one is
 * `APP_DISCONNECTED` — so it is worth a port of its own rather than an import of the
 * client, which does not exist yet.
 *
 * `NullChannel` is the only implementation today and it is never connected, which is how
 * this task keeps the channel absent **by construction**: there is no code path here that
 * could accidentally reach the app. T-018 builds the real client and T-020 plugs it in
 * behind this interface, widening it with what the blocking calls need.
 */

export interface ChannelPort {
  /** Whether the channel to the app is registered and usable right now (§5.3). */
  isConnected(): boolean;
}

/** The channel that is never there. Every call takes the degraded path of §5.2 step 4. */
export const NullChannel: ChannelPort = {
  isConnected: () => false,
};
