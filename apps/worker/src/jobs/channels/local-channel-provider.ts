import { createHash } from "node:crypto";

import type { ChannelProvider, ProviderDelivery } from "./channel-delivery-worker";

export class SyntheticLocalChannelProvider implements ChannelProvider {
  async send(delivery: ProviderDelivery): Promise<{ providerMessageId: string }> {
    const providerMessageId = createHash("sha256")
      .update(`${delivery.channel}:${delivery.destinationId}:${delivery.idempotencyKey}`)
      .digest("hex")
      .slice(0, 32);
    return { providerMessageId: `synthetic-local:${providerMessageId}` };
  }
}
