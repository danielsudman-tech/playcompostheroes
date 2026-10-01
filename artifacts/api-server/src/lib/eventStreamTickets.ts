import { randomBytes } from "node:crypto";

const TICKET_LIFETIME_MS = 60_000;

interface EventStreamTicketGrant {
  eventId: string;
  userToken: string;
  expiresAt: number;
}

const tickets = new Map<string, EventStreamTicketGrant>();

export function issueEventStreamTicket(
  eventId: string,
  userToken: string,
  now = Date.now(),
): string {
  for (const [ticket, grant] of tickets) {
    if (grant.expiresAt <= now) tickets.delete(ticket);
  }
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(ticket, { eventId, userToken, expiresAt: now + TICKET_LIFETIME_MS });
  return ticket;
}

/** Tickets are consumed even when used for the wrong event, preventing retries. */
export function consumeEventStreamTicket(
  ticket: string,
  eventId: string,
  now = Date.now(),
): { userToken: string } | null {
  const grant = tickets.get(ticket);
  if (ticket) tickets.delete(ticket);
  if (!grant || grant.eventId !== eventId || grant.expiresAt <= now) return null;
  return { userToken: grant.userToken };
}

export function revokeEventStreamTickets(eventId: string): number {
  let revoked = 0;
  for (const [ticket, grant] of tickets) {
    if (grant.eventId !== eventId) continue;
    tickets.delete(ticket);
    revoked++;
  }
  return revoked;
}