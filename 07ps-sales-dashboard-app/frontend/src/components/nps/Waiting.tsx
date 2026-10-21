import React from 'react';

/** A visual whose data does not exist yet: the message, never numbers (NPS Score, sections 4 and 5). */
export function Waiting({ message }: { message: string }) {
  return (
    <div className="ps-nps-waiting" data-testid="nps-waiting">
      {message}
    </div>
  );
}
