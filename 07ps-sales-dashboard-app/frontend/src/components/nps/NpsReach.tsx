import React from 'react';
import { ChartPanel } from '@07ps/ui';
import type { NpsScope } from '../../lib/api';
import { Waiting } from './Waiting';

/**
 * WhatsApp message reach (row 3: Total Reach · Delivered · Not Delivered · Read · Error) and Errors by reason (row 5),
 * from the NPS developer's table whatsapp_outbound_messages. The table does not exist yet: both show
 * "Waiting for the WhatsApp message data", with no numbers.
 */
export function NpsReach({ part }: {
  token: string | null;
  authError: string | null;
  retryAuth: () => void;
  scope: NpsScope;
  enabled: boolean;
  part: 'boxes' | 'errors';
}) {
  if (part === 'errors') {
    return (
      <ChartPanel title="Errors by reason" infoText="WhatsApp feedback messages that failed, by reason (the developer's WhatsApp Error Reference).">
        <Waiting message="Waiting for the WhatsApp message data" />
      </ChartPanel>
    );
  }
  return (
    <ChartPanel title="Message reach" infoText="The WhatsApp feedback messages sent: Total Reach, Delivered, Not Delivered, Read and Error. Uses the message date.">
      <Waiting message="Waiting for the WhatsApp message data" />
    </ChartPanel>
  );
}
